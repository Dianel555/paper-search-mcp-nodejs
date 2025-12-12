/**
 * Unified Error Handler for API requests
 * Provides consistent error handling across all platforms
 */

import { sanitizeRequest, maskSensitiveData } from './SecurityUtils.js';
import { logError as loggerError } from './Logger.js';

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
    const responseMessage = this.extractErrorMessage(error);
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
      responseData: this.verbose ? error.response?.data : undefined
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

    const message = error.message || 'Unknown error occurred';
    
    this.logError({
      message,
      operation,
      stack: this.verbose ? error.stack : undefined
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
    return `${prefix}${statusInfo}: ${maskSensitiveData(message)}`;
  }

  /**
   * Sanitize URL for logging
   */
  private sanitizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Remove sensitive query parameters
      const sensitiveParams = ['api_key', 'apikey', 'key', 'token', 'secret', 'auth'];
      sensitiveParams.forEach(param => {
        if (urlObj.searchParams.has(param)) {
          urlObj.searchParams.set(param, '***');
        }
      });
      return urlObj.toString();
    } catch {
      // If URL parsing fails, mask the entire thing
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
}

export default ErrorHandler;
