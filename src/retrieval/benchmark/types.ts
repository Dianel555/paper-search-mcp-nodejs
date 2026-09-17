import type { RetrievalFailureKind } from '../types.js';

export const BENCHMARK_SCHEMA_VERSION = 1 as const;
export const BENCHMARK_PUBLISHER_SAMPLES = 20 as const;
export const BENCHMARK_SCHOLAR_SAMPLES = 10 as const;
export const BENCHMARK_ROUNDS = 2 as const;
export const BENCHMARK_STRATEGIES = [
  'direct',
  'static:datacenter',
  'browser:datacenter',
  'static:residential',
  'browser:residential'
] as const;

export type BenchmarkClass = 'publisher' | 'scholar';
export type BenchmarkMode = 'production' | 'comparison';
export type BenchmarkCombination = typeof BENCHMARK_STRATEGIES[number];
export type BenchmarkProductionCombination = 'production';
export type BenchmarkCellCombination = BenchmarkCombination | BenchmarkProductionCombination;
/** A concrete strategy/proxy; production is a plan label, not a wire dispatch. */
export type BenchmarkDispatchCombination = BenchmarkCombination;
export type BenchmarkOutcome = 'success' | 'failed' | 'blocked' | 'not_run';
export type BenchmarkStage =
  | 'configuration'
  | 'input'
  | 'initialization'
  | 'public_network'
  | 'sensitive_target'
  | 'origin_redirect'
  | 'queue'
  | 'budget'
  | 'dispatch'
  | 'response'
  | 'parse'
  | 'candidate'
  | 'pdf'
  | 'report'
  | 'unknown';
export type BenchmarkReason =
  | 'pricing_unknown'
  | 'request_cost_limit'
  | 'operation_budget_exceeded'
  | 'reservation_contended'
  | 'actual_cost_exceeded'
  | 'unknown_cost'
  | 'not_authorized'
  | 'provider_unavailable'
  | 'restricted_target'
  | 'restricted_page'
  | 'candidate_limit'
  | 'target_not_found'
  | 'no_candidate'
  | 'target_status_unknown'
  | 'challenge'
  | 'parse_failed'
  | 'target_failed'
  | 'scope_exhausted'
  | 'run_limit'
  | 'run_in_use'
  | 'not_run'
  | 'identity_mismatch'
  | 'none'
  | 'unknown';
export type BenchmarkMatch = 'matched' | 'mismatched' | 'not_evaluated';
export type BenchmarkPdfVerification = 'verified' | 'failed' | 'not_requested' | 'not_run';
export type BenchmarkSessionState = 'cold' | 'warm' | 'not_applicable' | 'unknown';

export interface PublisherBenchmarkSample {
  readonly sampleId: string;
  readonly kind: 'publisher';
  readonly doi: string;
  readonly expectedDoi?: string;
  readonly expectedTitle: string;
  readonly evidenceUrl: string;
  readonly candidateUrls: readonly string[];
}

export interface ScholarBenchmarkSample {
  readonly sampleId: string;
  readonly kind: 'scholar';
  readonly query: string;
  readonly expected: {
    readonly doi?: string;
    readonly title: string;
  };
  readonly evidenceUrl: string;
}

export type BenchmarkSample = PublisherBenchmarkSample | ScholarBenchmarkSample;

export interface BenchmarkCorpus {
  readonly corpusVersion?: string;
  readonly publisher: readonly PublisherBenchmarkSample[];
  readonly scholar: readonly ScholarBenchmarkSample[];
}

export interface BenchmarkCorpusValidation {
  readonly corpus: BenchmarkCorpus;
  readonly corpusVersion: string;
  readonly publisherHosts: readonly string[];
}

export interface BenchmarkCell {
  readonly cellId: string;
  readonly sampleId: string;
  readonly sampleKind: BenchmarkClass;
  readonly round: 0 | 1;
  readonly mode: BenchmarkMode;
  readonly combination: BenchmarkCellCombination;
  readonly production: {
    readonly verifyPdf: boolean;
    readonly maxResults?: number;
  } | null;
}

export interface BenchmarkPlan {
  readonly planVersion: '1';
  readonly cells: readonly BenchmarkCell[];
}

export interface BenchmarkExecutionResult {
  readonly outcome: BenchmarkOutcome;
  readonly stage: BenchmarkStage;
  readonly reason: BenchmarkReason;
  readonly apiStatus?: number | null;
  readonly targetStatus?: number | null;
  readonly httpDispatchCount: number;
  readonly serviceAttemptCount: number;
  readonly elapsedMs: number;
  readonly admissionUsed: number;
  readonly reportedCredits: number | null;
  readonly costKnown: boolean | null;
  readonly match: BenchmarkMatch;
  readonly pdfVerification: BenchmarkPdfVerification;
  readonly localSessionState: BenchmarkSessionState;
}

export interface BenchmarkCellResult extends BenchmarkCell, BenchmarkExecutionResult {}

export interface BenchmarkAttempt {
  readonly attemptId: string;
  /** Concrete transport correlation ID; absent only in legacy reports. */
  readonly dispatchId?: string | null;
  readonly cellId: string;
  readonly role: 'doi' | 'init' | 'page' | 'redirect' | 'pdf' | 'provider_api';
  /** Frozen plan cell identity. */
  readonly combination: BenchmarkCellCombination;
  /** Concrete strategy/proxy used by this underlying dispatch. */
  readonly dispatchCombination: BenchmarkDispatchCombination;
  readonly submittedAt: string;
  /** Duration to terminal observation or bounded cancellation, not late settlement. */
  readonly elapsedMs: number;
  readonly apiStatus: number | null;
  readonly targetStatus: number | null;
  readonly reason: BenchmarkReason;
  /** Safe terminal failure phase; null means no retrieval error was observed. */
  readonly failureKind?: RetrievalFailureKind | null;
  readonly estimate: number | null;
  readonly reportedCredits: number | null;
  readonly costKnown: boolean | null;
  readonly admissionUsed: number;
}

export interface BenchmarkLimits {
  readonly credits: number;
  readonly httpDispatches: number;
  readonly elapsedMs: number;
}

export interface BenchmarkClassMetrics {
  readonly planned: number;
  readonly completed: number;
  readonly successes: number;
  readonly successRate: number | null;
  readonly p95Ms: number | null;
  readonly averageCreditsPerSuccess: number | null;
  readonly reportedCredits: number | null;
  readonly costKnown: boolean;
  readonly passed: boolean;
  readonly rounds: readonly {
    readonly round: 0 | 1;
    readonly planned: number;
    readonly successes: number;
    readonly successRate: number | null;
    readonly passed: boolean;
  }[];
}

export interface BenchmarkMetrics {
  readonly publisher: BenchmarkClassMetrics;
  readonly scholar: BenchmarkClassMetrics;
}

export interface BenchmarkReport {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly runId: string;
  readonly mode: 'offline' | 'live';
  readonly codeVersion: string;
  readonly corpusVersion: string;
  readonly configVersion: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly deadlineAt: string;
  readonly limits: BenchmarkLimits;
  readonly admissionUsed: number;
  readonly reservedCredits: number;
  readonly reportedCredits: number | null;
  readonly unknownCostAttempts: number;
  readonly httpDispatchCount: number;
  readonly runStatus: 'offline_passed' | 'live_passed' | 'failed' | 'blocked' | 'incomplete';
  readonly metrics: BenchmarkMetrics;
  readonly cells: readonly BenchmarkCellResult[];
  readonly attempts: readonly BenchmarkAttempt[];
}

export interface BenchmarkReportBundle {
  readonly report: BenchmarkReport;
  readonly json: string;
  readonly markdown: string;
}
