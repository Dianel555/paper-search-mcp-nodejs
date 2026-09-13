import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { TIMEOUTS, USER_AGENT } from '../config/constants.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import { QuotaManager, type QuotaConfig, type QuotaReservation } from '../utils/QuotaManager.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { sanitizeUrl } from '../utils/SecurityUtils.js';

export interface WosHttpRequester {
  request(config: AxiosRequestConfig): Promise<AxiosResponse<any>>;
}

export interface WebOfScienceRequestServiceOptions {
  apiKey?: string;
  httpClient?: WosHttpRequester;
  rateLimiter?: Pick<RateLimiter, 'waitForPermission' | 'getStatus'>;
  requestsPerSecondEnv: string;
  defaultRequestsPerSecond: number;
  quotaManager?: QuotaManager;
  quotaPlatform: string;
  quotaConfig: QuotaConfig;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
}

export interface WebOfScienceRequestStatus {
  configured: boolean;
  baseUrl: string;
  rateLimiter: ReturnType<RateLimiter['getStatus']>;
  quota: ReturnType<QuotaManager['getStatus']>;
  lastQuotaHeaders: Record<string, string>;
  requestAttempts: number;
}

/** Shared authenticated request/retry/quota mechanics for WoS products. */
export class WebOfScienceRequestService {
  private readonly apiKey?: string;
  private readonly httpClient: WosHttpRequester;
  private readonly rateLimiter: Pick<RateLimiter, 'waitForPermission' | 'getStatus'>;
  private readonly quotaManager: QuotaManager;
  private readonly quotaPlatform: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private lastQuotaHeaders: Record<string, string> = {};
  private requestAttempts = 0;

  constructor(options: WebOfScienceRequestServiceOptions) {
    this.apiKey = options.apiKey;
    this.httpClient = options.httpClient || axios;
    this.rateLimiter = options.rateLimiter || new RateLimiter({
      requestsPerSecond: readPositiveNumber(process.env[options.requestsPerSecondEnv], options.defaultRequestsPerSecond),
      burstCapacity: 1,
      debug: process.env.NODE_ENV === 'development'
    });
    this.quotaManager = options.quotaManager || QuotaManager.getInstance();
    this.quotaPlatform = options.quotaPlatform;
    this.quotaManager.registerPlatform(this.quotaPlatform, options.quotaConfig);
    this.sleep = options.sleep || ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.random = options.random || Math.random;
    this.maxRetries = options.maxRetries ?? 3;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    let lastError: any;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.rateLimiter.waitForPermission();

      // Reserve and commit one local budget unit before dispatch. This both
      // prevents concurrent calls from passing the same final remaining unit
      // and counts failed attempts that still consumed a request slot.
      const quota = this.quotaManager.getStatus(this.quotaPlatform);
      const boundedReservation = Boolean(quota && quota.limit > 0);
      let reservation: QuotaReservation | undefined;
      if (boundedReservation) {
        reservation = this.quotaManager.reserve(this.quotaPlatform, 1);
        this.quotaManager.commit(reservation);
        reservation = undefined;
      } else {
        this.quotaManager.checkQuota(this.quotaPlatform);
        this.quotaManager.incrementUsage(this.quotaPlatform);
      }
      this.requestAttempts++;

      const requestConfig: AxiosRequestConfig = {
        ...config,
        headers: {
          'X-ApiKey': this.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          ...(config.headers || {})
        },
        timeout: config.timeout ?? TIMEOUTS.DEFAULT,
        validateStatus: () => true
      };

      try {
        const response = await this.httpClient.request(requestConfig) as AxiosResponse<T>;
        if (response.status < 200 || response.status >= 300) {
          const error: any = new Error(`Web of Science request failed with status ${response.status}`);
          error.response = response;
          error.config = requestConfig;
          throw error;
        }
        this.captureQuotaHeaders(response.headers);
        return response;
      } catch (error: any) {
        if (reservation) {
          // Defensive cleanup if dispatch setup changes before commit.
          this.quotaManager.release(reservation);
          reservation = undefined;
        }
        lastError = error;
        if (attempt >= this.maxRetries || !ErrorHandler.isRetryable(error)) throw error;
        const baseDelay = Math.min(30000, 1000 * Math.pow(2, attempt));
        await this.sleep(Math.floor(this.random() * baseDelay));
      }
    }
    throw lastError || new Error('Web of Science request failed');
  }

  getStatus(baseUrl: string): WebOfScienceRequestStatus {
    return {
      configured: this.isConfigured(),
      baseUrl: sanitizeUrl(baseUrl),
      rateLimiter: this.rateLimiter.getStatus(),
      quota: this.quotaManager.getStatus(this.quotaPlatform),
      lastQuotaHeaders: { ...this.lastQuotaHeaders },
      requestAttempts: this.requestAttempts
    };
  }

  getApiKeyStatus(error: any): 'valid' | 'invalid' | 'unknown' | 'missing' {
    if (!this.apiKey) return 'missing';
    const status = error?.status ?? error?.response?.status;
    return status === 401 || status === 403 ? 'invalid' : 'unknown';
  }

  private captureQuotaHeaders(headers: unknown): void {
    const selected: Record<string, string> = {};
    if (headers && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (/^x-(rec|req)-.*remaining$/i.test(name) && value !== undefined) {
          selected[name] = Array.isArray(value) ? value.join(', ') : String(value);
        }
      }
    }
    this.lastQuotaHeaders = selected;
  }
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export default WebOfScienceRequestService;
