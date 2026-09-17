import type {
  BenchmarkCellResult,
  BenchmarkClass,
  BenchmarkClassMetrics,
  BenchmarkExecutionResult,
  BenchmarkMetrics,
  BenchmarkReason,
  BenchmarkStage,
  BenchmarkOutcome,
  BenchmarkPdfVerification,
  BenchmarkMatch,
  BenchmarkSessionState
} from './types.js';

const STAGES: readonly BenchmarkStage[] = [
  'configuration', 'input', 'initialization', 'public_network', 'sensitive_target',
  'origin_redirect', 'queue', 'budget', 'dispatch', 'response', 'parse', 'candidate',
  'pdf', 'report', 'unknown'
];
const REASONS: readonly BenchmarkReason[] = [
  'pricing_unknown', 'request_cost_limit', 'operation_budget_exceeded', 'reservation_contended',
  'actual_cost_exceeded', 'unknown_cost', 'not_authorized', 'provider_unavailable',
  'restricted_target', 'restricted_page', 'candidate_limit', 'target_not_found', 'no_candidate',
  'target_status_unknown', 'challenge', 'parse_failed', 'target_failed', 'scope_exhausted',
  'run_limit', 'run_in_use', 'not_run', 'identity_mismatch', 'none', 'unknown'
];
const OUTCOMES: readonly BenchmarkOutcome[] = ['success', 'failed', 'blocked', 'not_run'];
const MATCHES: readonly BenchmarkMatch[] = ['matched', 'mismatched', 'not_evaluated'];
const PDF_STATES: readonly BenchmarkPdfVerification[] = ['verified', 'failed', 'not_requested', 'not_run'];
const SESSION_STATES: readonly BenchmarkSessionState[] = ['cold', 'warm', 'not_applicable', 'unknown'];

export function validateBenchmarkExecutionResult(value: unknown): BenchmarkExecutionResult {
  if (!isRecord(value)) throw new Error('Benchmark cell result must be an object');
  assertEnum(value.outcome, OUTCOMES, 'outcome');
  assertEnum(value.stage, STAGES, 'stage');
  assertEnum(value.reason, REASONS, 'reason');
  assertEnum(value.match, MATCHES, 'match');
  assertEnum(value.pdfVerification, PDF_STATES, 'pdfVerification');
  assertEnum(value.localSessionState, SESSION_STATES, 'localSessionState');
  assertSafeInteger(value.httpDispatchCount, 'httpDispatchCount');
  assertSafeInteger(value.serviceAttemptCount, 'serviceAttemptCount');
  assertSafeInteger(value.elapsedMs, 'elapsedMs');
  assertSafeInteger(value.admissionUsed, 'admissionUsed');
  assertOptionalStatus(value.apiStatus, 'apiStatus');
  assertOptionalStatus(value.targetStatus, 'targetStatus');
  if (value.reportedCredits !== null && !isSafeNonnegativeInteger(value.reportedCredits)) {
    throw new Error('reportedCredits must be null or a non-negative safe integer');
  }
  if (value.costKnown !== null && typeof value.costKnown !== 'boolean') throw new Error('costKnown must be boolean or null');
  return value as BenchmarkExecutionResult;
}

export function calculateBenchmarkMetrics(cells: readonly BenchmarkCellResult[]): BenchmarkMetrics {
  return {
    publisher: calculateClassMetrics(cells, 'publisher'),
    scholar: calculateClassMetrics(cells, 'scholar')
  };
}

export function calculateClassMetrics(
  cells: readonly BenchmarkCellResult[],
  sampleKind: BenchmarkClass
): BenchmarkClassMetrics {
  const production = cells.filter(cell => cell.mode === 'production' && cell.sampleKind === sampleKind);
  const perRoundPlanned = sampleKind === 'publisher' ? 20 : 10;
  const planned = perRoundPlanned * 2;
  const successes = production.filter(isBusinessSuccess);
  const completed = production.filter(cell => cell.outcome !== 'not_run').length;
  const costKnown = production.length > 0 && production.every(cell => cell.costKnown === true && cell.reportedCredits !== null);
  const reportedCredits = costKnown
    ? sumSafe(production.map(cell => cell.reportedCredits as number))
    : null;
  const p95Ms = successes.length === 0 ? null : nearestRank(successes.map(cell => cell.elapsedMs), 0.95);
  const averageCreditsPerSuccess = reportedCredits === null || successes.length === 0
    ? null
    : reportedCredits / successes.length;
  const rounds = ([0, 1] as const).map(round => {
    const roundCells = production.filter(cell => cell.round === round);
    const roundPlanned = perRoundPlanned;
    const roundSuccesses = roundCells.filter(isBusinessSuccess).length;
    const successRate = roundSuccesses / roundPlanned;
    return {
      round,
      planned: roundPlanned,
      successes: roundSuccesses,
      successRate,
      passed: roundCells.length === roundPlanned && roundSuccesses >= Math.ceil(roundPlanned * 0.8)
    };
  });
  const costLimit = sampleKind === 'publisher' ? 50 : 200;
  const passed = production.length === planned
    && rounds.every(round => round.passed)
    && successes.length >= Math.ceil(planned * 0.8)
    && p95Ms !== null
    && p95Ms <= 90_000
    && costKnown
    && averageCreditsPerSuccess !== null
    && averageCreditsPerSuccess <= costLimit;
  return {
    planned,
    completed,
    successes: successes.length,
    successRate: successes.length / planned,
    p95Ms,
    averageCreditsPerSuccess,
    reportedCredits,
    costKnown,
    passed,
    rounds
  };
}

export function nearestRank(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1];
}

export function determineBenchmarkStatus(
  mode: 'offline' | 'live',
  metrics: BenchmarkMetrics,
  cells: readonly BenchmarkCellResult[],
  prerequisitesReady = true,
  runCostKnown = true,
  runSafetyClosed = false
): 'offline_passed' | 'live_passed' | 'failed' | 'blocked' | 'incomplete' {
  if (!prerequisitesReady) return 'blocked';
  // Unknown billing is an external observation, not a coverage gap. The
  // class metrics retain costKnown=false/null for qualification reporting;
  // only unexecuted cells or an actual safety closure make coverage incomplete.
  if (runSafetyClosed || cells.some(cell => cell.outcome === 'not_run')) return 'incomplete';
  if (metrics.publisher.passed && metrics.scholar.passed) {
    // A complete run with an unreconciled charge is evaluated, but cannot be
    // accepted as a cost-qualified pass. Keep this distinct from incomplete:
    // every planned cell may still have a real outcome.
    if (!runCostKnown) return 'failed';
    return mode === 'offline' ? 'offline_passed' : 'live_passed';
  }
  return 'failed';
}

export function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!isSafeNonnegativeInteger(value)) throw new Error(`${label} must be a non-negative safe integer`);
}

export function assertOptionalStatus(value: unknown, label: string): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 599) {
    throw new Error(`${label} must be null or an HTTP status from 100 to 599`);
  }
}

function isBusinessSuccess(cell: BenchmarkCellResult): boolean {
  if (cell.outcome !== 'success' || cell.match !== 'matched') return false;
  return cell.sampleKind !== 'publisher' || cell.mode !== 'production' || cell.pdfVerification === 'verified';
}

function sumSafe(values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new Error('Benchmark credits exceed safe integer range');
  return result;
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} is not a supported benchmark enum value`);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
