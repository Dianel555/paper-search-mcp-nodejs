import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ErrorHandler } from '../../src/utils/ErrorHandler.js';

describe('ErrorHandler.retryWithBackoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should succeed on first attempt without retrying', async () => {
    const mockFn = jest.fn().mockResolvedValue('success');

    const result = await ErrorHandler.retryWithBackoff(mockFn, { maxRetries: 3 });

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should retry on 429 (rate limit) errors', async () => {
    const error = {
      response: { status: 429 },
      status: 429
    };

    const mockFn = jest.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const result = await ErrorHandler.retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 10
    });

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should retry on 503 (service unavailable) errors', async () => {
    const error = {
      response: { status: 503 },
      status: 503
    };

    const mockFn = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const result = await ErrorHandler.retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 10
    });

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should retry on 504 (gateway timeout) errors', async () => {
    const error = {
      response: { status: 504 },
      status: 504
    };

    const mockFn = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const result = await ErrorHandler.retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 10
    });

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on 400 (bad request) errors', async () => {
    const error = {
      response: { status: 400 },
      status: 400
    };

    const mockFn = jest.fn().mockRejectedValue(error);

    await expect(
      ErrorHandler.retryWithBackoff(mockFn, { maxRetries: 3 })
    ).rejects.toEqual(error);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on 401 (unauthorized) errors', async () => {
    const error = {
      response: { status: 401 },
      status: 401
    };

    const mockFn = jest.fn().mockRejectedValue(error);

    await expect(
      ErrorHandler.retryWithBackoff(mockFn, { maxRetries: 3 })
    ).rejects.toEqual(error);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on 403 (forbidden) errors', async () => {
    const error = {
      response: { status: 403 },
      status: 403
    };

    const mockFn = jest.fn().mockRejectedValue(error);

    await expect(
      ErrorHandler.retryWithBackoff(mockFn, { maxRetries: 3 })
    ).rejects.toEqual(error);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on 404 (not found) errors', async () => {
    const error = {
      response: { status: 404 },
      status: 404
    };

    const mockFn = jest.fn().mockRejectedValue(error);

    await expect(
      ErrorHandler.retryWithBackoff(mockFn, { maxRetries: 3 })
    ).rejects.toEqual(error);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('should respect max retries limit', async () => {
    const error = {
      response: { status: 429 },
      status: 429
    };

    const mockFn = jest.fn().mockRejectedValue(error);

    await expect(
      ErrorHandler.retryWithBackoff(mockFn, {
        maxRetries: 2,
        initialDelayMs: 10
      })
    ).rejects.toEqual(error);

    // Should be called: initial + 2 retries = 3 times
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should use exponential backoff with jitter', async () => {
    const error = {
      response: { status: 429 },
      status: 429
    };

    const mockFn = jest.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('success');

    const startTime = Date.now();

    await ErrorHandler.retryWithBackoff(mockFn, {
      maxRetries: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000
    });

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    // Should have some delay (at least 50ms total for 2 retries with jitter)
    expect(totalTime).toBeGreaterThan(50);
    expect(mockFn).toHaveBeenCalledTimes(3);
  });
});