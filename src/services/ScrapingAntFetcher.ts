import axios, { type AxiosRequestConfig } from 'axios';
import { createConcurrencyLimiter, type ConcurrencyLimit } from '../utils/ConcurrencyLimiter.js';
import { API_ENDPOINTS, TIMEOUTS } from '../config/constants.js';
import { MAX_RETRIEVAL_RESPONSE_BYTES } from '../retrieval/DirectHttpProvider.js';
import { CapabilityUnavailableError } from '../utils/CapabilityErrors.js';
import { disposeResponseBody, getHeaderValue, validatePublicHttpUrl, type PublicUrlValidation } from '../utils/PublicNetwork.js';
import { logDebug } from '../utils/Logger.js';
import { hasSensitiveCandidateCredentials, OutboundSecurityError } from '../retrieval/OutboundSecurityPolicy.js';
import { parseRetrievalCredits } from '../retrieval/RetrievalCostPolicy.js';
import { RetrievalError, type RetrievalCostObservation, type RetrievalErrorCode } from '../retrieval/types.js';

type ScrapingAntEndpoint = 'general' | 'extended' | 'markdown';
type ProxyType = 'datacenter' | 'residential';

export interface ScrapingAntIframe {
  src: string;
  html: string;
}

export interface ScrapingAntResult {
  html: string;
  markdown?: string;
  text?: string;
  apiStatus: number;
  pageStatus?: number;
  creditsCost?: number;
  // Only a small allowlist of non-sensitive response headers is exposed.
  headers?: Array<{ name: string; value: string }>;
  iframes?: ScrapingAntIframe[];
}

export interface ScrapingAntFetchOptions {
  endpoint?: ScrapingAntEndpoint;
  browser?: boolean;
  proxyType?: ProxyType;
  waitForSelector?: string;
  signal?: AbortSignal;
  /** Internal adapter seam: let RetrievalService own retry admission. */
  singleAttempt?: boolean;
}

export interface ScrapingAntStatus {
  configured: boolean;
  creditsUsed: number;
  requestCount: number;
  maxConcurrency: number;
  proxyType: ProxyType;
  lastApiStatus?: number;
  lastPageStatus?: number;
}

export interface ScrapingAntResponse {
  status: number;
  headers?: unknown;
  data?: any;
}

export interface ScrapingAntHttpRequester {
  request(config: AxiosRequestConfig): Promise<ScrapingAntResponse>;
}

export interface ScrapingAntFetcherOptions {
  apiKey?: string;
  client?: ScrapingAntHttpRequester;
  maxConcurrency?: number;
  maxRetries?: number;
  proxyType?: ProxyType;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  validateUrl?: (url: string) => Promise<PublicUrlValidation>;
}

export class ScrapingAntError extends Error {
  public readonly status?: number;
  public readonly creditsCost?: number;
  public readonly code?: RetrievalErrorCode;
  public readonly lateCost?: Promise<RetrievalCostObservation>;

  constructor(
    message: string,
    status?: number,
    creditsCost?: number,
    code?: RetrievalErrorCode,
    lateCost?: Promise<RetrievalCostObservation>
  ) {
    super(message);
    this.name = 'ScrapingAntError';
    this.status = status;
    this.creditsCost = creditsCost;
    this.code = code;
    this.lateCost = lateCost;
  }
}

/**
 * Small, deliberately non-SDK wrapper around ScrapingAnt's HTML APIs.
 * It never downloads binary files and keeps all credentials out of results.
 */
export class ScrapingAntFetcher {
  private readonly apiKey?: string;
  private readonly client: ScrapingAntHttpRequester;
  private readonly limit: ConcurrencyLimit;
  private readonly maxConcurrency: number;
  private readonly validateUrl: (url: string) => Promise<PublicUrlValidation>;
  private readonly proxyType: ProxyType;
  private creditsUsed = 0;
  private requestCount = 0;
  private lastApiStatus?: number;
  private lastPageStatus?: number;

  constructor(options: ScrapingAntFetcherOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SCRAPINGANT_API_KEY;
    this.client = options.client || axios;
    this.maxConcurrency = options.maxConcurrency ?? readPositiveInteger(process.env.SCRAPINGANT_MAX_CONCURRENCY, 1);
    this.validateUrl = options.validateUrl || ((url: string) => validatePublicHttpUrl(url));

    const configuredProxy = options.proxyType || process.env.SCRAPINGANT_PROXY_TYPE;
    this.proxyType = configuredProxy === 'residential' ? 'residential' : 'datacenter';
    this.limit = createConcurrencyLimiter(this.maxConcurrency);
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async fetch(targetUrl: string, options: ScrapingAntFetchOptions = {}): Promise<ScrapingAntResult> {
    if (!this.apiKey) {
      throw new CapabilityUnavailableError('scrapingant', 'fetch', 'ScrapingAnt API key is not configured');
    }
    if (process.env.SCRAPINGANT_ENABLED !== 'true') {
      throw new CapabilityUnavailableError('scrapingant', 'fetch', 'ScrapingAnt paid retrieval is not explicitly enabled');
    }
    if (this.proxyType === 'residential' || options.proxyType === 'residential') {
      throw new CapabilityUnavailableError('scrapingant', 'fetch', 'Residential proxy retrieval is not supported');
    }
    if (options.endpoint === 'markdown' && options.browser) {
      throw new CapabilityUnavailableError('scrapingant', 'fetch', 'Markdown retrieval only supports static datacenter requests');
    }
    if (options.browser && process.env.SCRAPINGANT_ALLOW_BROWSER_ESCALATION !== 'true') {
      throw new CapabilityUnavailableError('scrapingant', 'fetch', 'Browser escalation is not explicitly enabled');
    }

    return this.limit(async () => {
      throwIfAborted(options.signal);
      try {
        await waitForAbort(this.validateUrl(targetUrl), options.signal);
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) throw error;
        throw new ScrapingAntError('ScrapingAnt target validation failed', undefined, undefined, 'security');
      }
      throwIfAborted(options.signal);
      return this.fetchOnce(targetUrl, options);
    }, options.signal);
  }

  getStatus(): ScrapingAntStatus {
    return {
      configured: this.isConfigured(),
      creditsUsed: this.creditsUsed,
      requestCount: this.requestCount,
      maxConcurrency: this.maxConcurrency,
      proxyType: this.proxyType,
      lastApiStatus: this.lastApiStatus,
      lastPageStatus: this.lastPageStatus
    };
  }

  private async fetchOnce(targetUrl: string, options: ScrapingAntFetchOptions): Promise<ScrapingAntResult> {
    const endpoint = options.endpoint || 'general';
    const endpointUrl = endpoint === 'markdown'
      ? API_ENDPOINTS.SCRAPINGANT_MARKDOWN
      : endpoint === 'extended' ? API_ENDPOINTS.SCRAPINGANT_EXTENDED : API_ENDPOINTS.SCRAPINGANT_GENERAL;
    throwIfAborted(options.signal);
    let response: ScrapingAntResponse | undefined;
    let observedCredits: number | undefined;
    let responseAccounted = false;
    let requestSettled = false;
    let requestStarted = false;
    let resolveLateCost!: (observation: RetrievalCostObservation) => void;
    let lateCostSettled = false;
    const lateCost = new Promise<RetrievalCostObservation>(resolve => { resolveLateCost = resolve; });
    const settleLateCost = (observation: RetrievalCostObservation): void => {
      if (lateCostSettled) return;
      lateCostSettled = true;
      resolveLateCost(observation);
    };
    const accountLateResponse = (lateResponse: ScrapingAntResponse): void => {
      if (responseAccounted) return;
      responseAccounted = true;
      const metadata = this.accountResponse(lateResponse);
      observedCredits = metadata.creditsCost;
      settleLateCost(metadata.creditsCost === undefined
        ? { known: false, credits: null, reason: 'missing_billing_header' }
        : { known: true, credits: metadata.creditsCost });
      disposeUnknownResponseBody(lateResponse.data);
    };
    this.requestCount++;
    try {
      const params: Record<string, string | boolean> = {
        url: targetUrl,
        'x-api-key': this.apiKey as string,
        browser: options.browser ?? false,
        proxy_type: options.proxyType || this.proxyType
      };
      if (options.waitForSelector) params.wait_for_selector = options.waitForSelector;

      throwIfAborted(options.signal);
      requestStarted = true;
      const responsePromise = this.client.request({
        method: 'GET',
        url: endpointUrl,
        params,
        timeout: TIMEOUTS.EXTENDED,
        signal: options.signal,
        responseType: 'stream',
        validateStatus: () => true
      });
      void responsePromise.then(
        lateResponse => {
          requestSettled = true;
          if (options.signal?.aborted) accountLateResponse(lateResponse);
        },
        () => {
          requestSettled = true;
          settleLateCost({ known: false, credits: null, reason: 'transport_failed_before_response' });
        }
      );
      response = await waitForAbort(responsePromise, options.signal, accountLateResponse);
      if (!responseAccounted) {
        const metadata = this.accountResponse(response);
        responseAccounted = true;
        observedCredits = metadata.creditsCost;
      }
      const status = Number(response.status);
      const responseCredits = observedCredits;
      if (options.signal?.aborted) throw createAbortError();

      const payload = await readBoundedPayload(response.data, responseCredits, options.signal);
      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        throw new ScrapingAntError(`ScrapingAnt request failed with status ${Number.isFinite(status) ? status : 'unknown'}`, status, responseCredits);
      }

      const result = this.parseResult(parsePayload(payload), status, response.headers, responseCredits, endpoint);
      this.lastPageStatus = result.pageStatus;
      logDebug(`ScrapingAnt ${endpoint} completed (${status}, page ${result.pageStatus ?? 'unknown'}, credits ${result.creditsCost ?? 0})`);
      return result;
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        throw new ScrapingAntError(
          'ScrapingAnt request was cancelled',
          undefined,
          observedCredits,
          'cancelled',
          requestStarted && !responseAccounted ? lateCost : undefined
        );
      }
      throw this.toSafeError(error, observedCredits);
    } finally {
      if (requestStarted && !requestSettled && !responseAccounted) {
        // Keep late-cost reconciliation alive until the transport settles.
      } else if (!lateCostSettled) {
        settleLateCost({ known: false, credits: null, reason: 'no_late_response' });
      }
      disposeUnknownResponseBody(response?.data);
    }
  }

  private accountResponse(response: ScrapingAntResponse): { status: number; creditsCost?: number } {
    const status = Number(response.status);
    this.lastApiStatus = status;
    this.lastPageStatus = undefined;
    const creditsObservation = parseRetrievalCredits(getHeaderValue(response.headers, 'Ant-credits-cost'));
    const creditsCost = creditsObservation.known ? creditsObservation.credits : undefined;
    if (creditsCost !== undefined) this.creditsUsed += creditsCost;
    return { status, creditsCost };
  }

  private parseResult(
    data: any,
    apiStatus: number,
    responseHeaders: unknown,
    responseCredits?: number,
    endpoint: ScrapingAntEndpoint = 'general'
  ): ScrapingAntResult {
    const body = data && typeof data === 'object' && !Buffer.isBuffer(data) ? data : {};
    const markdown = endpoint === 'markdown' && typeof body.markdown === 'string' && body.markdown.trim()
      ? body.markdown
      : undefined;
    if (endpoint === 'markdown' && !markdown) {
      throw new ScrapingAntError('ScrapingAnt Markdown response is empty or invalid', apiStatus, responseCredits, 'provider_error');
    }
    const html = endpoint === 'markdown' ? '' : typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : typeof body.html === 'string'
          ? body.html
          : typeof body.content === 'string' ? body.content : '';
    const pageStatus = toOptionalNumber(body.status_code) ?? toOptionalNumber(getHeaderValue(responseHeaders, 'Ant-page-status-code'));
    const creditsObservation = parseRetrievalCredits(getHeaderValue(responseHeaders, 'Ant-credits-cost'));
    const creditsCost = creditsObservation.known ? creditsObservation.credits : undefined;
    if (Array.isArray(body.iframes) && body.iframes.length > 16) {
      throw new ScrapingAntError('ScrapingAnt response contains too many iframe documents', apiStatus, responseCredits, 'document_limit');
    }
    const iframes = Array.isArray(body.iframes)
      ? body.iframes
          .filter((frame: any) => frame && typeof frame === 'object')
          .map((frame: any) => ({ src: sanitizeIframeSource(frame.src), html: typeof frame.html === 'string' ? frame.html : '' }))
      : undefined;

    return {
      html,
      ...(markdown ? { markdown } : {}),
      text: typeof body.text === 'string' ? body.text : undefined,
      apiStatus,
      pageStatus,
      creditsCost,
      ...(endpoint === 'markdown' ? {} : { headers: sanitizeResponseHeaders(body.headers), iframes }),
    };
  }

  private toSafeError(error: any, observedCredits?: number): ScrapingAntError {
    if (error instanceof ScrapingAntError) {
      if (error.creditsCost !== undefined || observedCredits === undefined) return error;
      return new ScrapingAntError(error.message, error.status, observedCredits, error.code, error.lateCost);
    }
    const status = toOptionalNumber(error?.response?.status) ?? toOptionalNumber(error?.status);
    const code = isTimeoutError(error) ? 'timeout' : 'network';
    return new ScrapingAntError(
      `ScrapingAnt request failed${status ? ` with status ${status}` : ''}`,
      status,
      observedCredits,
      code
    );
  }
}

export function toRetrievalError(error: unknown): RetrievalError {
  if (error instanceof RetrievalError) return error;

  let code: RetrievalErrorCode;
  let status: number | undefined;
  let creditsCost: number | undefined;
  if (error instanceof ScrapingAntError) {
    code = error.code || codeForStatus(error.status);
    status = error.status;
    creditsCost = error.creditsCost;
  } else if (error instanceof OutboundSecurityError) {
    code = 'security';
  } else if (error instanceof CapabilityUnavailableError) {
    code = 'configuration';
  } else if (isAbortError(error)) {
    code = 'cancelled';
  } else if (isTimeoutError(error)) {
    code = 'timeout';
  } else {
    code = 'network';
  }

  const message = code === 'security'
    ? 'Retrieval target was rejected by outbound security policy'
    : code === 'cancelled'
      ? 'Retrieval operation was cancelled'
      : code === 'timeout'
        ? 'Retrieval operation timed out'
        : code === 'configuration'
          ? 'Paid retrieval provider is not configured'
          : code === 'response_too_large'
            ? 'Retrieval response exceeds the allowed size'
            : code === 'document_limit'
              ? 'Retrieval response contains too many iframe documents'
              : 'ScrapingAnt compatibility retrieval failed';
  return new RetrievalError({
    code,
    message,
    provider: 'scrapingant',
    status,
    apiStatus: status,
    retryable: code === 'concurrency_limited' || code === 'detected' || code === 'server_error' || code === 'network',
    cost: Number.isSafeInteger(creditsCost) && (creditsCost as number) >= 0
      ? { known: true, credits: creditsCost as number }
      : { known: false, credits: null, reason: 'compatibility fetcher did not report credits' },
    ...(error instanceof ScrapingAntError && error.lateCost ? { lateCost: error.lateCost } : {})
  });
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

function codeForStatus(status: number | undefined): RetrievalErrorCode {
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 403) return 'auth_or_credits_unknown';
  if (status === 404) return 'target_unavailable';
  if (status === 409) return 'concurrency_limited';
  if (status === 423) return 'detected';
  if (status !== undefined && status >= 500) return 'server_error';
  return 'provider_error';
}

function parsePayload(payload: unknown): unknown {
  if (Buffer.isBuffer(payload)) return tryParseJson(payload.toString('utf8'));
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

async function readBoundedPayload(body: unknown, creditsCost?: number, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    ensurePayloadSize(Buffer.byteLength(body), creditsCost);
    return body;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    ensurePayloadSize(body.byteLength, creditsCost);
    return Buffer.from(body);
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let total = 0;
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await waitForAbort(Promise.resolve(iterator.next()), signal, () => disposeAsyncIterator(body, iterator));
        if (next.done) break;
        throwIfAborted(signal);
        const chunk = next.value;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
        total += buffer.byteLength;
        ensurePayloadSize(total, creditsCost, body);
        chunks.push(buffer);
      }
    } finally {
      disposeAsyncIterator(body, iterator);
    }
    return Buffer.concat(chunks, total);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(body) ?? '';
  } catch {
    throw new ScrapingAntError('ScrapingAnt response cannot be safely bounded', undefined, creditsCost, 'response_too_large');
  }
  ensurePayloadSize(Buffer.byteLength(serialized), creditsCost);
  return body;
}

function ensurePayloadSize(size: number, creditsCost?: number, body?: unknown): void {
  if (size <= MAX_RETRIEVAL_RESPONSE_BYTES) return;
  disposeResponseBody(body);
  throw new ScrapingAntError('ScrapingAnt response exceeds the allowed size', undefined, creditsCost, 'response_too_large');
}

function disposeAsyncIterator(body: unknown, iterator: AsyncIterator<unknown>): void {
  disposeResponseBody(body);
  try {
    const closing = iterator.return?.();
    if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Resource cleanup must not replace the original transport error.
  }
}

function disposeUnknownResponseBody(body: unknown): void {
  if (!isAsyncIterable(body)) {
    disposeResponseBody(body);
    return;
  }
  try {
    disposeAsyncIterator(body, body[Symbol.asyncIterator]());
  } catch {
    disposeResponseBody(body);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: Pick<AbortSignal, 'aborted'>): void {
  if (signal?.aborted) throw createAbortError();
}

function waitForAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onLateValue?: (value: T) => void
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      abandoned = true;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      if (settled) {
        if (abandoned) onLateValue?.(value);
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string } | undefined;
  return candidate?.code === 'ECONNABORTED' || candidate?.code === 'ETIMEDOUT' || candidate?.name === 'TimeoutError';
}

function isAbortError(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string } | undefined;
  return candidate?.code === 'ERR_CANCELED' || candidate?.name === 'AbortError';
}

function sanitizeResponseHeaders(value: unknown): Array<{ name: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const safeNames = /^(content-type|content-length|cache-control|etag|last-modified)$/i;
  return value
    .filter((header: any) => header && typeof header.name === 'string' && typeof header.value === 'string')
    .filter((header: any) => safeNames.test(header.name))
    .map((header: any) => ({ name: header.name, value: header.value.slice(0, 512) }));
}

export default ScrapingAntFetcher;
