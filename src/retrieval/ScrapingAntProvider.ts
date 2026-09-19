import type { AxiosRequestConfig } from 'axios';
import { API_ENDPOINTS, TIMEOUTS } from '../config/constants.js';
import { disposeResponseBody, getHeaderValue } from '../utils/PublicNetwork.js';
import {
  isRetrievalProxyType,
  RetrievalError,
  type FiniteDocument,
  type RetrievalCostObservation,
  type RetrievalOperationContext,
  type RetrievalProvider,
  type RetrievalRequest,
  type RetrievalResponse
} from './types.js';
import { hasSensitiveCandidateCredentials } from './OutboundSecurityPolicy.js';
import { MAX_RETRIEVAL_RESPONSE_BYTES } from './DirectHttpProvider.js';
import { parseRetrievalCredits } from './RetrievalCostPolicy.js';
import { globalPublicSourceDispatchScheduler, SourceCooldownError, SourceDispatchDeadlineError, type SourceDispatchLease, type PublicSourceDispatchScheduler } from '../services/PublicSourceDispatchScheduler.js';
import { createRetrievalDispatchId } from './dispatchId.js';
import { relayAbortReason, retrievalFailureKindForAbort } from './abortDiagnostics.js';

export interface ScrapingAntProviderResponse {
  readonly status: number;
  readonly headers?: unknown;
  readonly data?: unknown;
}

export interface ScrapingAntProviderClient {
  request(config: AxiosRequestConfig): Promise<ScrapingAntProviderResponse>;
}

export interface ScrapingAntProviderOptions {
  apiKey?: string;
  client?: ScrapingAntProviderClient;
  maxResponseBytes?: number;
  sourceScheduler?: PublicSourceDispatchScheduler;
}

const MAX_IFRAME_DOCUMENTS = 16;

/** One ScrapingAnt API attempt; retry and paid admission belong to RetrievalService. */
export class ScrapingAntProvider implements RetrievalProvider {
  readonly name = 'scrapingant';
  readonly capabilities = {
    html: true,
    iframeDocuments: true,
    pdfCandidates: true,
    markdown: true,
    browser: true,
    paid: true,
    proxyTypes: ['datacenter', 'residential'],
    combinations: ['static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'],
    dispatchObservation: true,
    transportSlotManagement: true
  } as const;

  private readonly apiKey?: string;
  private readonly client: ScrapingAntProviderClient;
  private readonly maxResponseBytes: number;
  private readonly sourceScheduler: PublicSourceDispatchScheduler;

  constructor(options: ScrapingAntProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || process.env.SCRAPINGANT_API_KEY?.trim() || undefined;
    this.client = options.client || defaultClient();
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RETRIEVAL_RESPONSE_BYTES;
    this.sourceScheduler = options.sourceScheduler || globalPublicSourceDispatchScheduler;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async retrieve(request: RetrievalRequest, context: RetrievalOperationContext): Promise<RetrievalResponse> {
    if (request.documentFormat === 'markdown'
      && (request.strategy !== 'static' || (request.proxyType ?? 'datacenter') !== 'datacenter')) {
      throw new RetrievalError({
        code: 'invalid_request',
        message: 'Markdown retrieval only accepts the static datacenter combination',
        provider: this.name
      });
    }
    if (request.strategy !== 'static' && request.strategy !== 'browser') {
      throw new RetrievalError({
        code: 'invalid_request',
        message: 'ScrapingAnt provider only accepts static or browser retrieval',
        provider: this.name
      });
    }
    if (!isRetrievalProxyType(request.proxyType ?? 'datacenter')) {
      throw new RetrievalError({
        code: 'invalid_request',
        message: 'ScrapingAnt provider received an unsupported proxy category',
        provider: this.name
      });
    }
    if (!this.apiKey) {
      throw new RetrievalError({
        code: 'configuration',
        message: 'Paid retrieval provider is not configured',
        provider: this.name
      });
    }
    if (context.signal.aborted) {
      throw new RetrievalError({
        code: 'cancelled',
        message: 'Retrieval operation was cancelled',
        provider: this.name,
        failureKind: retrievalFailureKindForAbort(context.signal, context)
      });
    }

    const remainingMs = context.remainingMs();
    if (remainingMs <= 0) {
      throw new RetrievalError({
        code: 'timeout',
        message: 'Retrieval operation timed out',
        provider: this.name,
        failureKind: 'operation_deadline'
      });
    }
    // Publisher and Scholar paid attempts own the full bounded API timeout,
    // including their finite response body. Do not submit when those
    // operations cannot cover that timeout: cancellation after dispatch would
    // make billing unknown. Other consumers (for example Sci-Hub lookup) keep
    // their own shorter operation bounds and must not inherit this guard.
    if (requiresFullProviderTimeout(request.purpose) && remainingMs < TIMEOUTS.EXTENDED) {
      throw providerDeadlineError();
    }

    const endpoint = request.documentFormat === 'markdown'
      ? API_ENDPOINTS.SCRAPINGANT_MARKDOWN
      : request.documentFormat === 'html_with_iframes'
        ? API_ENDPOINTS.SCRAPINGANT_EXTENDED
        : API_ENDPOINTS.SCRAPINGANT_GENERAL;
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: endpoint,
      params: {
        url: request.url,
        'x-api-key': this.apiKey,
        browser: request.strategy === 'browser',
        proxy_type: request.proxyType ?? 'datacenter'
      },
      // The provider's proxy_type parameter controls the target-side proxy;
      // the API control-plane request itself must not inherit a process proxy.
      proxy: false,
      // A provider API call is one local submission; retries belong to the
      // shared RetrievalService and API redirects are never implicit.
      maxRedirects: 0,
      // Stream the decompressed response so the bounded reader can destroy it
      // at MAX_RETRIEVAL_RESPONSE_BYTES instead of letting Axios buffer it all.
      responseType: 'stream',
      timeout: Math.min(TIMEOUTS.EXTENDED, remainingMs),
      signal: context.signal,
      validateStatus: () => true
    };

    let response: ScrapingAntProviderResponse | undefined;
    let responseBodyStarted = false;
    let cost: RetrievalCostObservation = { known: false, credits: null, reason: 'missing_billing_header' };
    const linkedSignal = linkAbortSignals(context.signal, request.signal);
    requestConfig.signal = linkedSignal.signal;
    let releaseSource: SourceDispatchLease | undefined;
    try {
      throwIfCancelled(context, linkedSignal.signal);
      // The target origin, rather than the provider API origin, is the source
      // identity. This keeps Scholar direct and paid submissions on one paced
      // queue and prevents provider switching from bypassing cooldowns.
      releaseSource = await this.sourceScheduler.acquire(
        safeOrigin(request.url),
        linkedSignal.signal,
        context.deadlineAt,
        request.purpose === 'scholar_search' ? 3_000 : 0,
        { deferStart: true }
      );
      let dispatchObservation!: {
        readonly dispatchId: string;
        readonly role: 'provider_api';
        readonly origin: string;
        readonly submittedAt: number;
        readonly bodyPending: boolean;
      };
      const dispatch = async (): Promise<ScrapingAntProviderResponse> => {
        throwIfCancelled(context, linkedSignal.signal);
        // Source/concurrency queueing can consume the remaining tail after
        // the initial check; recheck at the exact submission boundary for
        // Publisher and Scholar only.
        if (requiresFullProviderTimeout(request.purpose) && context.remainingMs() < TIMEOUTS.EXTENDED) {
          throw providerDeadlineError();
        }
        releaseSource?.markStarted(context.deadlineAt);
        dispatchObservation = {
          dispatchId: createRetrievalDispatchId(),
          role: 'provider_api',
          origin: new URL(endpoint).origin,
          submittedAt: Date.now(),
          bodyPending: true
        };
        request.dispatchObserver?.onDispatch?.(dispatchObservation);
        const result = await this.client.request(requestConfig);
        try {
          request.dispatchObserver?.onResponse?.({
            ...dispatchObservation,
            ...(toStatus(result.status) === undefined ? {} : { status: toStatus(result.status) })
          });
        } catch {
          // Response diagnostics are observational; a completed provider
          // response must not become a retryable transport failure.
        }
        return result;
      };
      response = context.withDispatchSlot
        ? await context.withDispatchSlot(dispatch, linkedSignal.signal)
        : await dispatch();
      cost = parseRetrievalCredits(getHeaderValue(response.headers, 'Ant-credits-cost'));
      const apiStatus = toStatus(response.status);
      const readBody = () => {
        responseBodyStarted = true;
        return readBoundedPayload(response!.data, this.maxResponseBytes, context, linkedSignal.signal);
      };
      const payload = context.withDispatchSlot
        ? await context.withDispatchSlot(readBody, linkedSignal.signal)
        : await readBody();
      if (apiStatus === undefined || apiStatus < 200 || apiStatus >= 300) {
        throw createApiError(apiStatus, cost);
      }

      const parsed = parsePayload(payload);
      const pageStatus = extractPageStatus(parsed, response.headers);
      // The provider API's Retry-After must not be treated as the target's
      // header. A target 429 still establishes the conservative shared source
      // cooldown before this lease is released.
      if (pageStatus === 429) this.sourceScheduler.observeRetryAfter(safeOrigin(request.url), 429, {});
      const document = request.documentFormat === 'markdown'
        ? createMarkdownDocument(parsed, request.url, pageStatus)
        : createDocument(parsed, request.url, pageStatus);
      return {
        provider: this.name,
        strategy: request.strategy,
        apiStatus,
        targetStatus: pageStatus,
        document,
        contentType: getHeaderValue(response.headers, 'content-type'),
        cost
      };
    } catch (error) {
      if (error instanceof SourceDispatchDeadlineError) {
        throw new RetrievalError({
          code: 'timeout',
          message: 'ScrapingAnt retrieval timed out',
          provider: this.name,
          failureKind: 'operation_deadline',
          cost
        });
      }
      if (error instanceof SourceCooldownError) {
        throw new RetrievalError({
          code: 'target_unavailable',
          message: 'Public source is cooling down',
          provider: this.name,
          targetStatus: 429,
          cost
        });
      }
      if (error instanceof RetrievalError) {
        throw withCost(error, cost);
      }
      if (linkedSignal.signal.aborted || isAbortError(error)) {
        throw new RetrievalError({
          code: 'cancelled',
          message: 'Retrieval operation was cancelled',
          provider: this.name,
          apiStatus: toStatus(response?.status),
          failureKind: retrievalFailureKindForAbort(linkedSignal.signal, context),
          cost
        });
      }
      if (isTimeoutError(error) || context.remainingMs() <= 0) {
        throw new RetrievalError({
          code: 'timeout',
          message: 'ScrapingAnt retrieval timed out',
          provider: this.name,
          apiStatus: toStatus(response?.status),
          failureKind: context.remainingMs() <= 0
            ? 'operation_deadline'
            : responseBodyStarted ? 'response_body' : 'transport_timeout',
          cost
        });
      }
      throw new RetrievalError({
        code: 'network',
        message: 'ScrapingAnt retrieval failed',
        provider: this.name,
        apiStatus: toStatus(response?.status),
        retryable: true,
        ...(responseBodyStarted ? { failureKind: 'response_body' as const } : {}),
        cost
      });
    } finally {
      if (response) disposeResponseBody(response.data);
      releaseSource?.();
      linkedSignal.dispose();
    }
  }
}

function defaultClient(): ScrapingAntProviderClient {
  // Keep the dependency at the transport edge and avoid making axios part of
  // the provider-neutral contract.
  return {
    request: async config => {
      const { default: axios } = await import('axios');
      return axios.request(config) as Promise<ScrapingAntProviderResponse>;
    }
  };
}

async function readBoundedPayload(
  body: unknown,
  maxBytes: number,
  context: RetrievalOperationContext,
  signal: AbortSignal
): Promise<unknown> {
  throwIfCancelled(context, signal);
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    ensurePayloadSize(Buffer.byteLength(body), maxBytes);
    return body;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    ensurePayloadSize(body.byteLength, maxBytes);
    return Buffer.from(body);
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let total = 0;
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await waitForAbort(
          Promise.resolve(iterator.next()),
          signal,
          () => disposeAsyncIterator(body, iterator),
          () => retrievalFailureKindForAbort(signal, context)
        );
        if (next.done) break;
        throwIfCancelled(context, signal);
        const chunk = next.value;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
        total += buffer.byteLength;
        ensurePayloadSize(total, maxBytes, body);
        chunks.push(buffer);
      }
    } finally {
      disposeAsyncIterator(body, iterator);
    }
    return Buffer.concat(chunks, total);
  }

  // Axios may already have parsed JSON when a test seam or a custom adapter
  // supplies an object. Measure its serialized representation before reading
  // any fields; the production request explicitly asks for text.
  let serialized: string;
  try {
    serialized = JSON.stringify(body) ?? '';
  } catch {
    throw new RetrievalError({
      code: 'response_too_large',
      message: 'Retrieval response cannot be safely bounded',
      provider: 'scrapingant',
      failureKind: 'response_body'
    });
  }
  ensurePayloadSize(Buffer.byteLength(serialized), maxBytes);
  return body;
}

function parsePayload(payload: unknown): unknown {
  if (Buffer.isBuffer(payload)) {
    const text = payload.toString('utf8');
    return tryParseJson(text);
  }
  if (typeof payload === 'string') return tryParseJson(payload);
  return payload;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createMarkdownDocument(payload: unknown, _submittedUrl: string, targetStatus?: number): FiniteDocument {
  const body = payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const markdown = typeof body?.markdown === 'string' ? body.markdown : undefined;
  if (!markdown || !markdown.trim()) {
    throw new RetrievalError({
      code: 'provider_error',
      message: 'ScrapingAnt Markdown response is empty or invalid',
      provider: 'scrapingant',
      targetStatus,
      failureKind: 'response_body'
    });
  }
  if (targetStatus === undefined) {
    throw new RetrievalError({
      code: 'provider_error',
      message: 'ScrapingAnt Markdown response did not include target status',
      provider: 'scrapingant',
      failureKind: 'response_body'
    });
  }
  return {
    kind: 'markdown',
    html: '',
    iframes: [],
    markdown,
    // Markdown is isolated from URL provenance. The target is never returned
    // as an observed/final URL to the LLM-facing boundary.
    source: { provenance: 'unknown_remote', submittedUrl: '[redacted]' },
    targetStatus
  };
}

function createDocument(payload: unknown, submittedUrl: string, targetStatus?: number): FiniteDocument {
  const body = payload && typeof payload === 'object' && !Buffer.isBuffer(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const html = typeof payload === 'string'
    ? payload
    : typeof body?.html === 'string'
      ? body.html
      : typeof body?.content === 'string' ? body.content : '';
  const rawIframes = body?.iframes;
  if (Array.isArray(rawIframes) && rawIframes.length > MAX_IFRAME_DOCUMENTS) {
    throw new RetrievalError({
      code: 'document_limit',
      message: 'Retrieval response contains too many iframe documents',
      provider: 'scrapingant',
      failureKind: 'response_body'
    });
  }

  const iframes = Array.isArray(rawIframes)
    ? rawIframes
      .filter(frame => frame && typeof frame === 'object')
      .map(frame => {
        const value = frame as Record<string, unknown>;
        const src = sanitizeIframeSource(value.src);
        return {
          src,
          html: typeof value.html === 'string' ? value.html : '',
          // The iframe src is visible provider data, not a trusted final source;
          // keep outward provenance tied to the submitted target and never expose
          // a signed iframe URL as candidate context.
          source: { provenance: 'unknown_remote' as const, submittedUrl }
        };
      })
    : [];

  return {
    kind: 'html',
    html,
    iframes,
    source: { provenance: 'unknown_remote', submittedUrl },
    ...(targetStatus === undefined ? {} : { targetStatus })
  };
}

function sanitizeIframeSource(value: unknown): string {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  if (!source) return '';
  const absolute = /^https?:\/\//i.test(source)
    ? source
    : /^\/\//.test(source) ? `https:${source}` : undefined;
  if (absolute) {
    try {
      const parsed = new URL(absolute);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username || parsed.password || hasSensitiveCandidateCredentials(parsed.toString())) return '';
      return source;
    } catch {
      return '';
    }
  }
  if (!source.startsWith('/') && !source.startsWith('./') && !source.startsWith('../')) return '';
  try {
    const probe = new URL(source, 'https://untrusted-iframe.invalid');
    return hasSensitiveCandidateCredentials(probe.toString()) ? '' : source;
  } catch {
    return '';
  }
}

function extractPageStatus(payload: unknown, headers: unknown): number | undefined {
  const body = payload && typeof payload === 'object' && !Buffer.isBuffer(payload)
    ? payload as Record<string, unknown>
    : undefined;
  return toStatus(body?.status_code) ?? toStatus(getHeaderValue(headers, 'Ant-page-status-code'));
}

function createApiError(status: number | undefined, cost: RetrievalCostObservation): RetrievalError {
  const normalizedStatus = status === undefined ? undefined : status;
  let code: RetrievalError['code'] = 'provider_error';
  let retryable = false;
  if (normalizedStatus === 400 || normalizedStatus === 405 || normalizedStatus === 422) code = 'invalid_request';
  else if (normalizedStatus === 403) code = 'auth_or_credits_unknown';
  else if (normalizedStatus === 404) code = 'target_unavailable';
  else if (normalizedStatus === 409) { code = 'concurrency_limited'; retryable = true; }
  else if (normalizedStatus === 429) code = 'provider_error';
  else if (normalizedStatus === 423) { code = 'detected'; retryable = true; }
  else if (normalizedStatus !== undefined && normalizedStatus >= 500) { code = 'server_error'; retryable = true; }

  return new RetrievalError({
    code,
    message: normalizedStatus === undefined ? 'ScrapingAnt returned an invalid response' : 'ScrapingAnt request failed',
    provider: 'scrapingant',
    apiStatus: normalizedStatus,
    status: normalizedStatus,
    retryable,
    cost
  });
}

function withCost(error: RetrievalError, cost: RetrievalCostObservation): RetrievalError {
  if (error.cost) return error;
  return new RetrievalError({
    code: error.code,
    message: error.message,
    provider: error.provider,
    status: error.status,
    apiStatus: error.apiStatus,
    targetStatus: error.targetStatus,
    retryable: error.retryable,
    failureKind: error.failureKind,
    cost
  });
}

function ensurePayloadSize(size: number, maxBytes: number, body?: unknown): void {
  if (size <= maxBytes) return;
  disposeResponseBody(body);
  throw new RetrievalError({
    code: 'response_too_large',
    message: 'Retrieval response exceeds the allowed size',
    provider: 'scrapingant',
    failureKind: 'response_body'
  });
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'unknown';
  }
}

function toStatus(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= 100 && number <= 599 ? number : undefined;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function disposeAsyncIterator(body: unknown, iterator: AsyncIterator<unknown>): void {
  disposeResponseBody(body);
  try {
    const closing = iterator.return?.();
    if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Preserve the retrieval error while still making a best-effort cleanup.
  }
}

function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
  failureKind?: () => RetrievalError['failureKind']
): Promise<T> {
  if (signal.aborted) return Promise.reject(new RetrievalError({
    code: 'cancelled',
    message: 'Retrieval operation was cancelled',
    provider: 'scrapingant',
    failureKind: failureKind?.() || 'cancelled'
  }));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    const onAbort = () => {
      if (settled) return;
      abandoned = true;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new RetrievalError({
        code: 'cancelled',
        message: 'Retrieval operation was cancelled',
        provider: 'scrapingant',
        failureKind: failureKind?.() || 'cancelled'
      }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      if (settled) {
        if (abandoned) onLateValue?.(value);
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function requiresFullProviderTimeout(purpose: RetrievalRequest['purpose']): boolean {
  return purpose === 'publisher_discovery' || purpose === 'scholar_search';
}

function providerDeadlineError(): RetrievalError {
  return new RetrievalError({
    code: 'timeout',
    message: 'Retrieval operation cannot cover the bounded provider timeout',
    provider: 'scrapingant',
    failureKind: 'operation_deadline'
  });
}

function throwIfCancelled(context: RetrievalOperationContext, signal: AbortSignal = context.signal): void {
  if (context.signal.aborted || signal.aborted) {
    throw new RetrievalError({
      code: 'cancelled',
      message: 'Retrieval operation was cancelled',
      provider: 'scrapingant',
      failureKind: retrievalFailureKindForAbort(signal, context)
    });
  }
}

function linkAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const relay = () => relayAbortReason(controller, primary.aborted ? primary : secondary!);
  if (primary.aborted || secondary.aborted) relay();
  else {
    primary.addEventListener('abort', relay, { once: true });
    secondary.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', relay);
      secondary.removeEventListener('abort', relay);
      controller.abort();
    }
  };
}

function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | undefined;
  return candidate?.name === 'AbortError' || candidate?.code === 'ERR_CANCELED';
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string } | undefined;
  return candidate?.code === 'ECONNABORTED' || candidate?.code === 'ETIMEDOUT' || candidate?.name === 'TimeoutError';
}

export { MAX_IFRAME_DOCUMENTS };
export default ScrapingAntProvider;
