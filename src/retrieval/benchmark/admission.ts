import type { BenchmarkLimits } from './types.js';

export const DEFAULT_BENCHMARK_LIMITS: BenchmarkLimits = {
  credits: 15_000,
  httpDispatches: 1_500,
  elapsedMs: 7_200_000
};

export const DEFAULT_BENCHMARK_OPERATION_BUDGET = 500;
export const DEFAULT_BENCHMARK_REQUEST_LIMIT = 125;

export type BenchmarkAdmissionErrorCode =
  | 'pricing_unknown'
  | 'request_cost_limit'
  | 'operation_budget_exceeded'
  | 'reservation_contended'
  | 'run_limit'
  | 'run_in_use'
  | 'actual_cost_exceeded'
  | 'unknown_cost'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'not_authorized'
  | 'provider_error';

export class BenchmarkAdmissionError extends Error {
  constructor(
    readonly code: BenchmarkAdmissionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BenchmarkAdmissionError';
  }
}

export interface BenchmarkOperationAdmissionOptions {
  readonly budget: number;
  readonly maxCreditsPerRequest: number;
  readonly operationId?: string;
}

export interface BenchmarkOperationSnapshot {
  readonly operationId: string;
  readonly budget: number;
  readonly maxCreditsPerRequest: number;
  readonly settledCredits: number;
  readonly reservedCredits: number;
  readonly reportedCredits: number;
  readonly reportedCostKnown: boolean;
  readonly unknownCostAttempts: number;
  readonly paidClosed: boolean;
  readonly paidClosedReason?: BenchmarkAdmissionErrorCode;
}

interface OperationReservationState {
  readonly estimate: number;
  dispatched: boolean;
  settled: boolean;
  unknownCost: boolean;
  reconciled: boolean;
}

export class BenchmarkOperationAdmission {
  private readonly reservations = new Set<OperationReservationState>();
  private settledCredits = 0;
  private reservedCredits = 0;
  private reportedCredits = 0;
  private reportedCostKnown = true;
  private unknownCostAttempts = 0;
  private paidClosed = false;
  private paidClosedReason?: BenchmarkAdmissionErrorCode;
  private sequence = 0;

  constructor(private readonly options: BenchmarkOperationAdmissionOptions) {
    assertSafeNonnegativeInteger(options.budget, 'operation budget');
    assertSafeNonnegativeInteger(options.maxCreditsPerRequest, 'request cost limit');
    if (options.maxCreditsPerRequest > options.budget) {
      throw new BenchmarkAdmissionError('request_cost_limit', 'Request cost limit exceeds operation budget');
    }
  }

  reserve(estimate: number): OperationReservation {
    validateEstimate(estimate);
    if (estimate > this.options.maxCreditsPerRequest) {
      this.close('request_cost_limit');
      throw new BenchmarkAdmissionError('request_cost_limit', 'Estimated request cost exceeds the operation limit');
    }
    if (this.paidClosed) throw new BenchmarkAdmissionError(this.paidClosedReason || 'operation_budget_exceeded', 'Operation paid admission is closed');
    if (this.settledCredits + estimate > this.options.budget) {
      this.close('operation_budget_exceeded');
      throw new BenchmarkAdmissionError('operation_budget_exceeded', 'Operation paid budget is exhausted');
    }
    if (this.settledCredits + this.reservedCredits + estimate > this.options.budget) {
      throw new BenchmarkAdmissionError('reservation_contended', 'Operation paid reservation is temporarily contended');
    }
    const state: OperationReservationState = {
      estimate,
      dispatched: false,
      settled: false,
      unknownCost: false,
      reconciled: false
    };
    this.reservations.add(state);
    this.reservedCredits += estimate;
    return new OperationReservation(this, state, `operation-attempt-${++this.sequence}`);
  }

  settle(state: OperationReservationState, actualCredits: number | null): void {
    if (!state.settled && !state.dispatched) {
      this.release(state);
      return;
    }
    if (state.settled) {
      if (state.unknownCost && !state.reconciled && actualCredits !== null && isSafeCredit(actualCredits)) {
        state.reconciled = true;
        this.reportedCredits += actualCredits;
        this.unknownCostAttempts = Math.max(0, this.unknownCostAttempts - 1);
        this.reportedCostKnown = this.unknownCostAttempts === 0;
        this.settledCredits += Math.max(0, Math.max(state.estimate, actualCredits) - state.estimate);
        if (actualCredits > this.options.maxCreditsPerRequest) this.close('request_cost_limit');
        else if (this.settledCredits > this.options.budget) this.close('actual_cost_exceeded');
      }
      return;
    }
    state.settled = true;
    this.reservations.delete(state);
    this.reservedCredits = Math.max(0, this.reservedCredits - state.estimate);
    if (actualCredits === null || !isSafeCredit(actualCredits)) {
      state.unknownCost = true;
      // Keep the estimate consumed and expose the unknown billing state, but
      // let bounded retry/fallback work continue until another admission or
      // transport safety limit is reached.
      this.settledCredits += state.estimate;
      this.reportedCostKnown = false;
      this.unknownCostAttempts++;
      return;
    }
    this.settledCredits += Math.max(state.estimate, actualCredits);
    this.reportedCredits += actualCredits;
    if (actualCredits > this.options.maxCreditsPerRequest) this.close('request_cost_limit');
    else if (this.settledCredits > this.options.budget) this.close('actual_cost_exceeded');
  }

  release(state: OperationReservationState): void {
    if (state.settled || state.dispatched) return;
    state.settled = true;
    this.reservations.delete(state);
    this.reservedCredits = Math.max(0, this.reservedCredits - state.estimate);
  }

  markDispatched(state: OperationReservationState, signal?: AbortSignal): void {
    try {
      if (signal?.aborted) throw new BenchmarkAdmissionError('cancelled', 'Benchmark operation was cancelled before dispatch');
      if (state.settled) throw new BenchmarkAdmissionError('run_limit', 'Paid reservation is no longer active');
      if (state.dispatched) throw new BenchmarkAdmissionError('run_limit', 'Paid reservation was already dispatched');
      if (this.paidClosed) throw new BenchmarkAdmissionError(this.paidClosedReason || 'operation_budget_exceeded', 'Operation paid admission is closed');
      if (this.settledCredits + this.reservedCredits > this.options.budget) {
        this.close('operation_budget_exceeded');
        throw new BenchmarkAdmissionError('operation_budget_exceeded', 'Operation paid budget changed before dispatch');
      }
      state.dispatched = true;
    } catch (error) {
      if (!state.settled && !state.dispatched) this.release(state);
      throw error;
    }
  }

  close(reason: BenchmarkAdmissionErrorCode): void {
    if (this.paidClosed) return;
    this.paidClosed = true;
    this.paidClosedReason = reason;
  }

  snapshot(): BenchmarkOperationSnapshot {
    return {
      operationId: this.options.operationId || 'benchmark-operation',
      budget: this.options.budget,
      maxCreditsPerRequest: this.options.maxCreditsPerRequest,
      settledCredits: this.settledCredits,
      reservedCredits: this.reservedCredits,
      reportedCredits: this.reportedCredits,
      reportedCostKnown: this.reportedCostKnown,
      unknownCostAttempts: this.unknownCostAttempts,
      paidClosed: this.paidClosed,
      ...(this.paidClosedReason ? { paidClosedReason: this.paidClosedReason } : {})
    };
  }
}

export class OperationReservation {
  constructor(
    private readonly owner: BenchmarkOperationAdmission,
    private readonly state: OperationReservationState,
    readonly attemptId: string
  ) {}

  get estimate(): number { return this.state.estimate; }
  get dispatched(): boolean { return this.state.dispatched; }
  get settled(): boolean { return this.state.settled; }
  snapshot(): BenchmarkOperationSnapshot { return this.owner.snapshot(); }

  markDispatched(signal?: AbortSignal): void { this.owner.markDispatched(this.state, signal); }
  settle(actualCredits: number | null): void { this.owner.settle(this.state, actualCredits); }
  release(): void { this.owner.release(this.state); }
}

interface RunReservationState {
  readonly estimate: number;
  readonly operationReservation: OperationReservation;
  dispatched: boolean;
  settled: boolean;
  unknownCost: boolean;
  reconciled: boolean;
  settlementObserved: boolean;
  admissionUsed: number;
  reportedCredits: number | null;
  costKnown: boolean | null;
}

export interface BenchmarkRunAdmissionOptions {
  readonly runId: string;
  readonly mode: 'offline' | 'live';
  readonly startedAt?: number;
  readonly now?: () => number;
  readonly limits?: Partial<BenchmarkLimits>;
}

export interface BenchmarkRunSnapshot {
  readonly runId: string;
  readonly mode: 'offline' | 'live';
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly admissionUsed: number;
  readonly reservedCredits: number;
  readonly reportedCredits: number;
  readonly reportedCostKnown: boolean;
  readonly unknownCostAttempts: number;
  readonly httpDispatchCount: number;
  readonly paidClosed: boolean;
  readonly paidClosedReason?: BenchmarkAdmissionErrorCode;
}

export class BenchmarkRunAdmission {
  readonly limits: BenchmarkLimits;
  readonly startedAt: number;
  readonly deadlineAt: number;
  private readonly now: () => number;
  private readonly reservations = new Set<RunReservationState>();
  private admissionUsed = 0;
  private reservedCredits = 0;
  private reportedCredits = 0;
  private reportedCostKnown = true;
  private unknownCostAttempts = 0;
  private httpDispatchCount = 0;
  private paidClosed = false;
  private paidClosedReason?: BenchmarkAdmissionErrorCode;
  private operationSequence = 0;

  constructor(private readonly options: BenchmarkRunAdmissionOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.runId)) {
      throw new BenchmarkAdmissionError('run_in_use', 'Run ID is not a safe bounded identifier');
    }
    this.now = options.now || Date.now;
    this.startedAt = options.startedAt ?? this.now();
    const limits = {
      ...DEFAULT_BENCHMARK_LIMITS,
      ...(options.limits || {})
    };
    assertSafeNonnegativeInteger(limits.credits, 'run credits limit');
    assertSafeNonnegativeInteger(limits.httpDispatches, 'run HTTP limit');
    assertSafeNonnegativeInteger(limits.elapsedMs, 'run deadline');
    if (limits.credits > DEFAULT_BENCHMARK_LIMITS.credits
      || limits.httpDispatches > DEFAULT_BENCHMARK_LIMITS.httpDispatches
      || limits.elapsedMs > DEFAULT_BENCHMARK_LIMITS.elapsedMs) {
      throw new BenchmarkAdmissionError('run_limit', 'Benchmark run limits cannot exceed the fixed safety ceiling');
    }
    this.limits = limits;
    this.deadlineAt = this.startedAt + limits.elapsedMs;
    if (!Number.isSafeInteger(this.deadlineAt)) throw new BenchmarkAdmissionError('run_limit', 'Run deadline is not safely representable');
  }

  createOperation(options: Partial<BenchmarkOperationAdmissionOptions> = {}): BenchmarkOperationAdmission {
    const budget = options.budget ?? DEFAULT_BENCHMARK_OPERATION_BUDGET;
    const maxCreditsPerRequest = options.maxCreditsPerRequest
      ?? Math.min(DEFAULT_BENCHMARK_REQUEST_LIMIT, budget);
    if (budget > DEFAULT_BENCHMARK_OPERATION_BUDGET || maxCreditsPerRequest > DEFAULT_BENCHMARK_REQUEST_LIMIT) {
      throw new BenchmarkAdmissionError('run_limit', 'Benchmark operation limits cannot exceed the fixed safety ceiling');
    }
    return new BenchmarkOperationAdmission({
      budget,
      maxCreditsPerRequest,
      operationId: options.operationId || `${this.options.runId}-operation-${++this.operationSequence}`
    });
  }

  reservePaid(operation: BenchmarkOperationAdmission, estimate: number): RunReservation {
    validateEstimate(estimate);
    if (this.paidClosed) throw new BenchmarkAdmissionError(this.paidClosedReason || 'run_limit', 'Run paid admission is closed');
    this.assertWithinRunDeadline();
    if (estimate > this.limits.credits) {
      this.close('request_cost_limit');
      throw new BenchmarkAdmissionError('request_cost_limit', 'Estimated cost exceeds the run limit');
    }
    if (this.admissionUsed + estimate > this.limits.credits) {
      this.close('run_limit');
      throw new BenchmarkAdmissionError('run_limit', 'Run paid budget is exhausted');
    }
    if (this.admissionUsed + this.reservedCredits + estimate > this.limits.credits) {
      throw new BenchmarkAdmissionError('reservation_contended', 'Run paid reservation is temporarily contended');
    }

    let operationReservation: OperationReservation;
    try {
      operationReservation = operation.reserve(estimate);
    } catch (error) {
      if (!(error instanceof BenchmarkAdmissionError)) throw error;
      throw error;
    }
    const state: RunReservationState = {
      estimate,
      operationReservation,
      dispatched: false,
      settled: false,
      unknownCost: false,
      reconciled: false,
      settlementObserved: false,
      admissionUsed: 0,
      reportedCredits: null,
      costKnown: null
    };
    this.reservations.add(state);
    this.reservedCredits += estimate;
    return new RunReservation(this, state);
  }

  recordHttpDispatch(signal?: AbortSignal): void {
    if (signal?.aborted) throw new BenchmarkAdmissionError('cancelled', 'Benchmark run was cancelled before dispatch');
    this.assertWithinRunDeadline();
    if (this.httpDispatchCount >= this.limits.httpDispatches) {
      this.close('run_limit');
      throw new BenchmarkAdmissionError('run_limit', 'Run HTTP dispatch limit was reached');
    }
    if (this.paidClosed && (this.paidClosedReason === 'run_limit' || this.paidClosedReason === 'deadline_exceeded')) {
      throw new BenchmarkAdmissionError(this.paidClosedReason, 'Run dispatch admission is closed');
    }
    this.httpDispatchCount++;
  }

  settlePaid(state: RunReservationState, actualCredits: number | null): void {
    if (!state.settled && !state.dispatched) {
      this.releasePaid(state);
      return;
    }
    if (state.settled) {
      if (state.unknownCost && !state.reconciled && actualCredits !== null && isSafeCredit(actualCredits)) {
        state.reconciled = true;
        this.reportedCredits += actualCredits;
        this.unknownCostAttempts = Math.max(0, this.unknownCostAttempts - 1);
        this.reportedCostKnown = this.unknownCostAttempts === 0;
        state.admissionUsed = Math.max(state.admissionUsed, Math.max(state.estimate, actualCredits));
        state.reportedCredits = actualCredits;
        state.costKnown = true;
        state.settlementObserved = true;
        this.admissionUsed += Math.max(0, Math.max(state.estimate, actualCredits) - state.estimate);
        state.operationReservation.settle(actualCredits);
        this.closeForOperation(state.operationReservation);
        if (actualCredits > this.limits.credits || this.admissionUsed > this.limits.credits) this.close('actual_cost_exceeded');
      }
      return;
    }
    state.settled = true;
    this.reservations.delete(state);
    this.reservedCredits = Math.max(0, this.reservedCredits - state.estimate);
    const known = actualCredits !== null && isSafeCredit(actualCredits);
    state.admissionUsed = known ? Math.max(state.estimate, actualCredits as number) : state.estimate;
    state.reportedCredits = known ? actualCredits as number : null;
    state.costKnown = known ? true : null;
    state.settlementObserved = true;
    this.admissionUsed += state.admissionUsed;
    if (!known) {
      state.unknownCost = true;
      this.reportedCostKnown = false;
      this.unknownCostAttempts++;
      state.operationReservation.settle(null);
      // Unknown billing is reported and charged against the estimate; it does
      // not independently close the bounded benchmark run.
      return;
    }
    this.reportedCredits += actualCredits as number;
    state.operationReservation.settle(actualCredits);
    this.closeForOperation(state.operationReservation);
    if (this.admissionUsed > this.limits.credits) this.close('actual_cost_exceeded');
  }

  releasePaid(state: RunReservationState): void {
    if (state.settled || state.dispatched) return;
    state.settled = true;
    state.settlementObserved = true;
    state.admissionUsed = 0;
    state.reportedCredits = 0;
    state.costKnown = true;
    this.reservations.delete(state);
    this.reservedCredits = Math.max(0, this.reservedCredits - state.estimate);
    state.operationReservation.release();
  }

  markPaidDispatched(state: RunReservationState, signal?: AbortSignal): void {
    try {
      if (signal?.aborted) throw new BenchmarkAdmissionError('cancelled', 'Benchmark run was cancelled before dispatch');
      if (state.settled) throw new BenchmarkAdmissionError('run_limit', 'Paid reservation is no longer active');
      if (state.dispatched) throw new BenchmarkAdmissionError('run_limit', 'Paid reservation was already dispatched');
      this.assertWithinRunDeadline();
      if (this.paidClosed) throw new BenchmarkAdmissionError(this.paidClosedReason || 'run_limit', 'Run paid admission is closed');
      if (this.admissionUsed + this.reservedCredits > this.limits.credits) {
        this.close('run_limit');
        throw new BenchmarkAdmissionError('run_limit', 'Run paid budget changed before dispatch');
      }
      if (this.httpDispatchCount >= this.limits.httpDispatches) {
        this.close('run_limit');
        throw new BenchmarkAdmissionError('run_limit', 'Run HTTP dispatch limit was reached');
      }
      // This synchronous section is the only point that consumes both the paid
      // dispatch allowance and the local HTTP allowance.
      state.operationReservation.markDispatched(signal);
      state.dispatched = true;
      this.httpDispatchCount++;
    } catch (error) {
      if (!state.settled && !state.dispatched) this.releasePaid(state);
      throw error;
    }
  }

  close(reason: BenchmarkAdmissionErrorCode): void {
    if (this.paidClosed) return;
    this.paidClosed = true;
    this.paidClosedReason = reason;
  }

  private closeForOperation(operation: OperationReservation): void {
    const reason = operationSnapshotReason(operation);
    if (reason === 'request_cost_limit' || reason === 'actual_cost_exceeded') {
      this.close(reason);
    }
  }

  snapshot(): BenchmarkRunSnapshot {
    return {
      runId: this.options.runId,
      mode: this.options.mode,
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      admissionUsed: this.admissionUsed,
      reservedCredits: this.reservedCredits,
      reportedCredits: this.reportedCredits,
      reportedCostKnown: this.reportedCostKnown,
      unknownCostAttempts: this.unknownCostAttempts,
      httpDispatchCount: this.httpDispatchCount,
      paidClosed: this.paidClosed,
      ...(this.paidClosedReason ? { paidClosedReason: this.paidClosedReason } : {})
    };
  }

  private assertWithinRunDeadline(): void {
    if (this.now() >= this.deadlineAt) {
      this.close('deadline_exceeded');
      throw new BenchmarkAdmissionError('deadline_exceeded', 'Benchmark run deadline was reached');
    }
  }
}

export class RunReservation {
  constructor(
    private readonly owner: BenchmarkRunAdmission,
    private readonly state: RunReservationState
  ) {}

  get estimate(): number { return this.state.estimate; }
  get dispatched(): boolean { return this.state.dispatched; }
  get settled(): boolean { return this.state.settled; }
  get settlementObserved(): boolean { return this.state.settlementObserved; }
  get admissionUsed(): number { return this.state.admissionUsed; }
  get reportedCredits(): number | null { return this.state.reportedCredits; }
  get costKnown(): boolean | null { return this.state.costKnown; }

  markDispatched(signal?: AbortSignal): void { this.owner.markPaidDispatched(this.state, signal); }
  settle(actualCredits: number | null): void { this.owner.settlePaid(this.state, actualCredits); }
  release(): void { this.owner.releasePaid(this.state); }
}

const activeRunIds = new Set<string>();
const completedRunIds = new Set<string>();

/** Process-local exclusive guard; CLI adds a file lock for cross-process use. */
export function acquireBenchmarkRunId(runId: string): () => void {
  if (activeRunIds.has(runId) || completedRunIds.has(runId)) {
    throw new BenchmarkAdmissionError('run_in_use', `Benchmark run ${runId} is already active or complete`);
  }
  activeRunIds.add(runId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRunIds.delete(runId);
  };
}

export function markBenchmarkRunCompleted(runId: string): void {
  activeRunIds.delete(runId);
  completedRunIds.add(runId);
}

function operationSnapshotReason(operation: OperationReservation): BenchmarkAdmissionErrorCode | undefined {
  return operation.snapshot().paidClosedReason;
}

function validateEstimate(value: number): void {
  if (!isSafeCredit(value)) throw new BenchmarkAdmissionError('pricing_unknown', 'Benchmark request pricing is unknown');
}

function isSafeCredit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertSafeNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new BenchmarkAdmissionError('run_limit', `${label} must be a non-negative safe integer`);
}
