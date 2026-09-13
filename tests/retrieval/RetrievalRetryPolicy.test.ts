import { describe, expect, it } from '@jest/globals';
import { RetrievalError } from '../../src/retrieval/types.js';
import { RetrievalRetryPolicy } from '../../src/retrieval/RetrievalRetryPolicy.js';

describe('RetrievalRetryPolicy', () => {
  it('uses bounded static retry and never retries browser', () => {
    const staticPolicy = new RetrievalRetryPolicy('static');
    const browserPolicy = new RetrievalRetryPolicy('browser');

    expect(staticPolicy.options()).toEqual(expect.objectContaining({
      maxRetries: 2,
      initialDelayMs: 250,
      maxDelayMs: 8000
    }));
    expect(browserPolicy.options()).toEqual(expect.objectContaining({ maxRetries: 0 }));
    expect(browserPolicy.shouldRetry(new RetrievalError({
      code: 'server_error',
      message: 'safe',
      retryable: true
    }))).toBe(false);
  });

  it('does not infer a precise cause from a provider 403', () => {
    const policy = new RetrievalRetryPolicy('static');
    expect(policy.shouldRetry(new RetrievalError({
      code: 'auth_or_credits_unknown',
      message: 'provider rejected the request',
      status: 403,
      retryable: false
    }))).toBe(false);
    expect(policy.shouldRetry(new RetrievalError({
      code: 'concurrency_limited',
      message: 'safe',
      status: 409,
      retryable: true
    }))).toBe(true);
  });
});
