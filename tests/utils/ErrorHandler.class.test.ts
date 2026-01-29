/**
 * ErrorHandler Unit Tests
 * Tests for unified error handling, retry logic, and error classification
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ErrorHandler, ApiError, HTTP_ERROR_CODES } from '../../src/utils/ErrorHandler.js';

describe('ErrorHandler', () => {
  let errorHandler: ErrorHandler;

  beforeEach(() => {
    errorHandler = new ErrorHandler('TestPlatform', false);
  });

  describe('ApiError', () => {
    it('should create error with all properties', () => {
      const error = new ApiError({
        message: 'Test error',
        status: 401,
        platform: 'TestPlatform',
        operation: 'search'
      });

      expect(error.message).toBe('Test error');
      expect(error.status).toBe(401);
      expect(error.platform).toBe('TestPlatform');
      expect(error.operation).toBe('search');
      expect(error.timestamp).toBeDefined();
      expect(error.name).toBe('ApiError');
    });

    it('should mark 401/403 as non-retryable', () => {
      const error401 = new ApiError({
        message: 'Unauthorized',
        status: 401,
        platform: 'Test',
        operation: 'search'
      });
      expect(error401.retryable).toBe(false);

      const error403 = new ApiError({
        message: 'Forbidden',
        status: 403,
        platform: 'Test',
        operation: 'search'
      });
      expect(error403.retryable).toBe(false);
    });

    it('should mark 429/5xx as retryable', () => {
      const error429 = new ApiError({
        message: 'Rate limited',
        status: 429,
        platform: 'Test',
        operation: 'search'
      });
      expect(error429.retryable).toBe(true);

      const error500 = new ApiError({
        message: 'Server error',
        status: 500,
        platform: 'Test',
        operation: 'search'
      });
      expect(error500.retryable).toBe(true);

      const error503 = new ApiError({
        message: 'Service unavailable',
        status: 503,
        platform: 'Test',
        operation: 'search'
      });
      expect(error503.retryable).toBe(true);
    });

    it('should serialize to JSON correctly', () => {
      const error = new ApiError({
        message: 'Test',
        status: 400,
        platform: 'Test',
        operation: 'search'
      });

      const json = error.toJSON();
      expect(json.name).toBe('ApiError');
      expect(json.message).toBe('Test');
      expect(json.status).toBe(400);
      expect(json.platform).toBe('Test');
      expect(json.operation).toBe('search');
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('HTTP_ERROR_CODES', () => {
    it('should have descriptions for common HTTP errors', () => {
      expect(HTTP_ERROR_CODES[400]).toContain('Bad Request');
      expect(HTTP_ERROR_CODES[401]).toContain('Unauthorized');
      expect(HTTP_ERROR_CODES[403]).toContain('Forbidden');
      expect(HTTP_ERROR_CODES[404]).toContain('Not Found');
      expect(HTTP_ERROR_CODES[429]).toContain('Too Many Requests');
      expect(HTTP_ERROR_CODES[500]).toContain('Internal Server Error');
      expect(HTTP_ERROR_CODES[503]).toContain('Service Unavailable');
    });
  });

  describe('ErrorHandler.isRetryable', () => {
    it('should return true for network errors', () => {
      const error = { code: 'ECONNRESET' };
      expect(ErrorHandler.isRetryable(error)).toBe(true);
    });

    it('should return true for 5xx errors', () => {
      const error = { response: { status: 500 } };
      expect(ErrorHandler.isRetryable(error)).toBe(true);
    });

    it('should return true for 429 rate limit', () => {
      const error = { response: { status: 429 } };
      expect(ErrorHandler.isRetryable(error)).toBe(true);
    });

    it('should return false for 4xx client errors', () => {
      const error400 = { response: { status: 400 } };
      expect(ErrorHandler.isRetryable(error400)).toBe(false);

      const error401 = { response: { status: 401 } };
      expect(ErrorHandler.isRetryable(error401)).toBe(false);

      const error404 = { response: { status: 404 } };
      expect(ErrorHandler.isRetryable(error404)).toBe(false);
    });

    it('should handle ApiError instances', () => {
      const retryableError = new ApiError({
        message: 'Server error',
        status: 500,
        platform: 'Test',
        operation: 'search'
      });
      expect(ErrorHandler.isRetryable(retryableError)).toBe(true);

      const nonRetryableError = new ApiError({
        message: 'Bad request',
        status: 400,
        platform: 'Test',
        operation: 'search'
      });
      expect(ErrorHandler.isRetryable(nonRetryableError)).toBe(false);
    });
  });

  describe('ErrorHandler.getRetryDelay', () => {
    it('should return exponential backoff for server errors', () => {
      const error = { response: { status: 500 } };
      
      const delay1 = ErrorHandler.getRetryDelay(error, 1);
      const delay2 = ErrorHandler.getRetryDelay(error, 2);
      const delay3 = ErrorHandler.getRetryDelay(error, 3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
    });

    it('should respect Retry-After header for 429', () => {
      const error = {
        response: {
          status: 429,
          headers: { 'retry-after': '5' }
        }
      };

      const delay = ErrorHandler.getRetryDelay(error, 1);
      expect(delay).toBe(5000); // 5 seconds in ms
    });

    it('should cap maximum delay', () => {
      const error = { response: { status: 500 } };
      const delay = ErrorHandler.getRetryDelay(error, 10);
      expect(delay).toBeLessThanOrEqual(60000); // Max 60 seconds
    });
  });

  describe('handleHttpError', () => {
    it('should throw ApiError for HTTP errors', () => {
      const mockError = {
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: { message: 'Invalid API key' }
        },
        config: {
          url: 'https://api.example.com/search',
          method: 'get'
        }
      };

      expect(() => errorHandler.handleHttpError(mockError, 'search')).toThrow(ApiError);
    });

    it('should include platform name in error message', () => {
      const mockError = {
        response: {
          status: 404,
          data: { message: 'Not found' }
        },
        config: { url: 'https://api.example.com' }
      };

      try {
        errorHandler.handleHttpError(mockError, 'search');
      } catch (error) {
        expect((error as ApiError).platform).toBe('TestPlatform');
      }
    });
  });
});
