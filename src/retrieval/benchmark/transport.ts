import type { RunReservation } from './admission.js';
import type {
  BenchmarkAttempt,
  BenchmarkCell,
  BenchmarkCellCombination,
  BenchmarkSample,
  BenchmarkSessionState
} from './types.js';

/**
 * The benchmark's only network seam. Production adapters may wrap the real
 * retrieval providers; offline tests inject a deterministic implementation.
 * The transport must call `start` exactly when it is about to submit bytes.
 */
export interface BenchmarkTransportRequest {
  readonly cell: BenchmarkCell;
  readonly sample: BenchmarkSample;
  readonly role: BenchmarkAttempt['role'];
  readonly estimatedCredits: number;
  readonly signal: AbortSignal;
}

export interface BenchmarkTransportDispatch {
  readonly attemptId: string;
  readonly reservation?: RunReservation;
}

export type BenchmarkTransportDispatchStarter = (estimatedCredits: number) => BenchmarkTransportDispatch;

export interface BenchmarkTransportResponse {
  readonly apiStatus?: number | null;
  readonly targetStatus?: number | null;
  readonly candidateUrl?: string;
  readonly scholarIdentity?: {
    readonly doi?: string;
    readonly title: string;
  };
  readonly body?: string | Uint8Array;
  readonly reportedCredits?: number | null;
  readonly localSessionState?: BenchmarkSessionState;
}

export interface BenchmarkTransport {
  /** Prevent a fixture transport from being used for a live campaign. */
  readonly offlineOnly?: boolean;
  dispatch(
    request: BenchmarkTransportRequest,
    start: BenchmarkTransportDispatchStarter
  ): Promise<BenchmarkTransportResponse>;
}

export interface BenchmarkCellPricing {
  (cell: BenchmarkCell, role: BenchmarkAttempt['role']): number;
}

/**
 * A response-only fixture transport. It deliberately contains no admission or
 * report logic: the runner owns those controls and observes this transport's
 * actual dispatch callback.
 */
export class OfflineBenchmarkTransport implements BenchmarkTransport {
  readonly offlineOnly = true as const;

  async dispatch(
    request: BenchmarkTransportRequest,
    start: BenchmarkTransportDispatchStarter
  ): Promise<BenchmarkTransportResponse> {
    if (request.signal.aborted) throw new Error('offline benchmark transport was cancelled');
    start(request.estimatedCredits);
    if (request.role === 'pdf') {
      return {
        apiStatus: 200,
        targetStatus: 200,
        body: Buffer.from('%PDF-1.7\\noffline benchmark fixture', 'utf8'),
        reportedCredits: request.estimatedCredits
      };
    }
    if (request.sample.kind === 'publisher') {
      return {
        apiStatus: 200,
        targetStatus: 200,
        candidateUrl: request.sample.candidateUrls[0],
        body: '<html><body>offline publisher fixture</body></html>',
        reportedCredits: request.estimatedCredits
      };
    }
    return {
      apiStatus: 200,
      targetStatus: 200,
      scholarIdentity: {
        doi: request.sample.expected.doi,
        title: request.sample.expected.title
      },
      body: '<html><body>offline scholar fixture</body></html>',
      reportedCredits: request.estimatedCredits
    };
  }
}

export function offlineBenchmarkPricing(cell: BenchmarkCell, role: BenchmarkAttempt['role']): number {
  if (role === 'init' || role === 'doi' || role === 'redirect' || role === 'pdf') return 0;
  switch (cell.combination as BenchmarkCellCombination) {
    case 'static:datacenter': return 1;
    case 'browser:datacenter': return 10;
    case 'static:residential': return 25;
    case 'browser:residential': return 125;
    case 'direct':
    case 'production':
      return 0;
  }
}
