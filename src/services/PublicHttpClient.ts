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
  OutboundSecurityPolicy,
  type OutboundPurpose
} from '../retrieval/OutboundSecurityPolicy.js';

export interface PublicHttpResponseData<T = unknown> {
  status: number;
  headers?: unknown;
  data: T;
}

export interface PublicHttpRequester {
  request(config: AxiosRequestConfig): Promise<PublicHttpResponseData>;
}

export interface PublicHttpClientOptions extends PublicUrlValidationOptions {
  /** Backward-compatible public-network test seam; sensitive checks remain owned here. */
  validateUrl?: (url: string) => Promise<PublicUrlValidation>;
  securityPolicy?: OutboundSecurityPolicy;
  purpose?: OutboundPurpose;
  client?: PublicHttpRequester;
  maxRedirects?: number;
}

export interface PublicHttpResponse<T = unknown> {
  response: PublicHttpResponseData<T>;
  finalUrl: string;
}

/** HTTP client with public-target validation and manually checked redirects. */
export class PublicHttpClient {
  private readonly client: PublicHttpRequester;
  private readonly maxRedirects: number;
  private readonly securityPolicy: OutboundSecurityPolicy;
  private readonly purpose: OutboundPurpose;

  constructor(options: PublicHttpClientOptions = {}) {
    this.client = options.client || axios;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.purpose = options.purpose || 'retrieval';
    this.securityPolicy = options.securityPolicy || new OutboundSecurityPolicy({
      lookup: options.lookup,
      validatePublicUrl: options.validateUrl
    });
  }

  async request<T = unknown>(url: string, config: AxiosRequestConfig = {}): Promise<PublicHttpResponse<T>> {
    let currentUrl = url;
    let requestHeaders = config.headers;

    for (let redirect = 0; redirect <= this.maxRedirects; redirect++) {
      throwIfAborted(config.signal);
      const validation = await awaitWithAbort(
        this.securityPolicy.validate(currentUrl, this.purpose),
        config.signal
      );
      throwIfAborted(config.signal);
      const safeConfig = stripTransportOverrides(config);
      const response = await this.client.request({
        ...safeConfig,
        url: currentUrl,
        headers: requestHeaders,
        // Never inherit HTTP(S)_PROXY/NO_PROXY settings for a validated
        // public-target request; the checked address must be the destination.
        proxy: false,
        maxRedirects: 0,
        validateStatus: () => true,
        // Axios forwards this Node option to the http/https adapter.
        lookup: createPinnedLookup(validation.addresses)
      } as AxiosRequestConfig & { lookup: unknown }) as PublicHttpResponseData<T>;

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

      return { response, finalUrl: currentUrl };
    }

    throw new Error('Too many public URL redirects');
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
    validateStatus: _validateStatus,
    ...safeConfig
  } = config as AxiosRequestConfig & Record<string, unknown>;
  return safeConfig;
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: { readonly aborted?: boolean }): void {
  if (signal?.aborted) throw createAbortError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: NonNullable<AxiosRequestConfig['signal']>): Promise<T> {
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
        if (settled) return;
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
