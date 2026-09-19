import axios, { type AxiosRequestConfig } from 'axios';
import {
  createPinnedLookup,
  disposeResponseBody,
  getHeaderValue,
  isRedirectStatus,
  type PublicUrlValidation,
  type PublicUrlValidationOptions
} from '../utils/PublicNetwork.js';
import {
  hasSensitiveCandidateCredentials,
  OutboundSecurityPolicy,
  SensitiveOutboundTargetError,
  type OutboundPurpose
} from '../retrieval/OutboundSecurityPolicy.js';
import { createRetrievalDispatchId } from '../retrieval/dispatchId.js';
import {
  RETRIEVAL_OPERATION_DEADLINE_REASON,
  RETRIEVAL_SCOPE_DEADLINE_REASON
} from '../retrieval/abortDiagnostics.js';
import type { RetrievalDispatchObservation, RetrievalDispatchObserver, RetrievalDispatchSlot, RetrievalFailureKind } from '../retrieval/types.js';
import { globalPublicSourceDispatchScheduler, type PublicSourceDispatchScheduler } from './PublicSourceDispatchScheduler.js';

export interface PublicHttpResponseData<T = unknown> {
  status: number;
  headers?: unknown;
  data: T;
}

export interface PublicHttpRequester {
  request(config: AxiosRequestConfig): Promise<PublicHttpResponseData>;
}

export interface PublicHttpRequestConfig extends AxiosRequestConfig {
  /** Internal observation seam stripped before the underlying adapter. */
  dispatchObserver?: RetrievalDispatchObserver;
  /** Internal operation deadline used only by the source scheduler. */
  deadlineAt?: number;
  /** Optional shared service slot around the actual transport, not source wait. */
  dispatchSlot?: RetrievalDispatchSlot;
  /** Keep a finite stream body inside dispatchSlot before releasing it. */
  consumeStreamBodyWithinDispatchSlot?: boolean;
  /** Required finite body ceiling when stream consumption is slot-owned. */
  maxBodyBytes?: number;
  /** For prefix probes, keep only the bounded prefix instead of rejecting it. */
  truncateStreamBodyAtLimit?: boolean;
  /** Consumer-owned bounded reader executed before dispatchSlot is released; it must dispose/close the input body. */
  streamBodyConsumer?: (body: unknown, signal?: AbortSignal) => Promise<unknown>;
  /** Internal owner takes the source lease until it has consumed the body. */
  holdSourceLease?: boolean;
}

export interface PublicHttpClientOptions extends PublicUrlValidationOptions {
  /** Backward-compatible public-network test seam; sensitive checks remain owned here. */
  validateUrl?: (url: string) => Promise<PublicUrlValidation>;
  securityPolicy?: OutboundSecurityPolicy;
  purpose?: OutboundPurpose;
  client?: PublicHttpRequester;
  maxRedirects?: number;
  sourceScheduler?: PublicSourceDispatchScheduler;
}

export interface PublicHttpResponse<T = unknown> {
  response: PublicHttpResponseData<T>;
  finalUrl: string;
  /** Present only for bounded stream owners that requested lease handoff. */
  release?: () => void;
}

/** HTTP client with public-target validation and manually checked redirects. */
export class PublicHttpClient {
  private readonly client: PublicHttpRequester;
  private readonly maxRedirects: number;
  private readonly securityPolicy: OutboundSecurityPolicy;
  private readonly purpose: OutboundPurpose;
  private readonly sourceScheduler: PublicSourceDispatchScheduler;

  constructor(options: PublicHttpClientOptions = {}) {
    this.client = options.client || axios;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.purpose = options.purpose || 'retrieval';
    this.sourceScheduler = options.sourceScheduler || globalPublicSourceDispatchScheduler;
    this.securityPolicy = options.securityPolicy || new OutboundSecurityPolicy({
      lookup: options.lookup,
      validatePublicUrl: options.validateUrl
    });
  }

  /** Create an internal client sharing transport/security/scheduling state with a new purpose. */
  withPurpose(purpose: OutboundPurpose): PublicHttpClient {
    return new PublicHttpClient({
      purpose,
      client: this.client,
      maxRedirects: this.maxRedirects,
      securityPolicy: this.securityPolicy,
      sourceScheduler: this.sourceScheduler
    });
  }

  async request<T = unknown>(url: string, config: PublicHttpRequestConfig = {}): Promise<PublicHttpResponse<T>> {
    let currentUrl = url;
    let requestHeaders = config.headers;
    const dispatchObserver = config.dispatchObserver;

    for (let redirect = 0; redirect <= this.maxRedirects; redirect++) {
      throwIfAborted(config.signal);
      if ((this.purpose === 'pdf_probe' || this.purpose === 'pdf_download') && hasSensitiveCandidateCredentials(currentUrl)) {
        throw new SensitiveOutboundTargetError();
      }
      const validation = await awaitWithAbort(
        this.securityPolicy.validate(currentUrl, this.purpose),
        config.signal
      );
      throwIfAborted(config.signal);
      const origin = currentUrlOrigin(currentUrl);
      const releaseSource = await this.sourceScheduler.acquire(
        origin,
        config.signal as AbortSignal | undefined,
        config.deadlineAt,
        this.purpose === 'scholar_search' ? 3_000 : 0,
        { deferStart: true }
      );
      let handedOff = false;
      let transportSettled = false;
      let responsePromiseCreated = false;
      let releaseRequested = false;
      const release = () => {
        if (releaseRequested) return;
        releaseRequested = true;
        // A caller can be aborted after lease acquisition but before the
        // dispatch promise is created. There is no late transport to await in
        // that case, so release the scheduler lease immediately.
        if (transportSettled || !responsePromiseCreated) releaseSource();
      };
      let observation: RetrievalDispatchObservation | undefined;
      let responseStatus: number | undefined;
      let bodyConsumptionStarted = false;
      try {
        throwIfAborted(config.signal);
        const safeConfig = stripTransportOverrides(config);
        const dispatch = async (): Promise<PublicHttpResponseData<T>> => {
          throwIfAborted(config.signal);
          releaseSource.markStarted(config.deadlineAt);
          observation = createDispatchObservation(
            'target',
            currentUrl,
            this.purpose,
            redirect,
            config.responseType === 'stream' && config.consumeStreamBodyWithinDispatchSlot !== true
          );
          dispatchObserver?.onDispatch?.(observation);
          const response = await this.client.request({
            ...safeConfig,
            url: currentUrl,
            headers: requestHeaders,
            // Never inherit HTTP(S)/NO_PROXY settings for a validated
            // public-target request; the checked address must be the destination.
            proxy: false,
            maxRedirects: 0,
            validateStatus: () => true,
            // Axios forwards this Node option to the http/https adapter.
            lookup: createPinnedLookup(validation.addresses)
          } as AxiosRequestConfig & { lookup: unknown }) as PublicHttpResponseData<T>;
          responseStatus = toHttpStatus(response.status);
          if (config.consumeStreamBodyWithinDispatchSlot && config.responseType === 'stream') {
            bodyConsumptionStarted = true;
            if (config.streamBodyConsumer) {
              return {
                ...response,
                data: await config.streamBodyConsumer(response.data, config.signal as AbortSignal | undefined)
              } as PublicHttpResponseData<T>;
            }
            if (!Number.isSafeInteger(config.maxBodyBytes) || (config.maxBodyBytes as number) < 0) {
              disposeResponseBody(response.data);
              throw new Error('A finite stream body limit is required for slot-owned responses');
            }
            return {
              ...response,
              data: await readBoundedBodyWithinDispatchSlot(
                response.data,
                config.maxBodyBytes as number,
                config.signal,
                config.truncateStreamBodyAtLimit === true
              )
            } as PublicHttpResponseData<T>;
          }
          return response;
        };
        let responsePromise: Promise<PublicHttpResponseData<T>>;
        try {
          responsePromise = config.dispatchSlot
            ? config.dispatchSlot(dispatch, config.signal as AbortSignal | undefined)
            : dispatch();
          responsePromiseCreated = true;
        } catch (error) {
          transportSettled = true;
          throw error;
        }
        void responsePromise.then(
          () => {
            transportSettled = true;
            if (releaseRequested) releaseSource();
          },
          () => {
            transportSettled = true;
            if (releaseRequested) releaseSource();
          }
        );
        const response = await awaitWithAbort(
          responsePromise,
          config.signal,
          lateResponse => disposeResponseBody(lateResponse.data)
        );

        const cooldown = this.sourceScheduler.observeRetryAfter(
          currentUrlOrigin(currentUrl),
          toHttpStatus(response.status),
          response.headers
        );
        notifyDispatchResponse(dispatchObserver, {
          ...observation!,
          ...(toHttpStatus(response.status) === undefined ? {} : { status: toHttpStatus(response.status) }),
          bodyPending: observation!.bodyPending === true
            && !(isRedirectStatus(response.status) && Boolean(getLocation(response.headers))),
          ...cooldown
        });
        if (config.signal?.aborted) {
          disposeResponseBody(response.data);
          throwIfAborted(config.signal);
        }

        if (isRedirectStatus(response.status)) {
          const location = getLocation(response.headers);
          if (location) {
            disposeResponseBody(response.data);
            if (redirect === this.maxRedirects) {
              throw new Error('Too many public URL redirects');
            }
            const nextUrl = new URL(location, currentUrl).toString();
            if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
              requestHeaders = stripSensitiveRedirectHeaders(requestHeaders);
            }
            currentUrl = nextUrl;
            continue;
          }
        }

        if (config.holdSourceLease) handedOff = true;
        return {
          response,
          finalUrl: currentUrl,
          ...(config.holdSourceLease ? { release } : {})
        };
      } catch (error) {
        if (observation) {
          const failureKind = classifyDispatchFailure(
            error,
            config.signal,
            config.deadlineAt,
            bodyConsumptionStarted
          );
          try {
            dispatchObserver?.onError?.({
              ...observation,
              ...(responseStatus === undefined ? {} : { status: responseStatus }),
              ...(failureKind === undefined ? {} : { failureKind })
            });
          } catch {
            // Diagnostic observers cannot replace the transport failure.
          }
        }
        throw error;
      } finally {
        if (!handedOff) release();
      }
    }

    throw new Error('Too many public URL redirects');
  }
}

function notifyDispatchResponse(
  observer: RetrievalDispatchObserver | undefined,
  observation: RetrievalDispatchObservation
): void {
  try {
    observer?.onResponse?.(observation);
  } catch {
    // Response diagnostics are observational; they must not turn a completed
    // transport into a retrieval failure. Dispatch admission remains strict.
  }
}

function createDispatchObservation(
  role: RetrievalDispatchObservation['role'],
  url: string,
  purpose: OutboundPurpose,
  redirect: number,
  bodyPending: boolean
): RetrievalDispatchObservation {
  let parsed: URL | undefined;
  let origin = 'unknown';
  try {
    parsed = new URL(url);
    origin = parsed.origin;
  } catch {
    // The security policy rejects malformed targets before this boundary.
  }
  return {
    dispatchId: createRetrievalDispatchId(),
    role,
    origin,
    submittedAt: Date.now(),
    resource: classifyDispatchResource(purpose, parsed, redirect),
    bodyPending
  };
}

function classifyDispatchResource(
  purpose: OutboundPurpose,
  url: URL | undefined,
  redirect: number
): RetrievalDispatchObservation['resource'] {
  if (purpose === 'pdf_probe') return 'pdf';
  if (redirect > 0) return 'redirect';
  if (url && (url.hostname === 'doi.org' || url.hostname === 'dx.doi.org')) return 'doi';
  if (purpose === 'scholar_search' && url?.hostname === 'scholar.google.com') {
    return url.pathname === '' || url.pathname === '/' ? 'init' : 'page';
  }
  return 'page';
}

function classifyDispatchFailure(
  error: unknown,
  signal: AxiosRequestConfig['signal'] | undefined,
  deadlineAt: number | undefined,
  bodyConsumptionStarted: boolean
): RetrievalFailureKind | undefined {
  if (signal?.aborted) {
    const reason = (signal as { readonly reason?: unknown }).reason;
    if (reason === RETRIEVAL_SCOPE_DEADLINE_REASON) return 'scope_deadline';
    if (reason === RETRIEVAL_OPERATION_DEADLINE_REASON
      || (deadlineAt !== undefined && Date.now() >= deadlineAt)) return 'operation_deadline';
    return 'cancelled';
  }
  if (isTimeoutError(error)) return bodyConsumptionStarted ? 'response_body' : 'transport_timeout';
  return bodyConsumptionStarted ? 'response_body' : undefined;
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string } | undefined;
  return candidate?.code === 'ECONNABORTED'
    || candidate?.code === 'ETIMEDOUT'
    || candidate?.name === 'TimeoutError';
}

function toHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function currentUrlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'unknown';
  }
}

function getLocation(headers: unknown): string | undefined {
  return getHeaderValue(headers, 'location');
}

function stripSensitiveRedirectHeaders(headers: AxiosRequestConfig['headers']): AxiosRequestConfig['headers'] {
  if (!headers || typeof headers !== 'object') return headers;
  const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|(?:x[-_])?(?:api[-_]?key|access[-_]token|auth|csrf[-_]?token|session|jwt|sso|saml|token|secret))$/i;
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => !sensitive.test(name))
    .map(([name, value]) => [
      name,
      value && typeof value === 'object' && !Array.isArray(value)
        ? stripSensitiveRedirectHeaders(value as AxiosRequestConfig['headers'])
        : value
    ]));
}

function stripTransportOverrides(config: AxiosRequestConfig): AxiosRequestConfig {
  const {
    adapter: _adapter,
    allowAbsoluteUrls: _allowAbsoluteUrls,
    baseURL: _baseURL,
    beforeRedirect: _beforeRedirect,
    httpAgent: _httpAgent,
    httpsAgent: _httpsAgent,
    lookup: _lookup,
    maxRedirects: _maxRedirects,
    proxy: _proxy,
    transport: _transport,
    dispatchObserver: _dispatchObserver,
    deadlineAt: _deadlineAt,
    dispatchSlot: _dispatchSlot,
    consumeStreamBodyWithinDispatchSlot: _consumeStreamBodyWithinDispatchSlot,
    maxBodyBytes: _maxBodyBytes,
    truncateStreamBodyAtLimit: _truncateStreamBodyAtLimit,
    streamBodyConsumer: _streamBodyConsumer,
    holdSourceLease: _holdSourceLease,
    validateStatus: _validateStatus,
    ...safeConfig
  } = config as AxiosRequestConfig & Record<string, unknown>;
  return safeConfig;
}

async function readBoundedBodyWithinDispatchSlot(
  body: unknown,
  maxBytes: number,
  signal?: NonNullable<AxiosRequestConfig['signal']>,
  truncateAtLimit = false
): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') {
    const bytes = Buffer.byteLength(body);
    if (bytes > maxBytes) {
      if (!truncateAtLimit) throw new Error('Response body exceeds the allowed size');
      return boundedStringPrefix(body, maxBytes);
    }
    return Buffer.from(body);
  }
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > maxBytes) {
      const result = Buffer.from(body.subarray(0, maxBytes));
      disposeResponseBody(body);
      if (truncateAtLimit) return result;
      throw new Error('Response body exceeds the allowed size');
    }
    const result = Buffer.from(body);
    disposeResponseBody(body);
    return result;
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) {
      const result = Buffer.from(body.subarray(0, maxBytes));
      disposeResponseBody(body);
      if (truncateAtLimit) return result;
      throw new Error('Response body exceeds the allowed size');
    }
    const result = Buffer.from(body);
    disposeResponseBody(body);
    return result;
  }
  if (!isAsyncIterable(body)) throw new Error('Stream response body is not readable');

  const iterator = body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let total = 0;
  let bodyDisposed = false;
  const disposeBody = () => {
    if (bodyDisposed) return;
    bodyDisposed = true;
    disposeResponseBody(body);
  };
  try {
    while (true) {
      const next = await awaitWithAbort(
        Promise.resolve(iterator.next()),
        signal,
        () => disposeAsyncIterator(iterator)
      );
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : next.value instanceof Uint8Array
          ? Buffer.from(next.value)
          : Buffer.from(String(next.value));
      if (total + chunk.byteLength > maxBytes) {
        if (!truncateAtLimit) throw new Error('Response body exceeds the allowed size');
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = maxBytes;
        disposeBody();
        disposeAsyncIterator(iterator);
        return Buffer.concat(chunks, total);
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= maxBytes && truncateAtLimit) {
        disposeBody();
        disposeAsyncIterator(iterator);
        return Buffer.concat(chunks, total);
      }
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    disposeBody();
    disposeAsyncIterator(iterator);
    throw error;
  } finally {
    disposeBody();
  }
}

function boundedStringPrefix(value: string, maxBytes: number): Buffer {
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return Buffer.from(value.slice(0, end));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function disposeAsyncIterator(iterator: AsyncIterator<unknown>): void {
  try {
    const closing = iterator.return?.();
    if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Disposal is best effort; the original cancellation/size error wins.
  }
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: { readonly aborted?: boolean }): void {
  if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: NonNullable<AxiosRequestConfig['signal']>,
  onLateValue?: (value: T) => void
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

export default PublicHttpClient;
