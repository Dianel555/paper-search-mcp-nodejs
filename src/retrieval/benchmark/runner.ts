import {
  matchPublisherCandidate,
  matchScholarIdentity
} from './corpus.js';
import { MAX_PDF_PROBE_BYTES } from '../../services/PdfAccessVerifier.js';
import {
  acquireBenchmarkRunId,
  BenchmarkAdmissionError,
  BenchmarkOperationAdmission,
  BenchmarkRunAdmission,
  markBenchmarkRunCompleted,
  type BenchmarkRunSnapshot,
  type RunReservation
} from './admission.js';
import { createBenchmarkReportBundle } from './report.js';
import type {
  BenchmarkAttempt,
  BenchmarkCell,
  BenchmarkDispatchCombination,
  BenchmarkCellCombination,
  BenchmarkCellResult,
  BenchmarkExecutionResult,
  BenchmarkPlan,
  BenchmarkPdfVerification,
  BenchmarkReportBundle,
  BenchmarkSample,
  BenchmarkSessionState
} from './types.js';
import type { BenchmarkCorpusValidation } from './types.js';
import { validateBenchmarkPlan } from './plan.js';
import { validateBenchmarkIdentifier } from './identifier.js';
import {
  OfflineBenchmarkTransport,
  offlineBenchmarkPricing,
  type BenchmarkCellPricing,
  type BenchmarkTransport,
  type BenchmarkTransportDispatch
} from './transport.js';

export interface BenchmarkAttemptInput {
  /** Internal reservation link used to update billing after late settlement. */
  readonly reservation?: RunReservation;
  readonly dispatchId?: BenchmarkAttempt['dispatchId'];
  readonly role: BenchmarkAttempt['role'];
  readonly combination: BenchmarkCellCombination;
  /** Concrete strategy/proxy used by this dispatch; never the production plan label. */
  readonly dispatchCombination: BenchmarkDispatchCombination;
  readonly elapsedMs?: number;
  readonly apiStatus?: number | null;
  readonly targetStatus?: number | null;
  readonly reason: BenchmarkAttempt['reason'];
  readonly failureKind?: BenchmarkAttempt['failureKind'];
  readonly estimate?: number | null;
  readonly reportedCredits?: number | null;
  readonly costKnown?: boolean | null;
}

export interface BenchmarkAttemptHandle extends BenchmarkAttempt {
  complete(update: Partial<Pick<BenchmarkAttempt, 'apiStatus' | 'targetStatus' | 'reason' | 'failureKind' | 'reportedCredits' | 'costKnown' | 'elapsedMs'>>): void;
}

export interface BenchmarkCellExecutionContext {
  readonly run: BenchmarkRunAdmission;
  readonly operation: BenchmarkOperationAdmission;
  readonly signal: AbortSignal;
  /** Runner clock/deadline exposed to a real offline workflow adapter. */
  readonly now: () => number;
  readonly deadlineAt: number;
  reservePaid(estimate: number): RunReservation;
  recordHttpDispatch(): void;
  recordAttempt(attempt: BenchmarkAttemptInput): BenchmarkAttemptHandle;
}

export interface BenchmarkCellExecutor {
  (
    cell: BenchmarkCell,
    sample: BenchmarkSample,
    context: BenchmarkCellExecutionContext
  ): Promise<Partial<BenchmarkExecutionResult>> | Partial<BenchmarkExecutionResult>;
  /** Offline fixtures are never valid live-run executors. */
  readonly offlineOnly?: boolean;
  /** Live transports are never valid under an offline report label. */
  readonly liveOnly?: boolean;
}

export interface BenchmarkRunnerOptions {
  readonly validation: BenchmarkCorpusValidation;
  readonly plan: BenchmarkPlan;
  readonly runId: string;
  readonly mode: 'offline' | 'live';
  readonly codeVersion: string;
  readonly configVersion: string;
  readonly executeCell: BenchmarkCellExecutor;
  /** Internal bounded diagnostic selector; omitted for the fixed full plan. */
  readonly shouldExecuteCell?: (cell: BenchmarkCell, sample: BenchmarkSample) => boolean;
  readonly now?: () => number;
  readonly limits?: { credits?: number; httpDispatches?: number; elapsedMs?: number };
  readonly prerequisitesReady?: boolean;
}

export async function runBenchmark(options: BenchmarkRunnerOptions): Promise<BenchmarkReportBundle> {
  const now = options.now || Date.now;
  validateBenchmarkPlan(options.plan, options.validation);
  validateBenchmarkIdentifier(options.runId, 'runId');
  validateBenchmarkIdentifier(options.codeVersion, 'codeVersion');
  validateBenchmarkIdentifier(options.configVersion, 'configVersion');
  if (options.mode === 'live' && options.executeCell.offlineOnly) {
    throw new BenchmarkAdmissionError('not_authorized', 'The offline benchmark transport cannot run a live campaign');
  }
  if (options.mode === 'offline' && options.executeCell.liveOnly) {
    throw new BenchmarkAdmissionError('not_authorized', 'The live benchmark transport cannot run an offline campaign');
  }
  const releaseRunId = acquireBenchmarkRunId(options.runId);
  let run: BenchmarkRunAdmission;
  try {
    run = new BenchmarkRunAdmission({
      runId: options.runId,
      mode: options.mode,
      now,
      limits: options.limits
    });
  } catch (error) {
    releaseRunId();
    throw error;
  }
  const samples = new Map<string, BenchmarkSample>([
    ...options.validation.corpus.publisher.map(sample => [sample.sampleId, sample] as const),
    ...options.validation.corpus.scholar.map(sample => [sample.sampleId, sample] as const)
  ]);
  const results: BenchmarkCellResult[] = [];
  const attempts: BenchmarkAttempt[] = [];
  const attemptReservations = new Map<string, RunReservation>();
  let attemptSequence = 0;
  const startedAt = new Date(run.startedAt).toISOString();
  try {
    for (const cell of options.plan.cells) {
      syncLinkedAttemptSettlements(attempts, attemptReservations);
      syncLinkedCellResults(results, attempts, attemptReservations);
      if (options.prerequisitesReady === false) {
        results.push(notRunCell(cell));
        continue;
      }
      const runState = run.snapshot();
      const requiresPaid = cell.mode === 'production' || cell.combination !== 'direct';
      if (requiresPaid && runState.paidClosed && runState.paidClosedReason !== 'deadline_exceeded' && runState.paidClosedReason !== 'run_limit') {
        results.push(notRunCell(cell));
        continue;
      }
      if (runState.paidClosed && (runState.paidClosedReason === 'deadline_exceeded' || runState.paidClosedReason === 'run_limit')) {
        results.push(notRunCell(cell));
        continue;
      }
      const sample = samples.get(cell.sampleId);
      if (!sample) {
        results.push({ ...cell, ...failureResult('input', 'unknown') });
        continue;
      }
      if (options.shouldExecuteCell && !options.shouldExecuteCell(cell, sample)) {
        results.push(notRunCell(cell));
        continue;
      }
      const operation = run.createOperation({
        budget: 500,
        maxCreditsPerRequest: 125,
        operationId: `${options.runId}:${cell.cellId}`
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, run.deadlineAt - now()));
      const runBefore = run.snapshot();
      const operationBefore = operation.snapshot();
      const cellStartedAt = now();
      const reservations: RunReservation[] = [];
      let cellClosed = false;
      const context: BenchmarkCellExecutionContext = {
        run,
        operation,
        signal: controller.signal,
        now,
        deadlineAt: run.deadlineAt,
        reservePaid: estimate => {
          if (cellClosed || controller.signal.aborted) throw new BenchmarkAdmissionError('cancelled', 'Benchmark cell is closed');
          const reservation = run.reservePaid(operation, estimate);
          reservations.push(reservation);
          return reservation;
        },
        recordHttpDispatch: () => {
          if (cellClosed || controller.signal.aborted) throw new BenchmarkAdmissionError('cancelled', 'Benchmark cell is closed');
          run.recordHttpDispatch(controller.signal);
        },
        recordAttempt: input => {
          if (cellClosed || controller.signal.aborted) throw new BenchmarkAdmissionError('cancelled', 'Benchmark cell is closed');
          const admissionUsed = input.reservation?.settlementObserved
            ? input.reservation.admissionUsed
            : 0;
          const attempt: BenchmarkAttempt = {
            attemptId: `attempt-${++attemptSequence}`,
            dispatchId: input.dispatchId ?? null,
            cellId: cell.cellId,
            role: input.role,
            combination: input.combination,
            dispatchCombination: input.dispatchCombination,
            submittedAt: new Date(now()).toISOString(),
            elapsedMs: input.elapsedMs ?? Math.max(0, now() - cellStartedAt),
            apiStatus: input.apiStatus ?? null,
            targetStatus: input.targetStatus ?? null,
            reason: input.reason,
            failureKind: input.failureKind ?? null,
            estimate: input.estimate ?? null,
            reportedCredits: input.reportedCredits ?? null,
            costKnown: input.costKnown ?? null,
            admissionUsed
          };
          attempts.push(attempt);
          if (input.reservation) attemptReservations.set(attempt.attemptId, input.reservation);
          return {
            ...attempt,
            complete: update => {
              const index = attempts.findIndex(candidate => candidate.attemptId === attempt.attemptId);
              if (index < 0) return;
              attempts[index] = { ...attempts[index], ...update };
            }
          };
        }
      };
      let execution: Partial<BenchmarkExecutionResult>;
      const executionPromise = Promise.resolve().then(() => options.executeCell(cell, sample, context));
      try {
        execution = await awaitWithAbort(executionPromise, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) run.close('deadline_exceeded');
        execution = error instanceof BenchmarkAdmissionError
          ? failureResult('budget', mapAdmissionReason(error.code))
          : failureResult('unknown', 'unknown');
      } finally {
        cellClosed = true;
        for (const reservation of reservations) {
          if (reservation.settled) continue;
          if (reservation.dispatched) reservation.settle(null);
          else reservation.release();
        }
        syncLinkedAttemptSettlements(attempts, attemptReservations);
        syncLinkedCellResults(results, attempts, attemptReservations);
        clearTimeout(timer);
        controller.abort();
      }
      const runAfter = run.snapshot();
      const operationAfter = operation.snapshot();
      const result = finalizeCellResult(cell, execution, {
        runBefore,
        runAfter,
        operationBefore,
        operationAfter,
        serviceAttemptCount: attempts.filter(attempt => attempt.cellId === cell.cellId).length,
        cellAdmissionUsed: attempts
          .filter(attempt => attempt.cellId === cell.cellId)
          .reduce((sum, attempt) => sum + attempt.admissionUsed, 0),
        elapsedMs: Math.max(0, now() - cellStartedAt)
      });
      syncLinkedAttemptSettlements(attempts, attemptReservations);
      results.push(result);
      syncLinkedCellResults(results, attempts, attemptReservations);
      if (runAfter.paidClosed && ['run_limit', 'deadline_exceeded', 'actual_cost_exceeded'].includes(runAfter.paidClosedReason || '')) {
        // The remaining fixed cells are retained by createBenchmarkReport as
        // explicit not_run entries; no implicit resume or reordering occurs.
        continue;
      }
    }

    syncLinkedAttemptSettlements(attempts, attemptReservations);
    syncLinkedCellResults(results, attempts, attemptReservations);
    const bundle = createBenchmarkReportBundle({
      run: run.snapshot(),
      runLimits: run.limits,
      plan: options.plan,
      corpusVersion: options.validation.corpusVersion,
      codeVersion: options.codeVersion,
      configVersion: options.configVersion,
      startedAt,
      endedAt: new Date(now()).toISOString(),
      cells: results,
      attempts,
      prerequisitesReady: options.prerequisitesReady
    });
    return bundle;
  } finally {
    markBenchmarkRunCompleted(options.runId);
    releaseRunId();
    // The process-local guard is intentionally released after report creation;
    // a CLI file marker separately prevents a restarted process from resuming.
  }
}

export interface TransportBackedCellExecutorOptions {
  readonly pricing?: BenchmarkCellPricing;
}

/** Build a cell executor around an injected transport and observed dispatch gate. */
export function createTransportBackedCellExecutor(
  transport: BenchmarkTransport,
  options: TransportBackedCellExecutorOptions = {}
): BenchmarkCellExecutor {
  const pricing = options.pricing || offlineBenchmarkPricing;
  let scholarSessionReady = false;
  const executor: BenchmarkCellExecutor = async (cell, sample, context) => {
    let httpDispatchCount = 0;
    let serviceAttemptCount = 0;
    const submit = async (role: BenchmarkAttemptInput['role']): Promise<Awaited<ReturnType<BenchmarkTransport['dispatch']>>> => {
      const estimatedCredits = pricing(cell, role);
      let dispatch: BenchmarkTransportDispatch | undefined;
      let attempt: BenchmarkAttemptHandle | undefined;
      let responseReceived = false;
      try {
        const response = await transport.dispatch({
          cell,
          sample,
          role,
          estimatedCredits,
          signal: context.signal
        }, actualEstimate => {
          if (dispatch) throw new BenchmarkAdmissionError('run_limit', 'Benchmark transport dispatched a request twice');
          if (actualEstimate !== estimatedCredits) {
            throw new BenchmarkAdmissionError('pricing_unknown', 'Benchmark transport changed the admitted request price');
          }
          const reservation = actualEstimate > 0 ? context.reservePaid(actualEstimate) : undefined;
          try {
            if (reservation) reservation.markDispatched(context.signal);
            else context.recordHttpDispatch();
            attempt = context.recordAttempt({
              role,
              combination: cell.combination,
              dispatchCombination: concreteDispatchCombination(cell, role),
              reason: 'none',
              estimate: actualEstimate,
              reportedCredits: actualEstimate === 0 ? 0 : null,
              costKnown: actualEstimate === 0 ? true : null,
              reservation
            });
            dispatch = { attemptId: attempt.attemptId, ...(reservation ? { reservation } : {}) };
            httpDispatchCount++;
            serviceAttemptCount++;
            return dispatch;
          } catch (error) {
            if (reservation && !reservation.settled) reservation.release();
            throw error;
          }
        });
        if (!dispatch || !attempt) throw new Error('Benchmark transport returned without starting a dispatch');
        responseReceived = true;
        const reportedCredits = response.reportedCredits ?? (estimatedCredits === 0 ? 0 : null);
        attempt.complete({
          apiStatus: response.apiStatus ?? null,
          targetStatus: response.targetStatus ?? null,
          reason: 'none',
          reportedCredits,
          costKnown: estimatedCredits === 0 || reportedCredits !== null,
          elapsedMs: 0
        });
        if (dispatch.reservation) dispatch.reservation.settle(reportedCredits);
        return response;
      } catch (error) {
        if (attempt && !responseReceived) {
          attempt.complete({
            apiStatus: null,
            targetStatus: null,
            reason: error instanceof BenchmarkAdmissionError ? mapAdmissionReason(error.code) : 'target_failed',
            reportedCredits: estimatedCredits === 0 ? 0 : null,
            costKnown: estimatedCredits === 0 ? true : null,
            elapsedMs: 0
          });
        }
        throw error;
      }
    };

    let localSessionState: BenchmarkSessionState = 'not_applicable';
    if (cell.sampleKind === 'scholar') {
      localSessionState = scholarSessionReady ? 'warm' : 'cold';
      if (!scholarSessionReady && cell.mode === 'production') {
        await submit('init');
        scholarSessionReady = true;
      }
    }

    const pageRole: BenchmarkAttempt['role'] = cell.combination === 'direct' || cell.combination === 'production'
      ? 'page'
      : 'provider_api';
    const page = await submit(pageRole);
    const match = sample.kind === 'publisher'
      ? page.candidateUrl ? matchPublisherCandidate(sample, page.candidateUrl) : 'not_evaluated'
      : page.scholarIdentity ? matchScholarIdentity(sample, page.scholarIdentity) : 'not_evaluated';
    let pdfVerification: BenchmarkPdfVerification = 'not_requested';
    if (cell.sampleKind === 'publisher' && cell.mode === 'production' && match === 'matched') {
      const pdf = await submit('pdf');
      const bodyBytes = pdf.body === undefined
        ? Buffer.alloc(0)
        : typeof pdf.body === 'string' ? Buffer.from(pdf.body, 'utf8') : Buffer.from(pdf.body);
      pdfVerification = bodyBytes.byteLength <= MAX_PDF_PROBE_BYTES && bodyBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
        ? 'verified'
        : 'failed';
    }

    const businessSuccess = match === 'matched'
      && (cell.sampleKind !== 'publisher' || cell.mode !== 'production' || pdfVerification === 'verified');
    return {
      outcome: businessSuccess ? 'success' : 'failed',
      stage: cell.sampleKind === 'publisher' ? (cell.mode === 'production' ? 'pdf' : 'candidate') : 'parse',
      reason: businessSuccess ? 'none' : (match === 'mismatched' ? 'identity_mismatch' : 'parse_failed'),
      apiStatus: page.apiStatus ?? null,
      targetStatus: page.targetStatus ?? null,
      httpDispatchCount,
      serviceAttemptCount,
      elapsedMs: 0,
      admissionUsed: 0,
      reportedCredits: null,
      costKnown: null,
      match,
      pdfVerification,
      localSessionState
    };
  };
  return transport.offlineOnly ? Object.assign(executor, { offlineOnly: true as const }) : executor;
}

/** Deterministic accounting/report simulation only; never a production workflow. */
export function createOfflineCellExecutor(): BenchmarkCellExecutor {
  const executor = createTransportBackedCellExecutor(new OfflineBenchmarkTransport());
  return Object.assign(executor, { offlineOnly: true as const });
}

function concreteDispatchCombination(
  cell: BenchmarkCell,
  role: BenchmarkAttempt['role']
): BenchmarkDispatchCombination {
  if (cell.combination !== 'production') return cell.combination;
  return role === 'provider_api' ? 'static:datacenter' : 'direct';
}

function finalizeCellResult(
  cell: BenchmarkCell,
  execution: Partial<BenchmarkExecutionResult>,
  values: {
    runBefore: BenchmarkRunSnapshot;
    runAfter: BenchmarkRunSnapshot;
    operationBefore: ReturnType<BenchmarkOperationAdmission['snapshot']>;
    operationAfter: ReturnType<BenchmarkOperationAdmission['snapshot']>;
    serviceAttemptCount: number;
    cellAdmissionUsed: number;
    elapsedMs: number;
  }
): BenchmarkCellResult {
  const result: BenchmarkExecutionResult = {
    outcome: execution.outcome || 'failed',
    stage: execution.stage || 'unknown',
    reason: execution.reason || 'unknown',
    apiStatus: execution.apiStatus ?? null,
    targetStatus: execution.targetStatus ?? null,
    // These fields come from the admission/attempt observers, not from the
    // executor's summary, so a harness cannot manufacture a successful trace.
    httpDispatchCount: Math.max(0, values.runAfter.httpDispatchCount - values.runBefore.httpDispatchCount),
    serviceAttemptCount: values.serviceAttemptCount,
    elapsedMs: values.elapsedMs,
    admissionUsed: values.cellAdmissionUsed,
    reportedCredits: values.operationAfter.reportedCostKnown
      ? Math.max(0, values.operationAfter.reportedCredits - values.operationBefore.reportedCredits)
      : null,
    costKnown: values.operationAfter.reportedCostKnown ? true : null,
    match: execution.match || 'not_evaluated',
    pdfVerification: cell.mode === 'comparison' && (execution.pdfVerification === undefined || execution.pdfVerification === 'not_run')
      ? 'not_requested'
      : (execution.pdfVerification || 'not_run'),
    localSessionState: execution.localSessionState || 'unknown'
  };
  if (result.outcome === 'success' && cell.mode === 'production') {
    if (cell.sampleKind === 'publisher' && (result.match !== 'matched' || result.pdfVerification !== 'verified')) {
      return { ...cell, ...result, outcome: 'failed', stage: 'pdf', reason: 'identity_mismatch' };
    }
    if (cell.sampleKind === 'scholar' && result.match !== 'matched') {
      return { ...cell, ...result, outcome: 'failed', stage: 'parse', reason: 'identity_mismatch' };
    }
  }
  return { ...cell, ...result };
}

function syncLinkedAttemptSettlements(
  attempts: BenchmarkAttempt[],
  reservations: Map<string, RunReservation>
): void {
  for (let index = 0; index < attempts.length; index++) {
    const reservation = reservations.get(attempts[index].attemptId);
    if (!reservation || !reservation.settlementObserved) continue;
    attempts[index] = {
      ...attempts[index],
      admissionUsed: reservation.admissionUsed,
      reportedCredits: reservation.reportedCredits,
      costKnown: reservation.costKnown
    };
  }
}

function syncLinkedCellResults(
  results: BenchmarkCellResult[],
  attempts: readonly BenchmarkAttempt[],
  reservations: Map<string, RunReservation>
): void {
  const linkedCells = new Set<string>();
  for (const attempt of attempts) {
    if (reservations.has(attempt.attemptId)) linkedCells.add(attempt.cellId);
  }
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!linkedCells.has(result.cellId)) continue;
    const cellAttempts = attempts.filter(attempt => attempt.cellId === result.cellId);
    const costKnown = cellAttempts.every(attempt => attempt.costKnown === true);
    results[index] = {
      ...result,
      admissionUsed: cellAttempts.reduce((sum, attempt) => sum + attempt.admissionUsed, 0),
      reportedCredits: costKnown
        ? cellAttempts.reduce((sum, attempt) => sum + (attempt.reportedCredits || 0), 0)
        : null,
      costKnown: costKnown ? true : null
    };
  }
}

function failureResult(stage: BenchmarkExecutionResult['stage'], reason: BenchmarkExecutionResult['reason']): BenchmarkExecutionResult {
  return {
    outcome: 'failed',
    stage,
    reason,
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

function notRunCell(cell: BenchmarkCell): BenchmarkCellResult {
  return { ...cell, ...{
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
  } };
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BenchmarkAdmissionError('deadline_exceeded', 'Benchmark cell deadline was reached'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new BenchmarkAdmissionError('deadline_exceeded', 'Benchmark cell deadline was reached'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

function mapAdmissionReason(code: string): BenchmarkExecutionResult['reason'] {
  if (code === 'pricing_unknown' || code === 'request_cost_limit' || code === 'operation_budget_exceeded' || code === 'reservation_contended' || code === 'actual_cost_exceeded' || code === 'unknown_cost' || code === 'run_limit' || code === 'run_in_use' || code === 'not_authorized') return code;
  return code === 'deadline_exceeded' || code === 'cancelled' ? 'run_limit' : 'unknown';
}
