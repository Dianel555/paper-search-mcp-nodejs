import { RetrievalError, type RetrievalErrorCode, type RetrievalStrategy } from './types.js';

export interface RetrievalRetryConfiguration {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
}

/** Retry classification for one retrieval strategy; it never changes strategy. */
export class RetrievalRetryPolicy {
  readonly strategy: RetrievalStrategy;
  private readonly configuration: RetrievalRetryConfiguration;

  constructor(strategy: RetrievalStrategy) {
    this.strategy = strategy;
    this.configuration = strategy === 'browser'
      ? { maxRetries: 0, initialDelayMs: 250, maxDelayMs: 8000, factor: 2 }
      : { maxRetries: 2, initialDelayMs: 250, maxDelayMs: 8000, factor: 2 };
  }

  options(): RetrievalRetryConfiguration {
    return { ...this.configuration };
  }

  shouldRetry(error: unknown): boolean {
    if (this.strategy === 'browser') return false;
    if (error instanceof RetrievalError) {
      return error.retryable && RETRYABLE_CODES.has(error.code);
    }
    const candidate = error as { retryable?: unknown } | undefined;
    return candidate?.retryable === true;
  }
}

const RETRYABLE_CODES = new Set<RetrievalErrorCode>([
  'concurrency_limited',
  'detected',
  'server_error',
  'network'
]);

export default RetrievalRetryPolicy;
