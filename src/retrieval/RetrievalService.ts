import { RetrievalCostLedger, RetrievalCostPolicy } from './RetrievalCostPolicy.js';
import { OutboundSecurityPolicy, type OutboundPurpose } from './OutboundSecurityPolicy.js';
import { RetrievalRetryPolicy } from './RetrievalRetryPolicy.js';
import { createConcurrencyLimiter, type ConcurrencyLimit } from '../utils/ConcurrencyLimiter.js';
import {
  RetrievalError,
  type RetrievalCostController,
  type RetrievalCostObservation,
  type RetrievalCostReservation,
  type RetrievalOperationContext,
  type RetrievalOperationDiagnostics,
  type RetrievalProvider,
  type RetrievalRequest,
  type RetrievalResponse,
  type RetrievalStrategy
} from './types.js';
import { parseRetrievalConfiguration, type RetrievalConfiguration } from './Configuration.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';

export const RETRIEVAL_OPERATION_TIMEOUT_MS = 120_000;
const MAX_PAID_STRATEGY_SELECTIONS = 3;
const MAX_BROWSER_DISPATCHES = 1;
const GLOBAL_STRATEGY_SCOPE = '__global__';

export interface RetrievalOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  operationId?: string;
}

export interface RetrievalServiceOptions {
  directProvider: RetrievalProvider;
  scrapingAntProvider?: RetrievalProvider;
  costPolicy?: RetrievalCostPolicy;
  configuration?: RetrievalConfiguration;
  securityPolicy?: OutboundSecurityPolicy;
  maxConcurrency?: number;
  operationTimeoutMs?: number;
  retrySleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  retryRandom?: () => number;
  now?: () => number;
}

export interface RetrievalStrategyState {
  readonly previousResponse?: RetrievalResponse;
  readonly previousError?: RetrievalError;
  readonly attemptedStrategies: readonly RetrievalStrategy[];
}

export interface RetrievalStrategyStep {
  readonly request: RetrievalRequest;
  readonly shouldAttempt?: (state: RetrievalStrategyState) => boolean | Promise<boolean>;
  readonly isTerminalResponse?: (response: RetrievalResponse, state: RetrievalStrategyState) => boolean | Promise<boolean>;
  readonly continueOnError?: (error: RetrievalError, state: RetrievalStrategyState) => boolean | Promise<boolean>;
  /** Domain-owned response predicate for retries that are represented as successful HTTP responses. */
  readonly retryResponse?: (response: RetrievalResponse) => boolean | Promise<boolean>;
}

export interface RetrievalStrategyPlanOptions {
  readonly maxPaidStrategySelections?: number;
  readonly maxBrowserDispatches?: number;
  /** Business sub-scope for per-DOI browser/strategy limits on one operation. */
  readonly scopeId?: string;
}

export interface RetrievalRetryOptions {
  readonly strategyScopeId?: string;
  readonly shouldRetryResponse?: (response: RetrievalResponse) => boolean | Promise<boolean>;
}

export interface RetrievalProcessStatus {
  readonly enabled: boolean;
  readonly browserAllowed: boolean;
  readonly capabilities: {
    readonly directHtml: boolean;
    readonly scrapingAntHtml: boolean;
    readonly iframeDocuments: boolean;
    readonly browser: boolean;
  };
  readonly budgetDefaults: {
    readonly maxCreditsPerOperation: number;
    readonly maxCreditsPerRequest: number;
  };
  readonly observationScope: 'process';
  readonly requestCount: number;
  readonly reportedCredits: number;
  readonly reportedCreditsKnown: boolean;
  readonly unknownCostAttempts: number;
  readonly lastRequestCredits: number | null;
  readonly lastStrategy?: RetrievalStrategy;
  readonly lastApiStatus?: number;
  readonly lastTargetStatus?: number;
}

interface ManagedOperationContext extends RetrievalOperationContext {
  readonly dispose: () => void;
  readonly timedOut: () => boolean;
}

interface OperationMetadata {
  dispatchCount: number;
  strategyCounts: Record<RetrievalStrategy, number>;
  lastStrategy?: RetrievalStrategy;
  lastApiStatus?: number;
  lastTargetStatus?: number;
  reservations: Map<string, RetrievalCostReservation>;
  pendingReconciliations: WeakMap<object, RetrievalCostObservation>;
  dispatchSequences: WeakMap<object, number>;
  selectionTokens: Set<string>;
  strategyScopes: Map<string, StrategyScope>;
}

interface StrategyScope {
  paidStrategySelections: number;
  browserDispatches: number;
  selectionTokens: Set<string>;
}

/**
 * Single orchestration boundary for provider admission, cancellation, and
 * bounded attempts. It does not parse academic documents or choose business
 * fallback strategies.
 */
export class RetrievalService {
  private readonly directProvider: RetrievalProvider;
  private readonly scrapingAntProvider?: RetrievalProvider;
  private readonly costPolicy: RetrievalCostPolicy;
  private readonly configuration: RetrievalConfiguration;
  private readonly securityPolicy: OutboundSecurityPolicy;
  private readonly limiter: ConcurrencyLimit;
  private readonly operationTimeoutMs: number;
  private readonly retrySleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly retryRandom?: () => number;
  private readonly now: () => number;
  private readonly operationMetadata = new WeakMap<object, OperationMetadata>();
  private operationSequence = 0;
  private retrySequence = 0;
  private strategySequence = 0;
  private requestSequence = 0;
  private lastRequestSequence = 0;
  private requestCount = 0;
  private reportedCredits = 0;
  private reportedCreditsKnown = true;
  private unknownCostAttempts = 0;
  private lastRequestCredits: number | null = null;
  private lastStrategy?: RetrievalStrategy;
  private lastApiStatus?: number;
  private lastTargetStatus?: number;

  constructor(options: RetrievalServiceOptions) {
    this.directProvider = options.directProvider;
    this.scrapingAntProvider = options.scrapingAntProvider;
    const configuration = options.configuration || parseRetrievalConfiguration();
    this.configuration = configuration;
    this.costPolicy = options.costPolicy || new RetrievalCostPolicy({
      budget: configuration.scrapingAnt.maxCreditsPerOperation,
      maxCreditsPerRequest: configuration.scrapingAnt.maxCreditsPerRequest,
      enabled: configuration.scrapingAnt.paidEnabled
    });
    this.securityPolicy = options.securityPolicy || new OutboundSecurityPolicy();
    const configuredConcurrency = options.maxConcurrency ?? configuration.scrapingAnt.maxConcurrency;
    this.limiter = createConcurrencyLimiter(normalizeConcurrency(configuredConcurrency));
    this.operationTimeoutMs = normalizeTimeout(options.operationTimeoutMs ?? RETRIEVAL_OPERATION_TIMEOUT_MS);
    this.retrySleep = options.retrySleep;
    this.retryRandom = options.retryRandom;
    this.now = options.now || Date.now;
  }

  createOperation(options: RetrievalOperationOptions = {}): ManagedOperationContext {
    const controller = new AbortController();
    const timeoutMs = normalizeTimeout(options.timeoutMs ?? this.operationTimeoutMs);
    const startedAt = this.now();
    const deadlineAt = startedAt + timeoutMs;
    let timedOut = false;
    let disposed = false;
    const parentSignal = options.signal;
    const onParentAbort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    const context: ManagedOperationContext = {
      operationId: options.operationId || `retrieval-operation-${++this.operationSequence}`,
      signal: controller.signal,
      deadlineAt,
      cost: this.costPolicy.createLedger(),
      remainingMs: () => Math.max(0, deadlineAt - this.now()),
      timedOut: () => timedOut || this.now() >= deadlineAt,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onParentAbort);
        controller.abort();
      }
    };
    this.operationMetadata.set(context, {
      dispatchCount: 0,
      strategyCounts: { direct: 0, static: 0, browser: 0 },
      reservations: new Map(),
      pendingReconciliations: new WeakMap(),
      dispatchSequences: new WeakMap(),
      selectionTokens: new Set(),
      strategyScopes: new Map()
    });
    return context;
  }

  async withOperation<T>(
    work: (context: RetrievalOperationContext) => Promise<T>,
    options: RetrievalOperationOptions = {}
  ): Promise<T> {
    const context = this.createOperation(options);
    try {
      return await work(context);
    } finally {
      context.dispose();
    }
  }

  async retrieve(request: RetrievalRequest, context?: RetrievalOperationContext): Promise<RetrievalResponse> {
    const operation = context || this.createOperation();
    const ownsOperation = !context;
    try {
      return await this.retrieveInOperation(request, operation);
    } catch (error) {
      const safeError = this.normalizeError(error, operation);
      if (isFinalProviderFailure(safeError) && request.strategy !== 'direct') {
        operation.cost.close('provider_error');
      }
      throw safeError;
    } finally {
      if (ownsOperation && isManagedOperation(operation)) operation.dispose();
    }
  }

  async retrieveWithRetry(
    request: RetrievalRequest,
    context?: RetrievalOperationContext,
    retryOptions: RetrievalRetryOptions = {}
  ): Promise<RetrievalResponse> {
    const operation = context || this.createOperation();
    const ownsOperation = !context;
    const policy = new RetrievalRetryPolicy(request.strategy);
    const selectionToken = `retrieval-retry-${++this.retrySequence}`;
    const linkedSignal = linkAbortSignals(operation.signal, request.signal);
    try {
      return await ErrorHandler.retryWithBackoff(
        async () => {
          const response = await this.retrieveInOperation(request, operation, selectionToken, retryOptions.strategyScopeId);
          if (retryOptions.shouldRetryResponse && await retryOptions.shouldRetryResponse(response)) {
            throw new RetrievalError({
              code: 'server_error',
              message: 'Retrieval target returned a retryable server error',
              provider: response.provider,
              apiStatus: response.apiStatus,
              targetStatus: response.targetStatus,
              retryable: true,
              cost: response.cost
            });
          }
          return response;
        },
        {
          ...policy.options(),
          context: `retrieval:${request.purpose}`,
          signal: linkedSignal.signal,
          ...(this.retrySleep ? { sleep: this.retrySleep } : {}),
          ...(this.retryRandom ? { random: this.retryRandom } : {}),
          shouldRetry: error => {
            if (!policy.shouldRetry(error)) return false;
            return request.strategy === 'direct' || !operation.cost.snapshot().paidClosed;
          }
        }
      );
    } catch (error) {
      const safeError = this.normalizeError(error, operation, linkedSignal.signal);
      if (isFinalProviderFailure(safeError) && request.strategy !== 'direct') {
        operation.cost.close('provider_error');
      }
      throw safeError;
    } finally {
      linkedSignal.dispose();
      if (ownsOperation && isManagedOperation(operation)) operation.dispose();
    }
  }

  async retrieveWithStrategies(
    steps: readonly RetrievalStrategyStep[],
    context?: RetrievalOperationContext,
    options: RetrievalStrategyPlanOptions = {}
  ): Promise<RetrievalResponse> {
    const operation = context || this.createOperation();
    const ownsOperation = !context;
    const metadata = this.metadataFor(operation);
    const maxPaidSelections = options.maxPaidStrategySelections ?? Number.POSITIVE_INFINITY;
    const maxBrowserDispatches = options.maxBrowserDispatches ?? 1;
    let state: RetrievalStrategyState = { attemptedStrategies: [] };
    let lastResponse: RetrievalResponse | undefined;
    let lastError: RetrievalError | undefined;

    try {
      for (const step of steps) {
        if (step.shouldAttempt && !(await step.shouldAttempt(state))) continue;
        const counters = this.strategyCounters(metadata, options.scopeId);
        if (step.request.strategy !== 'direct' && counters.paidStrategySelections >= maxPaidSelections) {
          lastError = new RetrievalError({ code: 'budget', message: 'The retrieval strategy selection limit was reached' });
          break;
        }
        if (step.request.strategy === 'browser' && counters.browserDispatches >= maxBrowserDispatches) {
          lastError = new RetrievalError({ code: 'budget', message: 'The browser strategy dispatch limit was reached' });
          break;
        }

        const beforeDispatches = metadata.dispatchCount;
        try {
          const response = await this.retrieveWithRetry(step.request, operation, {
            strategyScopeId: options.scopeId,
            shouldRetryResponse: step.retryResponse
          });
          if (metadata.dispatchCount > beforeDispatches && step.request.strategy !== 'direct') {
            state = {
              ...state,
              attemptedStrategies: [...state.attemptedStrategies, step.request.strategy]
            };
          }
          lastResponse = response;
          state = { ...state, previousResponse: response, previousError: undefined };
          if (step.isTerminalResponse && await step.isTerminalResponse(response, state) !== false) return response;
        } catch (error) {
          if (metadata.dispatchCount > beforeDispatches && step.request.strategy !== 'direct') {
            state = {
              ...state,
              attemptedStrategies: [...state.attemptedStrategies, step.request.strategy]
            };
          }
          const safeError = this.normalizeError(error, operation);
          lastError = safeError;
          state = { ...state, previousError: safeError, previousResponse: undefined };
          if (!step.continueOnError || !(await step.continueOnError(safeError, state))) throw safeError;
        }
      }

      if (lastResponse) return lastResponse;
      throw lastError || new RetrievalError({ code: 'provider_error', message: 'No retrieval strategy completed' });
    } finally {
      if (ownsOperation && isManagedOperation(operation)) operation.dispose();
    }
  }

  getProcessStatus(): RetrievalProcessStatus {
    return {
      enabled: this.costPolicy.enabled,
      browserAllowed: this.configuration.scrapingAnt.browserAllowed,
      capabilities: {
        directHtml: this.directProvider.capabilities.html,
        scrapingAntHtml: this.scrapingAntProvider?.capabilities.html || false,
        iframeDocuments: this.scrapingAntProvider?.capabilities.iframeDocuments || false,
        browser: this.scrapingAntProvider?.capabilities.browser || false
      },
      budgetDefaults: {
        maxCreditsPerOperation: this.costPolicy.budget,
        maxCreditsPerRequest: this.costPolicy.maxCreditsPerRequest
      },
      observationScope: 'process',
      requestCount: this.requestCount,
      reportedCredits: this.reportedCredits,
      reportedCreditsKnown: this.reportedCreditsKnown,
      unknownCostAttempts: this.unknownCostAttempts,
      lastRequestCredits: this.lastRequestCredits,
      lastStrategy: this.lastStrategy,
      lastApiStatus: this.lastApiStatus,
      lastTargetStatus: this.lastTargetStatus
    };
  }

  getOperationStatus(context: RetrievalOperationContext): RetrievalOperationDiagnostics {
    const cost = context.cost.snapshot();
    const metadata = this.metadataFor(context);
    return {
      operationId: context.operationId,
      budget: cost.budget,
      requestCount: metadata.dispatchCount,
      strategyCounts: { ...metadata.strategyCounts },
      admissionUsed: cost.admissionUsed,
      reservedCredits: cost.reservedCredits,
      reportedCredits: cost.reportedCredits,
      reportedCreditsKnown: cost.reportedCreditsKnown,
      unknownCostAttempts: cost.unknownCostAttempts,
      paidClosed: cost.paidClosed,
      paidClosedReason: cost.paidClosedReason,
      lastStrategy: metadata.lastStrategy,
      lastApiStatus: metadata.lastApiStatus,
      lastTargetStatus: metadata.lastTargetStatus
    };
  }

  getOperationDiagnostics(context: RetrievalOperationContext): RetrievalOperationDiagnostics {
    return this.getOperationStatus(context);
  }

  getOperationReservation(
    context: RetrievalOperationContext,
    attemptId: string
  ): RetrievalCostReservation | undefined {
    return this.metadataFor(context).reservations.get(attemptId);
  }

  reconcileCost(
    context: RetrievalOperationContext,
    reservation: RetrievalCostReservation,
    observation: RetrievalCostObservation
  ): void {
    const before = context.cost.snapshot();
    context.cost.reconcile?.(reservation, observation);
    const after = context.cost.snapshot();
    const reportedDelta = after.reportedCredits - before.reportedCredits;
    const unknownDelta = after.unknownCostAttempts - before.unknownCostAttempts;
    this.reportedCredits += Math.max(0, reportedDelta);
    this.unknownCostAttempts = Math.max(0, this.unknownCostAttempts + unknownDelta);
    this.reportedCreditsKnown = this.unknownCostAttempts === 0;

    const metadata = this.metadataFor(context);
    const accepted = reportedDelta > 0 || unknownDelta < 0;
    if (accepted) {
      metadata.pendingReconciliations.delete(reservation);
      if (observation.known) {
        this.updateLastRequestCredits(observation.credits, metadata.dispatchSequences.get(reservation));
      }
    } else if (observation.known) {
      // The ledger buffers a known observation until its unknown settlement;
      // retain it so same-turn settlement can update per-request diagnostics.
      metadata.pendingReconciliations.set(reservation, observation);
    }
  }

  private async retrieveInOperation(
    request: RetrievalRequest,
    context: RetrievalOperationContext,
    selectionToken?: string,
    strategyScopeId?: string
  ): Promise<RetrievalResponse> {
    throwIfCancelled(request.signal, context);
    const provider = this.selectProvider(request);
    validateCapability(provider, request);

    const linkedSignal = linkAbortSignals(context.signal, request.signal);
    try {
      return await this.limiter(
        () => this.runAttempt(provider, request, context, selectionToken, strategyScopeId),
        linkedSignal.signal
      );
    } catch (error) {
      throw this.normalizeError(error, context, linkedSignal.signal);
    } finally {
      linkedSignal.dispose();
    }
  }

  private async runAttempt(
    provider: RetrievalProvider,
    request: RetrievalRequest,
    context: RetrievalOperationContext,
    selectionToken?: string,
    strategyScopeId?: string
  ): Promise<RetrievalResponse> {
    throwIfCancelled(request.signal, context);
    await this.validateTarget(request.url, request.purpose, context, request.signal);
    throwIfCancelled(request.signal, context);

    let reservation: RetrievalCostReservation | undefined;
    let strategyToken: string | undefined;
    if (provider.capabilities.paid) {
      const estimate = this.costPolicy.estimate(request.url, request.strategy);
      if (!estimate.known) {
        context.cost.close(estimate.reason);
        throw new RetrievalError({ code: 'budget', message: 'Paid retrieval was not admitted', provider: provider.name });
      }
      reservation = context.cost.reserve(estimate.credits) || undefined;
      if (!reservation) {
        throw new RetrievalError({ code: 'budget', message: 'Paid retrieval budget is unavailable', provider: provider.name });
      }
    }

    try {
      strategyToken = this.reserveStrategySelection(request.strategy, context, selectionToken, strategyScopeId);
    } catch (error) {
      reservation?.release();
      throw error;
    }

    let providerInvoked = false;
    let dispatchSequence: number | undefined;
    try {
      if (reservation) this.metadataFor(context).reservations.set(reservation.attemptId, reservation);
      const response = await this.dispatchProviderAttempt(provider, request, context, reservation, () => {
        if (reservation && !reservation.markDispatched()) {
          throw new RetrievalError({ code: 'budget', message: 'Paid retrieval budget is unavailable', provider: provider.name });
        }
        providerInvoked = true;
        dispatchSequence = this.recordDispatch(request.strategy, context, reservation);
      });
      this.recordResponse(response, context, dispatchSequence);
      if (reservation) {
        context.cost.settle(reservation, response.cost);
        this.metadataFor(context).pendingReconciliations.delete(reservation);
      }
      return response;
    } catch (error) {
      const safeError = this.normalizeError(error, context);
      this.lastApiStatus = safeError.apiStatus;
      this.lastTargetStatus = safeError.targetStatus;
      const metadata = this.metadataFor(context);
      metadata.lastApiStatus = safeError.apiStatus;
      metadata.lastTargetStatus = safeError.targetStatus;
      if (!providerInvoked) {
        if (reservation) {
          metadata.reservations.delete(reservation.attemptId);
          reservation.release();
        }
        this.releaseStrategySelection(request.strategy, context, strategyToken, strategyScopeId);
        throw safeError;
      }
      if (reservation) {
        const observation = safeError.cost || { known: false, credits: null, reason: 'missing_billing_header' };
        const metadata = this.metadataFor(context);
        const pendingObservation = metadata.pendingReconciliations.get(reservation);
        const diagnosticObservation = observation.known ? observation : pendingObservation;
        const beforeCost = context.cost.snapshot();
        context.cost.settle(reservation, observation);
        metadata.pendingReconciliations.delete(reservation);
        this.recordCostDelta(
          beforeCost,
          context.cost.snapshot(),
          diagnosticObservation,
          dispatchSequence
        );
      }
      throw safeError;
    }
  }

  private async dispatchProviderAttempt(
    provider: RetrievalProvider,
    request: RetrievalRequest,
    context: RetrievalOperationContext,
    reservation: RetrievalCostReservation | undefined,
    onDispatch: () => void
  ): Promise<RetrievalResponse> {
    const linkedSignal = linkAbortSignals(context.signal, request.signal);
    let cancelledBeforeProviderCompletion = false;
    let rejectCancellation!: (error: RetrievalError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      cancelledBeforeProviderCompletion = true;
      const managed = context as Partial<ManagedOperationContext>;
      rejectCancellation(new RetrievalError({
        code: managed.timedOut?.() || context.remainingMs() <= 0 ? 'timeout' : 'cancelled',
        message: managed.timedOut?.() || context.remainingMs() <= 0
          ? 'Retrieval operation timed out'
          : 'Retrieval operation was cancelled',
        provider: provider.name,
        cost: provider.capabilities.paid
          ? { known: false, credits: null, reason: 'cancelled_before_provider_completion' }
          : { known: true, credits: 0 }
      }));
    };
    const providerPromise = Promise.resolve().then(() => {
      if (linkedSignal.signal.aborted) {
        onAbort();
        throw new RetrievalError({
          code: (context as Partial<ManagedOperationContext>).timedOut?.() || context.remainingMs() <= 0 ? 'timeout' : 'cancelled',
          message: (context as Partial<ManagedOperationContext>).timedOut?.() || context.remainingMs() <= 0
            ? 'Retrieval operation timed out'
            : 'Retrieval operation was cancelled',
          provider: provider.name,
          cost: provider.capabilities.paid
            ? { known: false, credits: null, reason: 'cancelled_before_provider_dispatch' }
            : { known: true, credits: 0 }
        });
      }
      onDispatch();
      return provider.retrieve(request, context);
    });

    try {
      if (linkedSignal.signal.aborted) onAbort();
      else linkedSignal.signal.addEventListener('abort', onAbort, { once: true });
      return await Promise.race([providerPromise, cancellation]);
    } catch (error) {
      if (cancelledBeforeProviderCompletion && reservation) {
        this.observeLateAttempt(providerPromise, context, reservation);
      }
      throw error;
    } finally {
      linkedSignal.signal.removeEventListener('abort', onAbort);
      linkedSignal.dispose();
    }
  }

  private observeLateAttempt(
    providerPromise: Promise<RetrievalResponse>,
    context: RetrievalOperationContext,
    reservation: RetrievalCostReservation
  ): void {
    void providerPromise.then(
      response => this.reconcileCost(context, reservation, response.cost),
      error => {
        const typedError = error && typeof error === 'object' ? error as Partial<RetrievalError> : undefined;
        if (typedError?.cost) this.reconcileCost(context, reservation, typedError.cost);
        if (typedError?.lateCost) {
          void typedError.lateCost.then(cost => this.reconcileCost(context, reservation, cost)).catch(() => undefined);
        }
      }
    ).catch(() => undefined);
  }

  private async validateTarget(
    url: string,
    purpose: RetrievalRequest['purpose'],
    context: RetrievalOperationContext,
    requestSignal?: AbortSignal
  ): Promise<void> {
    const linkedSignal = linkAbortSignals(context.signal, requestSignal);
    let rejectCancellation!: (error: RetrievalError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const onAbort = () => {
      const managed = context as Partial<ManagedOperationContext>;
      rejectCancellation(new RetrievalError({
        code: managed.timedOut?.() || context.remainingMs() <= 0 ? 'timeout' : 'cancelled',
        message: managed.timedOut?.() || context.remainingMs() <= 0
          ? 'Retrieval operation timed out'
          : 'Retrieval operation was cancelled'
      }));
    };
    try {
      if (linkedSignal.signal.aborted) onAbort();
      else linkedSignal.signal.addEventListener('abort', onAbort, { once: true });
      await Promise.race([
        this.securityPolicy.validate(url, purpose as OutboundPurpose),
        cancellation
      ]);
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError({ code: 'security', message: 'Retrieval target was rejected by outbound security policy' });
    } finally {
      linkedSignal.signal.removeEventListener('abort', onAbort);
      linkedSignal.dispose();
    }
  }

  private selectProvider(request: RetrievalRequest): RetrievalProvider {
    if (request.strategy === 'direct') return this.directProvider;
    if (this.scrapingAntProvider) return this.scrapingAntProvider;
    throw new RetrievalError({
      code: 'configuration',
      message: 'The requested paid retrieval provider is unavailable'
    });
  }

  private reserveStrategySelection(
    strategy: RetrievalStrategy,
    context: RetrievalOperationContext,
    selectionToken?: string,
    strategyScopeId?: string
  ): string | undefined {
    if (strategy === 'direct') return undefined;
    if (strategy === 'browser' && !this.configuration.scrapingAnt.browserAllowed) {
      throw new RetrievalError({ code: 'configuration', message: 'Browser escalation is not enabled' });
    }

    const metadata = this.metadataFor(context);
    const counters = this.strategyCounters(metadata, strategyScopeId);
    const token = selectionToken || `retrieval-selection-${++this.strategySequence}`;
    if (counters.selectionTokens.has(token)) return token;
    if (counters.paidStrategySelections >= MAX_PAID_STRATEGY_SELECTIONS) {
      throw new RetrievalError({ code: 'budget', message: 'The retrieval strategy selection limit was reached' });
    }
    if (strategy === 'browser' && counters.browserDispatches >= MAX_BROWSER_DISPATCHES) {
      throw new RetrievalError({ code: 'budget', message: 'The browser strategy dispatch limit was reached' });
    }

    counters.selectionTokens.add(token);
    counters.paidStrategySelections++;
    if (strategy === 'browser') counters.browserDispatches++;
    return token;
  }

  private releaseStrategySelection(
    strategy: RetrievalStrategy,
    context: RetrievalOperationContext,
    token: string | undefined,
    strategyScopeId?: string
  ): void {
    if (strategy === 'direct' || !token) return;
    const metadata = this.metadataFor(context);
    const counters = this.strategyCounters(metadata, strategyScopeId);
    if (!counters.selectionTokens.delete(token)) return;
    counters.paidStrategySelections = Math.max(0, counters.paidStrategySelections - 1);
    if (strategy === 'browser') counters.browserDispatches = Math.max(0, counters.browserDispatches - 1);
  }

  private recordDispatch(
    strategy: RetrievalStrategy,
    context: RetrievalOperationContext,
    reservation?: RetrievalCostReservation
  ): number {
    const requestSequence = ++this.requestSequence;
    this.requestCount++;
    this.lastRequestSequence = requestSequence;
    this.lastStrategy = strategy;
    const metadata = this.metadataFor(context);
    metadata.dispatchCount++;
    metadata.strategyCounts[strategy]++;
    metadata.lastStrategy = strategy;
    if (reservation) metadata.dispatchSequences.set(reservation, requestSequence);
    return requestSequence;
  }

  private metadataFor(context: RetrievalOperationContext): OperationMetadata {
    const key = context as object;
    const existing = this.operationMetadata.get(key);
    if (existing) return existing;
    const created: OperationMetadata = {
      dispatchCount: 0,
      strategyCounts: { direct: 0, static: 0, browser: 0 },
      reservations: new Map(),
      pendingReconciliations: new WeakMap(),
      dispatchSequences: new WeakMap(),
      selectionTokens: new Set(),
      strategyScopes: new Map()
    };
    this.operationMetadata.set(key, created);
    return created;
  }

  private strategyCounters(metadata: OperationMetadata, scopeId?: string): StrategyScope {
    const key = scopeId || GLOBAL_STRATEGY_SCOPE;
    let counters = metadata.strategyScopes.get(key);
    if (!counters) {
      counters = { paidStrategySelections: 0, browserDispatches: 0, selectionTokens: new Set() };
      metadata.strategyScopes.set(key, counters);
    }
    return counters;
  }

  private recordResponse(
    response: RetrievalResponse,
    context: RetrievalOperationContext,
    requestSequence?: number
  ): void {
    this.lastApiStatus = response.apiStatus;
    this.lastTargetStatus = response.targetStatus;
    const metadata = this.metadataFor(context);
    metadata.lastApiStatus = response.apiStatus;
    metadata.lastTargetStatus = response.targetStatus;
    this.recordCost(response.cost, requestSequence);
  }

  private recordCost(observation: RetrievalCostObservation, requestSequence?: number): void {
    if (observation.known) {
      this.reportedCredits += observation.credits;
      this.updateLastRequestCredits(observation.credits, requestSequence);
    } else {
      this.reportedCreditsKnown = false;
      this.updateLastRequestCredits(null, requestSequence);
      this.unknownCostAttempts++;
    }
  }

  private recordCostDelta(
    before: ReturnType<RetrievalCostController['snapshot']>,
    after: ReturnType<RetrievalCostController['snapshot']>,
    observation?: RetrievalCostObservation,
    requestSequence?: number
  ): void {
    const reportedDelta = after.reportedCredits - before.reportedCredits;
    if (reportedDelta > 0) this.reportedCredits += reportedDelta;

    const unknownDelta = after.unknownCostAttempts - before.unknownCostAttempts;
    if (unknownDelta !== 0) {
      this.unknownCostAttempts = Math.max(0, this.unknownCostAttempts + unknownDelta);
      if (unknownDelta > 0) this.updateLastRequestCredits(null, requestSequence);
    }
    if (observation?.known) this.updateLastRequestCredits(observation.credits, requestSequence);
    this.reportedCreditsKnown = this.unknownCostAttempts === 0;
  }

  private updateLastRequestCredits(credits: number | null, requestSequence?: number): void {
    if (requestSequence !== undefined && requestSequence < this.lastRequestSequence) return;
    this.lastRequestCredits = credits;
  }

  private normalizeError(error: unknown, context: RetrievalOperationContext, signal?: AbortSignal): RetrievalError {
    const managed = context as Partial<ManagedOperationContext>;
    if (error instanceof RetrievalError) {
      if (error.code === 'cancelled' && managed.timedOut?.()) {
        return new RetrievalError({
          code: 'timeout',
          message: 'Retrieval operation timed out',
          provider: error.provider,
          status: error.status,
          apiStatus: error.apiStatus,
          targetStatus: error.targetStatus,
          retryable: false,
          cost: error.cost,
          lateCost: error.lateCost
        });
      }
      return error;
    }
    if (context.signal.aborted) {
      return new RetrievalError({
        code: managed.timedOut?.() ? 'timeout' : 'cancelled',
        message: managed.timedOut?.() ? 'Retrieval operation timed out' : 'Retrieval operation was cancelled'
      });
    }
    if (signal?.aborted) {
      return new RetrievalError({ code: 'cancelled', message: 'Retrieval operation was cancelled' });
    }
    return new RetrievalError({ code: 'network', message: 'Retrieval attempt failed', retryable: true });
  }
}

function isFinalProviderFailure(error: RetrievalError): boolean {
  return Boolean(error.provider) && new Set([
    'invalid_request',
    'auth_or_credits_unknown',
    'target_unavailable',
    'concurrency_limited',
    'detected',
    'server_error',
    'network',
    'provider_error'
  ]).has(error.code);
}

function validateCapability(provider: RetrievalProvider, request: RetrievalRequest): void {
  if (request.strategy === 'browser' && !provider.capabilities.browser) {
    throw new RetrievalError({ code: 'configuration', message: 'The selected provider does not support browser retrieval', provider: provider.name });
  }
  if (request.documentFormat === 'html_with_iframes' && !provider.capabilities.iframeDocuments && request.strategy !== 'direct') {
    throw new RetrievalError({ code: 'configuration', message: 'The selected provider does not return iframe documents', provider: provider.name });
  }
}

function throwIfCancelled(signal: AbortSignal | undefined, context: RetrievalOperationContext): void {
  if (signal?.aborted || context.signal.aborted) {
    const managed = context as Partial<ManagedOperationContext>;
    throw new RetrievalError({
      code: managed.timedOut?.() ? 'timeout' : 'cancelled',
      message: managed.timedOut?.() ? 'Retrieval operation timed out' : 'Retrieval operation was cancelled'
    });
  }
  if (context.remainingMs() <= 0) {
    throw new RetrievalError({ code: 'timeout', message: 'Retrieval operation timed out' });
  }
}

function normalizeConcurrency(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 16 ? value : 1;
}

function normalizeTimeout(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : RETRIEVAL_OPERATION_TIMEOUT_MS;
}

function linkAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (primary.aborted || secondary.aborted) controller.abort();
  else {
    primary.addEventListener('abort', relay, { once: true });
    secondary.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', relay);
      secondary.removeEventListener('abort', relay);
      controller.abort();
    }
  };
}

function isManagedOperation(context: RetrievalOperationContext): context is ManagedOperationContext {
  return typeof (context as Partial<ManagedOperationContext>).dispose === 'function';
}

export default RetrievalService;
