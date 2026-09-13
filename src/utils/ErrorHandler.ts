/**
 * Unified Error Handler for API requests
 * Provides consistent error handling across all platforms
 */

import { sanitizeRequest, sanitizeBody, sanitizeSensitiveText, maskSensitiveData } from './SecurityUtils.js';
import { logError as loggerError, logDebug } from './Logger.js';

/**
 * API Error codes and their meanings
 */
export const HTTP_ERROR_CODES = {
  400: 'Bad Request - Invalid parameters or syntax',
  401: 'Unauthorized - Invalid or missing API key',
  403: 'Forbidden - Access denied or rate limit exceeded',
  404: 'Not Found - Resource does not exist',
  405: 'Method Not Allowed - HTTP method not supported',
  408: 'Request Timeout - Server took too long to respond',
  429: 'Too Many Requests - Rate limit exceeded',
  500: 'Internal Server Error - Server error',
  502: 'Bad Gateway - Server communication error',
  503: 'Service Unavailable - Server temporarily unavailable',
  504: 'Gateway Timeout - Server timeout'
} as const;

/**
 * Custom API Error class with detailed information
 */
export class ApiError extends Error {
  public readonly status?: number;
  public readonly platform: string;
  public readonly operation: string;
  public readonly timestamp: string;
  public readonly retryable: boolean;
  public readonly details?: any;

  constructor(options: {
    message: string;
    status?: number;
    platform: string;
    operation: string;
    details?: any;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.platform = options.platform;
    this.operation = options.operation;
    this.timestamp = new Date().toISOString();
    this.details = options.details;
    
    // Determine if error is retryable
    this.retryable = this.isRetryable(options.status);
  }

  private isRetryable(status?: number): boolean {
    if (!status) return true;
    // Retryable: rate limits, timeouts, server errors
    return [408, 429, 500, 502, 503, 504].includes(status);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      platform: this.platform,
      operation: this.operation,
      timestamp: this.timestamp,
      retryable: this.retryable
    };
  }
}

/**
 * Error Handler class for unified error processing
 */
export interface RetryWithBackoffOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  context?: string;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export class ErrorHandler {
  private platform: string;
  private verbose: boolean;

  constructor(platform: string, verbose: boolean = false) {
    this.platform = platform;
    this.verbose = verbose || process.env.NODE_ENV === 'development';
  }

  /**
   * Handle HTTP errors from axios or similar libraries
   */
  handleHttpError(error: any, operation: string): never {
    const status = error.response?.status;
    const responseMessage = sanitizeSensitiveText(this.extractErrorMessage(error));
    const url = error.config?.url;
    const method = error.config?.method?.toUpperCase() || 'GET';

    // Sanitize sensitive data before logging
    const sanitizedConfig = sanitizeRequest(error.config);
    const sanitizedUrl = url ? this.sanitizeUrl(url) : 'unknown';

    // Log error details (sanitized)
    this.logError({
      status,
      message: responseMessage,
      url: sanitizedUrl,
      method,
      operation,
      config: this.verbose ? sanitizedConfig : undefined,
      responseData: this.verbose ? sanitizeBody(error.response?.data) : undefined
    });

    // Create user-friendly error message
    const userMessage = this.createUserMessage(status, responseMessage, operation);

    throw new ApiError({
      message: userMessage,
      status,
      platform: this.platform,
      operation,
      details: this.verbose ? { url: sanitizedUrl, method } : undefined
    });
  }

  /**
   * Handle generic errors
   */
  handleError(error: any, operation: string): never {
    if (error.response) {
      // HTTP error
      this.handleHttpError(error, operation);
    }

    const message = sanitizeSensitiveText(error.message || 'Unknown error occurred');

    this.logError({
      message,
      operation,
      stack: this.verbose && error.stack ? sanitizeSensitiveText(error.stack) : undefined
    });

    throw new ApiError({
      message: `${this.platform} ${operation} failed: ${message}`,
      platform: this.platform,
      operation
    });
  }

  /**
   * Extract error message from various error formats
   */
  private extractErrorMessage(error: any): string {
    // Try different error message locations
    const candidates = [
      error.response?.data?.message,
      error.response?.data?.error?.message,
      error.response?.data?.error,
      error.response?.data?.detail,
      error.response?.statusText,
      error.message
    ];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'string') {
        return candidate;
      }
    }

    return 'Unknown error';
  }

  /**
   * Create user-friendly error message
   */
  private createUserMessage(status: number | undefined, message: string, operation: string): string {
    const statusDesc = status ? HTTP_ERROR_CODES[status as keyof typeof HTTP_ERROR_CODES] : '';
    
    // Platform-specific messages
    if (status === 401) {
      return `${this.platform}: Invalid or missing API key. Please check your credentials.`;
    }
    if (status === 403) {
      return `${this.platform}: Access forbidden. This may be due to rate limiting or insufficient permissions.`;
    }
    if (status === 404) {
      return `${this.platform}: Resource not found. The requested item may not exist.`;
    }
    if (status === 429) {
      return `${this.platform}: Rate limit exceeded. Please wait before making more requests.`;
    }
    if (status && status >= 500) {
      return `${this.platform}: Server error (${status}). The service may be temporarily unavailable.`;
    }

    // Generic message
    const prefix = `${this.platform} ${operation} failed`;
    const statusInfo = status ? ` (${status}${statusDesc ? ': ' + statusDesc : ''})` : '';
    return `${prefix}${statusInfo}: ${maskSensitiveData(sanitizeSensitiveText(message))}`;
  }

  /**
   * Sanitize URL for logging
   */
  private sanitizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      urlObj.username = '';
      urlObj.password = '';
      for (const [key] of urlObj.searchParams) {
        const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
        if (normalizedKey.includes('apikey') || normalizedKey.includes('token') ||
            normalizedKey.includes('secret') || normalizedKey.includes('auth') ||
            normalizedKey.includes('session') || normalizedKey.includes('jwt') ||
            normalizedKey.includes('sso') || normalizedKey.includes('saml') || normalizedKey === 'key') {
          urlObj.searchParams.set(key, '***');
        }
      }
      return urlObj.toString();
    } catch {
      return '***sanitized-url***';
    }
  }

  /**
   * Log error with consistent format
   */
  private logError(details: Record<string, any>): void {
    loggerError(`[${this.platform}] Error:`, {
      timestamp: new Date().toISOString(),
      ...details
    });
  }

  /**
   * Check if an error is retryable
   */
  static isRetryable(error: any): boolean {
    if (error instanceof ApiError) {
      return error.retryable;
    }
    const status = error.response?.status;
    if (!status) return true;
    return [408, 429, 500, 502, 503, 504].includes(status);
  }

  /**
   * Get suggested retry delay based on error
   */
  static getRetryDelay(error: any, attempt: number = 1): number {
    const status = error.response?.status || error.status;

    // For rate limiting, check Retry-After header
    if (status === 429) {
      const retryAfter = error.response?.headers?.['retry-after'];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          return seconds * 1000;
        }
      }
      // Default: exponential backoff for rate limits
      return Math.min(60000, 1000 * Math.pow(2, attempt));
    }

    // For server errors, use exponential backoff
    if (status && status >= 500) {
      return Math.min(30000, 1000 * Math.pow(2, attempt));
    }

    // Default delay
    return 1000 * attempt;
  }

  /**
   * Retry a function with exponential backoff and full jitter
   */
  static async retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryWithBackoffOptions = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      initialDelayMs = 1000,
      maxDelayMs = 30000,
      context = 'operation',
      signal,
      sleep = sleepWithAbort,
      random = Math.random,
      shouldRetry = (error: unknown) => ErrorHandler.isRetryable(error),
      onRetry
    } = options;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      throwIfAborted(signal);
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;

        if (signal?.aborted) {
          // Retrieval providers attach identity/billing to cancellation errors;
          // keep those observations when the linked signal aborts after the
          // attempt has already produced its terminal error.
          if (isAbortAwareError(error)) throw error;
          throw createAbortError();
        }
        if (attempt >= maxRetries || !shouldRetry(error, attempt)) {
          throw error;
        }

        // Exponential backoff with full jitter. Existing callers retain the
        // previous defaults; retrieval callers inject their own bounded values.
        const baseDelay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
        const boundedRandom = Math.min(1, Math.max(0, Number(random()) || 0));
        const jitteredDelay = Math.floor(boundedRandom * baseDelay);

        logDebug(`[Retry] ${context} attempt ${attempt + 1}/${maxRetries} failed, retrying in ${jitteredDelay}ms`);
        onRetry?.(error, attempt, jitteredDelay);
        await waitForRetry(sleep, jitteredDelay, signal);
      }
    }

    throw lastError;
  }
}

function isAbortAwareError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'cancelled' || code === 'timeout';
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

async function waitForRetry(
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => sleep(milliseconds, signal))
      .then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
  });
}

function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, milliseconds));
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export default ErrorHandler;
