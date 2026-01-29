import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RateLimiter } from '../../utils/RateLimiter.js';
import { ErrorHandler } from '../../utils/ErrorHandler.js';

describe('Rate Limiting Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('RateLimiter with retry logic integration', () => {
    it('should allow requests within rate limit without delay', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 10,
        burstCapacity: 10
      });

      const startTime = Date.now();

      // Make 5 requests quickly - should all pass immediately
      await Promise.all([
        rateLimiter.waitForPermission(),
        rateLimiter.waitForPermission(),
        rateLimiter.waitForPermission(),
        rateLimiter.waitForPermission(),
        rateLimiter.waitForPermission()
      ]);

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete very quickly (< 100ms)
      expect(duration).toBeLessThan(100);

      const status = rateLimiter.getStatus();
      expect(status.availableTokens).toBe(5);
      expect(status.pendingRequests).toBe(0);

      rateLimiter.dispose();
    });

    it('should queue requests when rate limit exceeded', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 2,
        burstCapacity: 2
      });

      const results: number[] = [];

      // Make 4 requests - first 2 should pass immediately, next 2 should queue
      const promises = [
        rateLimiter.waitForPermission().then(() => results.push(1)),
        rateLimiter.waitForPermission().then(() => results.push(2)),
        rateLimiter.waitForPermission().then(() => results.push(3)),
        rateLimiter.waitForPermission().then(() => results.push(4))
      ];

      await Promise.all(promises);

      expect(results).toHaveLength(4);

      rateLimiter.dispose();
    });

    it('should integrate with ErrorHandler retry logic', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 5,
        burstCapacity: 5
      });

      let attemptCount = 0;

      const mockApiCall = async () => {
        await rateLimiter.waitForPermission();
        attemptCount++;

        if (attemptCount < 3) {
          throw { response: { status: 429 }, status: 429 };
        }

        return 'success';
      };

      const result = await ErrorHandler.retryWithBackoff(mockApiCall, {
        maxRetries: 5,
        initialDelayMs: 50
      });

      expect(result).toBe('success');
      expect(attemptCount).toBe(3);

      rateLimiter.dispose();
    });

    it('should respect max retries when 429 persists', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 5,
        burstCapacity: 5
      });

      let attemptCount = 0;

      const mockApiCall = async () => {
        await rateLimiter.waitForPermission();
        attemptCount++;
        throw { response: { status: 429 }, status: 429 };
      };

      await expect(
        ErrorHandler.retryWithBackoff(mockApiCall, {
          maxRetries: 3,
          initialDelayMs: 10
        })
      ).rejects.toMatchObject({
        response: { status: 429 }
      });

      // Should be called: initial + 3 retries = 4 times
      expect(attemptCount).toBe(4);

      rateLimiter.dispose();
    });

    it('should not retry on non-retriable errors', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 5,
        burstCapacity: 5
      });

      let attemptCount = 0;

      const mockApiCall = async () => {
        await rateLimiter.waitForPermission();
        attemptCount++;
        throw { response: { status: 404 }, status: 404 };
      };

      await expect(
        ErrorHandler.retryWithBackoff(mockApiCall, {
          maxRetries: 3,
          initialDelayMs: 10
        })
      ).rejects.toMatchObject({
        response: { status: 404 }
      });

      // Should only be called once (no retries for 404)
      expect(attemptCount).toBe(1);

      rateLimiter.dispose();
    });

    it('should handle concurrent requests with rate limiting', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 3,
        burstCapacity: 3
      });

      const results: string[] = [];
      let requestCount = 0;

      const mockApiCall = async (id: string) => {
        await rateLimiter.waitForPermission();
        requestCount++;
        results.push(id);
        return id;
      };

      // Launch 6 concurrent requests
      const promises = [
        mockApiCall('req1'),
        mockApiCall('req2'),
        mockApiCall('req3'),
        mockApiCall('req4'),
        mockApiCall('req5'),
        mockApiCall('req6')
      ];

      await Promise.all(promises);

      expect(results).toHaveLength(6);
      expect(requestCount).toBe(6);

      rateLimiter.dispose();
    });

    it('should recover from transient 503 errors', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 5,
        burstCapacity: 5
      });

      let attemptCount = 0;

      const mockApiCall = async () => {
        await rateLimiter.waitForPermission();
        attemptCount++;

        if (attemptCount === 1) {
          throw { response: { status: 503 }, status: 503 };
        }

        return 'success';
      };

      const result = await ErrorHandler.retryWithBackoff(mockApiCall, {
        maxRetries: 3,
        initialDelayMs: 10
      });

      expect(result).toBe('success');
      expect(attemptCount).toBe(2);

      rateLimiter.dispose();
    });

    it('should recover from transient 504 errors', async () => {
      const rateLimiter = new RateLimiter({
        requestsPerSecond: 5,
        burstCapacity: 5
      });

      let attemptCount = 0;

      const mockApiCall = async () => {
        await rateLimiter.waitForPermission();
        attemptCount++;

        if (attemptCount === 1) {
          throw { response: { status: 504 }, status: 504 };
        }

        return 'success';
      };

      const result = await ErrorHandler.retryWithBackoff(mockApiCall, {
        maxRetries: 3,
        initialDelayMs: 10
      });

      expect(result).toBe('success');
      expect(attemptCount).toBe(2);

      rateLimiter.dispose();
    });
  });
});