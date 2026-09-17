import { calculateBenchmarkMetrics, determineBenchmarkStatus, validateBenchmarkExecutionResult } from './metrics.js';
import type {
  BenchmarkAttempt,
  BenchmarkCell,
  BenchmarkCellResult,
  BenchmarkExecutionResult,
  BenchmarkLimits,
  BenchmarkPlan,
  BenchmarkReport,
  BenchmarkReportBundle
} from './types.js';
import type { BenchmarkRunSnapshot } from './admission.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = /^(?:url|query|cookie|authorization|headers?|raw(?:html|body|response)?|html|body)$/i;
const REPORT_KEYS = [
  'schemaVersion', 'runId', 'mode', 'codeVersion', 'corpusVersion', 'configVersion',
  'startedAt', 'endedAt', 'deadlineAt', 'limits', 'admissionUsed', 'reservedCredits',
  'reportedCredits', 'unknownCostAttempts', 'httpDispatchCount', 'runStatus', 'metrics',
  'cells', 'attempts'
] as const;
const CELL_KEYS = [
  'cellId', 'sampleId', 'sampleKind', 'round', 'mode', 'combination', 'production',
  'outcome', 'stage', 'reason', 'apiStatus', 'targetStatus', 'httpDispatchCount',
  'serviceAttemptCount', 'elapsedMs', 'admissionUsed', 'reportedCredits', 'costKnown',
  'match', 'pdfVerification', 'localSessionState'
] as const;
const ATTEMPT_KEYS = [
  'attemptId', 'dispatchId', 'cellId', 'role', 'combination', 'dispatchCombination', 'submittedAt', 'elapsedMs', 'apiStatus',
  'targetStatus', 'reason', 'failureKind', 'estimate', 'reportedCredits', 'costKnown', 'admissionUsed'
] as const;
const DISPATCH_ATTEMPT_KEYS = [
  'attemptId', 'dispatchId', 'cellId', 'role', 'combination', 'dispatchCombination', 'submittedAt', 'elapsedMs', 'apiStatus',
  'targetStatus', 'reason', 'estimate', 'reportedCredits', 'costKnown', 'admissionUsed'
] as const;
const FAILURE_ATTEMPT_KEYS = [
  'attemptId', 'cellId', 'role', 'combination', 'dispatchCombination', 'submittedAt', 'elapsedMs', 'apiStatus',
  'targetStatus', 'reason', 'failureKind', 'estimate', 'reportedCredits', 'costKnown', 'admissionUsed'
] as const;
const LEGACY_ATTEMPT_KEYS = [
  'attemptId', 'cellId', 'role', 'combination', 'dispatchCombination', 'submittedAt', 'elapsedMs', 'apiStatus',
  'targetStatus', 'reason', 'estimate', 'reportedCredits', 'costKnown', 'admissionUsed'
] as const;
const PRODUCTION_KEYS = ['verifyPdf', 'maxResults'] as const;
const METRIC_KEYS = [
  'planned', 'completed', 'successes', 'successRate', 'p95Ms', 'averageCreditsPerSuccess',
  'reportedCredits', 'costKnown', 'passed', 'rounds'
] as const;
const ROUND_KEYS = ['round', 'planned', 'successes', 'successRate', 'passed'] as const;

export interface BenchmarkReportOptions {
  readonly run: BenchmarkRunSnapshot;
  readonly plan: BenchmarkPlan;
  readonly corpusVersion: string;
  readonly codeVersion: string;
  readonly configVersion: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly cells?: readonly (BenchmarkCell & Partial<BenchmarkExecutionResult>)[];
  readonly attempts?: readonly BenchmarkAttempt[];
  readonly runLimits?: BenchmarkLimits;
  readonly prerequisitesReady?: boolean;
}

export function createBenchmarkReport(options: BenchmarkReportOptions): BenchmarkReport {
  const startedAt = options.startedAt || new Date(options.run.startedAt).toISOString();
  const endedAt = options.endedAt || new Date().toISOString();
  const byCell = new Map<string, Partial<BenchmarkExecutionResult>>();
  for (const result of options.cells || []) {
    if (byCell.has(result.cellId)) throw new Error(`Duplicate benchmark cell result: ${result.cellId}`);
    byCell.set(result.cellId, result);
  }
  const plannedIds = new Set(options.plan.cells.map(cell => cell.cellId));
  for (const cellId of byCell.keys()) {
    if (!plannedIds.has(cellId)) throw new Error(`Benchmark result references unknown cell: ${cellId}`);
  }
  const cells = options.plan.cells.map(cell => {
    const supplied = byCell.get(cell.cellId);
    const execution = supplied ? validateBenchmarkExecutionResult({
      outcome: supplied.outcome,
      stage: supplied.stage,
      reason: supplied.reason,
      apiStatus: supplied.apiStatus ?? null,
      targetStatus: supplied.targetStatus ?? null,
      httpDispatchCount: supplied.httpDispatchCount,
      serviceAttemptCount: supplied.serviceAttemptCount,
      elapsedMs: supplied.elapsedMs,
      admissionUsed: supplied.admissionUsed,
      reportedCredits: supplied.reportedCredits ?? null,
      costKnown: supplied.costKnown ?? null,
      match: supplied.match,
      pdfVerification: supplied.pdfVerification,
      localSessionState: supplied.localSessionState
    }) : notRunResult();
    return { ...cell, ...execution };
  });
  const metrics = calculateBenchmarkMetrics(cells);
  const runStatus = determineBenchmarkStatus(
    options.run.mode,
    metrics,
    cells,
    options.prerequisitesReady !== false,
    options.run.reportedCostKnown,
    options.run.paidClosed
  );
  const report: BenchmarkReport = {
    schemaVersion: 1,
    runId: options.run.runId,
    mode: options.run.mode,
    codeVersion: boundedId(options.codeVersion, 'codeVersion'),
    corpusVersion: boundedId(options.corpusVersion, 'corpusVersion'),
    configVersion: boundedId(options.configVersion, 'configVersion'),
    startedAt: boundedTimestamp(startedAt, 'startedAt'),
    endedAt: boundedTimestamp(endedAt, 'endedAt'),
    deadlineAt: new Date(options.run.deadlineAt).toISOString(),
    limits: { ...(options.runLimits || DEFAULT_REPORT_LIMITS) },
    admissionUsed: options.run.admissionUsed,
    reservedCredits: options.run.reservedCredits,
    reportedCredits: options.run.reportedCostKnown ? options.run.reportedCredits : null,
    unknownCostAttempts: options.run.unknownCostAttempts,
    httpDispatchCount: options.run.httpDispatchCount,
    runStatus,
    metrics,
    cells,
    attempts: (options.attempts || []).map(attempt => ({ ...attempt }))
  } as BenchmarkReport;
  validateBenchmarkReport(report, options.plan);
  return report;
}

export function createBenchmarkReportBundle(options: BenchmarkReportOptions): BenchmarkReportBundle {
  const report = createBenchmarkReport(options);
  const json = serializeBenchmarkReport(report);
  const markdown = renderBenchmarkMarkdown(report);
  return { report, json, markdown };
}

export function validateBenchmarkReport(report: unknown, plan?: BenchmarkPlan): asserts report is BenchmarkReport {
  if (!isRecord(report) || report.schemaVersion !== 1) throw new Error('Benchmark report schemaVersion must be 1');
  assertExactKeys(report, REPORT_KEYS, 'Benchmark report');
  assertRequiredKeys(report, REPORT_KEYS, 'Benchmark report');
  boundedId(report.runId, 'runId');
  boundedId(report.codeVersion, 'codeVersion');
  boundedId(report.corpusVersion, 'corpusVersion');
  boundedId(report.configVersion, 'configVersion');
  if (report.mode !== 'offline' && report.mode !== 'live') throw new Error('Benchmark report mode is invalid');
  boundedTimestamp(report.startedAt, 'startedAt');
  boundedTimestamp(report.endedAt, 'endedAt');
  boundedTimestamp(report.deadlineAt, 'deadlineAt');
  validateLimits(report.limits);
  for (const field of ['admissionUsed', 'reservedCredits', 'unknownCostAttempts', 'httpDispatchCount']) {
    assertSafeInteger(report[field], field);
  }
  if (report.reportedCredits !== null && !isSafeNonnegativeInteger(report.reportedCredits)) {
    throw new Error('reportedCredits must be null or a non-negative safe integer');
  }
  if (!['offline_passed', 'live_passed', 'failed', 'blocked', 'incomplete'].includes(report.runStatus)) {
    throw new Error('Benchmark report runStatus is invalid');
  }
  if (!isRecord(report.metrics)) throw new Error('Benchmark report metrics are required');
  assertExactKeys(report.metrics, ['publisher', 'scholar'], 'Benchmark metrics');
  assertRequiredKeys(report.metrics, ['publisher', 'scholar'], 'Benchmark metrics');
  validateMetrics(report.metrics);
  if (!Array.isArray(report.cells)) throw new Error('Benchmark report cells are required');
  if (!Array.isArray(report.attempts) || report.attempts.length > report.limits.httpDispatches) throw new Error('Benchmark report attempts exceed the HTTP limit');
  const cellIds = new Set<string>();
  const cellById = new Map<string, BenchmarkCellResult>();
  for (const cell of report.cells) {
    validateCellResult(cell);
    if (cellIds.has(cell.cellId)) throw new Error(`Duplicate benchmark report cell: ${cell.cellId}`);
    cellIds.add(cell.cellId);
    cellById.set(cell.cellId, cell as BenchmarkCellResult);
  }
  if (plan) {
    if (report.cells.length !== plan.cells.length) throw new Error('Benchmark report does not contain every planned cell');
    plan.cells.forEach((cell, index) => {
      const reported = report.cells[index];
      if (!reported || !sameCellMetadata(reported, cell)) throw new Error('Benchmark report cell metadata does not match the frozen plan');
    });
  }
  const attemptIds = new Set<string>();
  for (const attempt of report.attempts) {
    validateAttempt(attempt, cellById);
    if (attemptIds.has(attempt.attemptId)) throw new Error(`Duplicate benchmark attempt: ${attempt.attemptId}`);
    attemptIds.add(attempt.attemptId);
  }
  const calculatedMetrics = calculateBenchmarkMetrics(report.cells as BenchmarkCellResult[]);
  if (JSON.stringify(calculatedMetrics) !== JSON.stringify(report.metrics)) {
    throw new Error('Benchmark report metrics do not match its cells');
  }
  const cellHttpDispatches = report.cells.reduce((sum, cell) => sum + cell.httpDispatchCount, 0);
  const cellAdmission = report.cells.reduce((sum, cell) => sum + cell.admissionUsed, 0);
  if (cellHttpDispatches !== report.httpDispatchCount) {
    throw new Error('Benchmark cell HTTP counts do not match the run total');
  }
  if (cellAdmission !== report.admissionUsed) {
    throw new Error('Benchmark cell admission does not match the run total');
  }
  const attemptsByCell = new Map<string, BenchmarkAttempt[]>();
  for (const attempt of report.attempts) {
    const list = attemptsByCell.get(attempt.cellId) || [];
    list.push(attempt);
    attemptsByCell.set(attempt.cellId, list);
  }
  for (const cell of report.cells) {
    const attemptsForCell = attemptsByCell.get(cell.cellId) || [];
    if (attemptsForCell.length < cell.httpDispatchCount) {
      throw new Error(`Benchmark cell ${cell.cellId} is missing dispatch trace entries`);
    }
    const attemptAdmission = attemptsForCell.reduce((sum, attempt) => sum + attempt.admissionUsed, 0);
    if (attemptAdmission !== cell.admissionUsed) {
      throw new Error(`Benchmark cell ${cell.cellId} admission trace is inconsistent`);
    }
  }
  assertPrivacySafe(report);
  if ((report.runStatus === 'offline_passed' || report.runStatus === 'live_passed')
    && report.cells.some(cell => cell.outcome === 'not_run')) {
    throw new Error('A passed benchmark report cannot contain not_run cells');
  }
  if ((report.runStatus === 'offline_passed' || report.runStatus === 'live_passed')
    && (!report.metrics.publisher.passed || !report.metrics.scholar.passed || report.unknownCostAttempts > 0)) {
    throw new Error('A passed benchmark report does not satisfy its metrics or cost evidence');
  }
  if (report.runStatus === 'live_passed' && report.mode !== 'live') throw new Error('Offline report cannot be live_passed');
  if (report.runStatus === 'offline_passed' && report.mode !== 'offline') throw new Error('Live report cannot be offline_passed');
}

export function serializeBenchmarkReport(report: BenchmarkReport): string {
  validateBenchmarkReport(report);
  return JSON.stringify(report, null, 2);
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  validateBenchmarkReport(report);
  const lines = [
    '# Retrieval benchmark report',
    '',
    `- Run: \`${report.runId}\``,
    `- Mode: \`${report.mode}\``,
    `- Status: \`${report.runStatus}\``,
    `- Corpus version: \`${report.corpusVersion}\``,
    `- Code version: \`${report.codeVersion}\``,
    `- Config version: \`${report.configVersion}\``,
    `- HTTP dispatches: ${report.httpDispatchCount}/${report.limits.httpDispatches}`,
    `- Admission used: ${report.admissionUsed}/${report.limits.credits}`,
    '',
    '| Class | Planned | Successes | Success rate | P95 ms | Avg credits/success | Cost known | Passed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    metricRow('Publisher', report.metrics.publisher),
    metricRow('Scholar', report.metrics.scholar),
    '',
    '| Cell | Round | Mode | Combination | Outcome | Stage | Reason | Match | PDF |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const cell of report.cells) {
    lines.push(`| ${cell.cellId} | ${cell.round} | ${cell.mode} | ${cell.combination} | ${cell.outcome} | ${cell.stage} | ${cell.reason} | ${cell.match} | ${cell.pdfVerification} |`);
  }
  return `${lines.join('\n')}\n`;
}

function notRunResult(): BenchmarkExecutionResult {
  return {
    outcome: 'not_run',
    stage: 'report',
    reason: 'not_run',
    apiStatus: null,
    targetStatus: null,
    httpDispatchCount: 0,
    serviceAttemptCount: 0,
    elapsedMs: 0,
    admissionUsed: 0,
    reportedCredits: null,
    costKnown: null,
    match: 'not_evaluated',
    pdfVerification: 'not_run',
    localSessionState: 'unknown'
  };
}

function validateCellResult(cell: unknown): void {
  if (!isRecord(cell)) throw new Error('Benchmark report cell must be an object');
  assertExactKeys(cell, CELL_KEYS, 'Benchmark report cell');
  assertRequiredKeys(cell, CELL_KEYS, 'Benchmark report cell');
  boundedId(cell.cellId, 'cellId');
  boundedId(cell.sampleId, 'sampleId');
  if (cell.sampleKind !== 'publisher' && cell.sampleKind !== 'scholar') throw new Error('Benchmark cell sampleKind is invalid');
  if (cell.round !== 0 && cell.round !== 1) throw new Error('Benchmark cell round is invalid');
  if (cell.mode !== 'production' && cell.mode !== 'comparison') throw new Error('Benchmark cell mode is invalid');
  if (cell.combination !== 'production' && !['direct', 'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'].includes(cell.combination)) {
    throw new Error('Benchmark cell combination is invalid');
  }
  if (cell.production !== null) {
    if (!isRecord(cell.production)) throw new Error('Benchmark cell production config is invalid');
    assertExactKeys(cell.production, PRODUCTION_KEYS, 'Benchmark cell production config');
    assertRequiredKeys(cell.production, ['verifyPdf'], 'Benchmark cell production config');
    if (typeof cell.production.verifyPdf !== 'boolean') throw new Error('Benchmark cell verifyPdf must be boolean');
    if (cell.production.maxResults !== undefined && (!Number.isSafeInteger(cell.production.maxResults) || cell.production.maxResults < 1 || cell.production.maxResults > 100)) {
      throw new Error('Benchmark cell maxResults is invalid');
    }
  }
  if (cell.mode === 'comparison' && cell.production !== null) throw new Error('Comparison cells cannot contain production configuration');
  if (cell.mode === 'production' && cell.production === null) throw new Error('Production cells require production configuration');
  if (cell.sampleKind === 'publisher' && cell.mode === 'production' && cell.production?.verifyPdf !== true) {
    throw new Error('Publisher production cells must require PDF verification');
  }
  if (cell.sampleKind === 'scholar' && cell.mode === 'production' && cell.production?.maxResults !== 5) {
    throw new Error('Scholar production cells must use maxResults=5');
  }
  validateBenchmarkExecutionResult(cell);
  if (cell.outcome === 'success' && (cell.httpDispatchCount < 1 || cell.serviceAttemptCount < 1)) {
    throw new Error('A successful benchmark cell must contain an actual dispatch trace');
  }
  if (cell.outcome === 'success' && cell.match !== 'matched') {
    throw new Error('A successful benchmark cell must have a matched identity');
  }
  if (cell.outcome === 'success' && cell.sampleKind === 'publisher' && cell.mode === 'production' && cell.pdfVerification !== 'verified') {
    throw new Error('A successful Publisher production cell must have verified PDF evidence');
  }
  if (cell.outcome !== 'not_run' && cell.sampleKind === 'publisher' && cell.mode === 'comparison' && cell.pdfVerification !== 'not_requested') {
    throw new Error('Publisher comparison cells cannot perform PDF verification');
  }
  if ((cell.costKnown === true) !== (cell.reportedCredits !== null)) {
    throw new Error('Benchmark cell cost-known state does not match reported credits');
  }
  if (cell.outcome === 'not_run' && (cell.httpDispatchCount !== 0 || cell.serviceAttemptCount !== 0 || cell.admissionUsed !== 0
    || cell.reportedCredits !== null || cell.costKnown !== null || cell.match !== 'not_evaluated' || cell.pdfVerification !== 'not_run')) {
    throw new Error('A not_run benchmark cell must not contain execution evidence');
  }
}

function validateAttempt(attempt: unknown, cellById: Map<string, BenchmarkCellResult>): void {
  if (!isRecord(attempt)) throw new Error('Benchmark attempt must be an object');
  const hasDispatchId = Object.prototype.hasOwnProperty.call(attempt, 'dispatchId');
  const hasFailureKind = Object.prototype.hasOwnProperty.call(attempt, 'failureKind');
  const attemptKeys = hasDispatchId && hasFailureKind
    ? ATTEMPT_KEYS
    : hasDispatchId
      ? DISPATCH_ATTEMPT_KEYS
      : hasFailureKind
        ? FAILURE_ATTEMPT_KEYS
        : LEGACY_ATTEMPT_KEYS;
  assertExactKeys(attempt, attemptKeys, 'Benchmark attempt');
  assertRequiredKeys(attempt, attemptKeys, 'Benchmark attempt');
  boundedId(attempt.attemptId, 'attemptId');
  if (attempt.dispatchId !== undefined && attempt.dispatchId !== null) boundedId(attempt.dispatchId, 'dispatchId');
  boundedId(attempt.cellId, 'cellId');
  const cell = cellById.get(attempt.cellId);
  if (!cell) throw new Error('Benchmark attempt references an unknown cell');
  if (attempt.combination !== cell.combination) throw new Error('Benchmark attempt combination does not match its cell');
  if (!['doi', 'init', 'page', 'redirect', 'pdf', 'provider_api'].includes(attempt.role)) throw new Error('Benchmark attempt role is invalid');
  const combinations = ['production', 'direct', 'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'];
  const dispatchCombinations = ['direct', 'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'];
  if (!combinations.includes(attempt.combination) || !dispatchCombinations.includes(attempt.dispatchCombination)) {
    throw new Error('Benchmark attempt combination is invalid');
  }
  boundedTimestamp(attempt.submittedAt, 'submittedAt');
  for (const field of ['elapsedMs', 'admissionUsed']) assertSafeInteger(attempt[field], field);
  for (const field of ['apiStatus', 'targetStatus']) {
    const value = attempt[field];
    if (value !== null && (!Number.isSafeInteger(value) || value < 100 || value > 599)) throw new Error(`${field} must be null or an HTTP status`);
  }
  if (attempt.estimate !== null && !isSafeNonnegativeInteger(attempt.estimate)) throw new Error('attempt estimate must be null or a non-negative safe integer');
  if (attempt.reportedCredits !== null && !isSafeNonnegativeInteger(attempt.reportedCredits)) throw new Error('attempt reportedCredits must be null or a non-negative safe integer');
  if (attempt.costKnown !== null && typeof attempt.costKnown !== 'boolean') throw new Error('attempt costKnown must be boolean or null');
  if (attempt.failureKind !== undefined && attempt.failureKind !== null
    && !['transport_timeout', 'scope_deadline', 'operation_deadline', 'cancelled', 'response_body'].includes(attempt.failureKind)) {
    throw new Error('attempt failureKind is invalid');
  }
  if (![
    'pricing_unknown', 'request_cost_limit', 'operation_budget_exceeded', 'reservation_contended',
    'actual_cost_exceeded', 'unknown_cost', 'not_authorized', 'provider_unavailable',
    'restricted_target', 'restricted_page', 'candidate_limit', 'target_not_found', 'no_candidate',
    'target_status_unknown', 'challenge', 'parse_failed', 'target_failed', 'scope_exhausted',
    'run_limit', 'run_in_use', 'not_run', 'identity_mismatch', 'none', 'unknown'
  ].includes(attempt.reason)) throw new Error('attempt reason is invalid');
}

function validateMetrics(metrics: Record<string, any>): void {
  for (const key of ['publisher', 'scholar']) {
    const value = metrics[key];
    if (!isRecord(value)) throw new Error(`Missing ${key} metrics`);
    assertExactKeys(value, METRIC_KEYS, `${key} metrics`);
    assertRequiredKeys(value, METRIC_KEYS, `${key} metrics`);
    for (const field of ['planned', 'completed', 'successes']) assertSafeInteger(value[field], `${key}.${field}`);
    for (const field of ['p95Ms', 'reportedCredits', 'averageCreditsPerSuccess']) {
      if (value[field] !== null && !isSafeNonnegativeNumber(value[field])) throw new Error(`${key}.${field} must be null or non-negative`);
    }
    if (value.successRate !== null && (typeof value.successRate !== 'number' || value.successRate < 0 || value.successRate > 1)) throw new Error(`${key}.successRate is invalid`);
    if (typeof value.costKnown !== 'boolean' || typeof value.passed !== 'boolean') throw new Error(`${key} metrics flags are invalid`);
    if (!Array.isArray(value.rounds) || value.rounds.length !== 2) throw new Error(`${key} round metrics are invalid`);
    value.rounds.forEach((round: unknown, index: number) => {
      if (!isRecord(round)) throw new Error(`${key} round ${index} is invalid`);
      assertExactKeys(round, ROUND_KEYS, `${key} round`);
      assertRequiredKeys(round, ROUND_KEYS, `${key} round`);
      if (round.round !== 0 && round.round !== 1) throw new Error(`${key} round value is invalid`);
      for (const field of ['planned', 'successes']) assertSafeInteger(round[field], `${key}.round.${field}`);
      if (round.successRate !== null && !isSafeNonnegativeNumber(round.successRate)) throw new Error(`${key}.round.successRate is invalid`);
      if (typeof round.passed !== 'boolean') throw new Error(`${key} round passed flag is invalid`);
    });
  }
}

function validateLimits(limits: unknown): asserts limits is BenchmarkLimits {
  if (!isRecord(limits)) throw new Error('Benchmark report limits are required');
  assertSafeInteger(limits.credits, 'limits.credits');
  assertSafeInteger(limits.httpDispatches, 'limits.httpDispatches');
  assertSafeInteger(limits.elapsedMs, 'limits.elapsedMs');
  if (limits.credits > 15_000 || limits.httpDispatches > 1_500 || limits.elapsedMs > 7_200_000) {
    throw new Error('Benchmark report limits exceed the fixed safety ceiling');
  }
}

function metricRow(label: string, metrics: BenchmarkReport['metrics']['publisher']): string {
  return `| ${label} | ${metrics.planned} | ${metrics.successes} | ${formatNumber(metrics.successRate)} | ${formatNumber(metrics.p95Ms)} | ${formatNumber(metrics.averageCreditsPerSuccess)} | ${metrics.costKnown ? 'yes' : 'no'} | ${metrics.passed ? 'yes' : 'no'} |`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'null' : String(value);
}

function assertExactKeys(
  value: Record<string, any>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) {
    if (unexpected.some(key => FORBIDDEN_KEYS.test(key))) throw new Error(`Sensitive report field is not allowed: ${label}`);
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}`);
  }
}

function assertRequiredKeys(
  value: Record<string, any>,
  required: readonly string[],
  label: string
): void {
  const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
}

function sameCellMetadata(left: BenchmarkCellResult, right: BenchmarkCell): boolean {
  return JSON.stringify({
    cellId: left.cellId,
    sampleId: left.sampleId,
    sampleKind: left.sampleKind,
    round: left.round,
    mode: left.mode,
    combination: left.combination,
    production: left.production
  }) === JSON.stringify({
    cellId: right.cellId,
    sampleId: right.sampleId,
    sampleKind: right.sampleKind,
    round: right.round,
    mode: right.mode,
    combination: right.combination,
    production: right.production
  });
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is not a safe bounded identifier`);
  return value;
}

function boundedTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is not a valid bounded timestamp`);
  return value;
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!isSafeNonnegativeInteger(value)) throw new Error(`${label} must be a non-negative safe integer`);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertPrivacySafe(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPrivacySafe(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === 'string' && /(?:https?:\/\/|cookie\s*=|authorization\s*:|bearer\s+)/i.test(value)) {
      throw new Error(`Sensitive value is not allowed in benchmark report at ${path}`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`Sensitive report field is not allowed: ${path}.${key}`);
    assertPrivacySafe(entry, `${path}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Kept as an internal default so report construction cannot infer limits from
// a process environment or a provider account.
const DEFAULT_REPORT_LIMITS: BenchmarkLimits = {
  credits: 15_000,
  httpDispatches: 1_500,
  elapsedMs: 7_200_000
};
