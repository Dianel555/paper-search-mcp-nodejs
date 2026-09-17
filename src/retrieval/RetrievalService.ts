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
  type RetrievalPurpose,
  type RetrievalRequest,
  type RetrievalResponse,
  type RetrievalStrategy,
  type RetrievalDispatchObservation,
  type RetrievalDispatchObserver,
  normalizeRetrievalRequest,
  type NormalizedRetrievalRequest,
  type RetrievalCombinationId
} from './types.js';
import { getRetrievalBudgetDefaults, parseRetrievalConfiguration, type RetrievalConfiguration } from './Configuration.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import { createRetrievalDispatchId } from './dispatchId.js';
import { abortForRetrievalOperation, relayAbortReason, retrievalFailureKindForAbort } from './abortDiagnostics.js';

export const RETRIEVAL_OPERATION_TIMEOUT_MS = 120_000;
const MAX_PAID_COMBINATION_SELECTIONS = 4;
const MAX_STATIC_DISPATCHES = 3;
const MAX_BROWSER_DISPATCHES = 1;
const GLOBAL_STRATEGY_SCOPE = '__global__';

export interface RetrievalOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  operationId?: string;
  /** Validated business purpose used only when this operation owns its ledger. */
  purpose?: RetrievalPurpose;
  /** Internal composition seam for a caller-owned accounting controller. */
  cost?: RetrievalCostController;
  /** Internal observer composed after the service's own diagnostics observer. */
  dispatchObserver?: RetrievalDispatchObserver;
  /** Internal observer for the normalized finite provider response only. */
  onNormalizedResponse?: (response: RetrievalResponse, reservation?: RetrievalCostReservation, dispatchId?: string) => void;
  /** Internal observer for a sanitized failure after a submitted attempt. */
  onError?: (error: RetrievalError, reservation?: RetrievalCostReservation, dispatchId?: string) => void;
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
  readonly attemptedCombinations?: readonly RetrievalCombinationId[];
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
  readonly maxPaidStrategySelections?: number;
  readonly maxBrowserDispatches?: number;
  readonly shouldRetryResponse?: (response: RetrievalResponse) => boolean | Promise<boolean>;
}

export interface RetrievalProcessStatus {
  readonly enabled: boolean;
  readonly browserAllowed: boolean;
  readonly residentialAllowed: boolean;
  readonly availableProxyTypes: readonly ('datacenter' | 'residential')[];
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
  readonly httpDispatchCount: number;
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
  httpDispatchCount: number;
  strategyCounts: Record<RetrievalStrategy, number>;
  lastStrategy?: RetrievalStrategy;
  lastApiStatus?: number;
  lastTargetStatus?: number;
  reservations: Map<string, RetrievalCostReservation>;
  pendingReconciliations: WeakMap<object, RetrievalCostObservation>;
  dispatchSequences: WeakMap<object, number>;
  selectionTokens: Set<string>;
  strategyScopes: Map<string, StrategyScope>;
  onNormalizedResponse?: (response: RetrievalResponse, reservation?: RetrievalCostReservation, dispatchId?: string) => void;
  onError?: (error: RetrievalError, reservation?: RetrievalCostReservation, dispatchId?: string) => void;
}

interface StrategyScope {
  /** Number of distinct paid combinations selected in this business scope. */
  paidStrategySelections: number;
  /** Actual browser dispatches, not retry wrappers or reservations. */
  browserDispatches: number;
  pendingBrowserDispatches: number;
  selectionTokens: Map<string, StrategySelectionState>;
  combinations: Map<RetrievalCombinationId, CombinationState>;
  completed: Map<RetrievalCombinationId, StrategyOutcome>;
  flights: Map<RetrievalCombinationId, StrategyFlight>;
}

interface StrategySelectionState {
  readonly combinationId: RetrievalCombinationId;
  readonly newlySelected: boolean;
  dispatched: boolean;
}

interface CombinationState {
  dispatches: number;
  pendingDispatches: number;
}

interface StrategyOutcome {
  readonly response?: RetrievalResponse;
  readonly error?: RetrievalError;
}

interface StrategyFlight {
  readonly controller: AbortController;
  readonly scope: StrategyScope;
  readonly combinationId: RetrievalCombinationId;
  promise: Promise<RetrievalResponse>;
  waiters: number;
  settled: boolean;
}

interface StrategyLimits {
  readonly maxPaidStrategySelections: number;
  readonly maxBrowserDispatches: number;
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
  private readonly suppliedCostPolicy: boolean;
  private readonly operationMetadata = new WeakMap<object, OperationMetadata>();
  private operationSequence = 0;
  private retrySequence = 0;
  private strategySequence = 0;
  private requestSequence = 0;
  private lastRequestSequence = 0;
  private requestCount = 0;
  private httpDispatchCount = 0;
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
    this.suppliedCostPolicy = Boolean(options.costPolicy);
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

  private createOperationLedger(
    purpose?: RetrievalPurpose,
    suppliedController?: RetrievalCostController
  ): RetrievalCostController {
    if (suppliedController) return suppliedController;
    if (this.suppliedCostPolicy) return this.costPolicy.createLedger();
    const defaults = getRetrievalBudgetDefaults(this.configuration, purpose || 'unknown');
    return this.costPolicy.createLedger({
      budget: defaults.maxCreditsPerOperation,
      maxCreditsPerRequest: defaults.maxCreditsPerRequest,
      enabled: this.costPolicy.enabled
    });
  }

  createOperation(options: RetrievalOperationOptions = {}): ManagedOperationContext {
    const controller = new AbortController();
    const timeoutMs = normalizeTimeout(options.timeoutMs ?? this.operationTimeoutMs);
    const startedAt = this.now();
    const deadlineAt = startedAt + timeoutMs;
    let timedOut = false;
    let disposed = false;
    const parentSignal = options.signal;
    const onParentAbort = () => relayAbortReason(controller, parentSignal!);
    const timer = setTimeout(() => {
      timedOut = true;
      abortForRetrievalOperation(controller);
    }, timeoutMs);

    if (parentSignal?.aborted) relayAbortReason(controller, parentSignal);
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    let context!: ManagedOperationContext;
    context = {
      operationId: options.operationId || `retrieval-operation-${++this.operationSequence}`,
      signal: controller.signal,
      deadlineAt,
      cost: this.createOperationLedger(options.purpose, options.cost),
      dispatchObserver: {
        onDispatch: observation => {
          this.recordHttpDispatch(context, observation);
          options.dispatchObserver?.onDispatch?.(observation);
        },
        onResponse: observation => {
          this.recordHttpResponse(context, observation);
          try {
            options.dispatchObserver?.onResponse?.(observation);
          } catch {
            // Response diagnostics cannot change retrieval or accounting.
          }
        },
        onError: observation => options.dispatchObserver?.onError?.(observation)
      },
      withDispatchSlot: <T>(task: () => Promise<T>, signal?: AbortSignal) => this.limiter(task, signal),
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
      httpDispatchCount: 0,
      strategyCounts: { direct: 0, static: 0, browser: 0 },
      reservations: new Map(),
      pendingReconciliations: new WeakMap(),
      dispatchSequences: new WeakMap(),
      selectionTokens: new Set(),
      strategyScopes: new Map(),
      ...(options.onNormalizedResponse ? { onNormalizedResponse: options.onNormalizedResponse } : {}),
      ...(options.onError ? { onError: options.onError } : {})
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

  /** Execute exactly one provider attempt; retry/fallback ownership stays with callers. */
  async retrieveOnce(request: RetrievalRequest, context?: RetrievalOperationContext): Promise<RetrievalResponse> {
    return this.retrieve(request, context);
  }

  async retrieve(request: RetrievalRequest, context?: RetrievalOperationContext): Promise<RetrievalResponse> {
    const operation = context || this.createOperation({ purpose: request.purpose });
    const ownsOperation = !context;
    try {
      return await this.retrieveInOperation(request, operation);
    } catch (error) {
      const safeError = this.normalizeError(error, operation);
      if (isGlobalProviderTermination(safeError) && request.strategy !== 'direct') {
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
    const operation = context || this.createOperation({ purpose: request.purpose });
    const ownsOperation = !context;
    const normalizedRequest = normalizeRetrievalRequest(request);
    const scopeId = retryOptions.strategyScopeId || deriveStrategyScopeId(request);
    const strategyLimits = resolveStrategyLimits(request.purpose, retryOptions);

    try {
      if (!normalizedRequest) {
        return await this.executeRetryLoop(request, operation, retryOptions, scopeId, strategyLimits, operation.signal);
      }

      const provider = this.selectProvider(normalizedRequest);
      validateCapability(provider, normalizedRequest);
      const scope = this.strategyCounters(this.metadataFor(operation), scopeId);
      const combinationId = normalizedRequest.combination.id;
      const completed = scope.completed.get(combinationId);
      if (completed) {
        if (completed.error) throw completed.error;
        if (completed.response) return completed.response;
      }

      let flight = scope.flights.get(combinationId);
      if (!flight) {
        const controller = new AbortController();
        flight = {
          controller,
          scope,
          combinationId,
          promise: Promise.resolve(undefined as unknown as RetrievalResponse),
          waiters: 0,
          settled: false
        };
        scope.flights.set(combinationId, flight);
        const sharedRequest: RetrievalRequest = { ...request, signal: controller.signal };
        flight.promise = this.executeRetryLoop(
          sharedRequest,
          operation,
          retryOptions,
          scopeId,
          strategyLimits,
          controller.signal
        ).then(response => {
          // Strategy re-entry only needs the finite provider/status/cost
          // snapshot. Do not retain provider HTML or iframe bodies in the
          // operation scope after the current waiter has consumed them.
          scope.completed.set(combinationId, { response: compactCachedResponse(response) });
          return response;
        }).catch(error => {
          const safeError = this.normalizeError(error, operation);
          scope.completed.set(combinationId, { error: safeError });
          throw safeError;
        }).finally(() => {
          flight!.settled = true;
          if (scope.flights.get(combinationId) === flight) scope.flights.delete(combinationId);
        });
      }

      flight.waiters++;
      const waiterSignal = linkAbortSignals(operation.signal, request.signal);
      const abortFlightWhenLastWaiterLeaves = () => {
        if (flight && flight.waiters <= 1 && !flight.settled) flight.controller.abort();
      };
      waiterSignal.signal.addEventListener('abort', abortFlightWhenLastWaiterLeaves, { once: true });
      try {
        return await waitForStrategyFlight(
          flight.promise,
          waiterSignal.signal,
          operation,
          provider.name,
          provider.capabilities.paid
        );
      } finally {
        waiterSignal.signal.removeEventListener('abort', abortFlightWhenLastWaiterLeaves);
        waiterSignal.dispose();
        flight.waiters--;
        if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
      }
    } finally {
      if (ownsOperation && isManagedOperation(operation)) operation.dispose();
    }
  }

  private async executeRetryLoop(
    request: RetrievalRequest,
    operation: RetrievalOperationContext,
    retryOptions: RetrievalRetryOptions,
    scopeId: string,
    strategyLimits: StrategyLimits,
    flightSignal: AbortSignal
  ): Promise<RetrievalResponse> {
    const policy = new RetrievalRetryPolicy(request.strategy);
    const selectionToken = `retrieval-retry-${++this.retrySequence}`;
    const linkedSignal = linkAbortSignals(operation.signal, flightSignal);
    try {
      return await ErrorHandler.retryWithBackoff(
        async () => {
          const response = await this.retrieveInOperation(request, operation, selectionToken, scopeId, strategyLimits);
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
      if (isGlobalProviderTermination(safeError) && request.strategy !== 'direct') {
        operation.cost.close('provider_error');
      }
      throw safeError;
    } finally {
      linkedSignal.dispose();
    }
  }

  async retrieveWithStrategies(
    steps: readonly RetrievalStrategyStep[],
    context?: RetrievalOperationContext,
    options: RetrievalStrategyPlanOptions = {}
  ): Promise<RetrievalResponse> {
    const operation = context || this.createOperation({ purpose: inferOperationPurpose(steps) });
    const ownsOperation = !context;
    const metadata = this.metadataFor(operation);
    let state: RetrievalStrategyState = { attemptedStrategies: [], attemptedCombinations: [] };
    let lastResponse: RetrievalResponse | undefined;
    let lastError: RetrievalError | undefined;

    try {
      for (const step of steps) {
        if (step.shouldAttempt && !(await step.shouldAttempt(state))) continue;

        const beforeDispatches = metadata.dispatchCount;
        try {
          const response = await this.retrieveWithRetry(step.request, operation, {
            strategyScopeId: options.scopeId,
            maxPaidStrategySelections: options.maxPaidStrategySelections,
            maxBrowserDispatches: options.maxBrowserDispatches,
            shouldRetryResponse: step.retryResponse
          });
          if (metadata.dispatchCount > beforeDispatches && step.request.strategy !== 'direct') {
            state = appendAttemptedCombination(state, response.combination, step.request.strategy);
          }
          lastResponse = response;
          state = { ...state, previousResponse: response, previousError: undefined };
          if (step.isTerminalResponse && await step.isTerminalResponse(response, state) !== false) return response;
        } catch (error) {
          if (metadata.dispatchCount > beforeDispatches && step.request.strategy !== 'direct') {
            state = appendAttemptedCombination(state, undefined, step.request.strategy);
          }
          const safeError = this.normalizeError(error, operation);
          lastError = safeError;
          state = { ...state, previousError: safeError, previousResponse: undefined };
          if (isUnbypassableStrategyError(safeError, operation)
            || !step.continueOnError
            || !(await step.continueOnError(safeError, state))) throw safeError;
        }
      }

      if (lastResponse) return lastResponse;
      throw lastError || new RetrievalError({ code: 'provider_error', message: 'No retrieval strategy completed' });
    } finally {
      if (ownsOperation && isManagedOperation(operation)) operation.dispose();
    }
  }

  getProcessStatus(): RetrievalProcessStatus {
    const configuredProxyTypes = this.configuration.scrapingAnt.availableProxyTypes;
    const providerProxyTypes = this.scrapingAntProvider?.capabilities.proxyTypes || ['datacenter'] as const;
    const availableProxyTypes = configuredProxyTypes.filter(proxyType => providerProxyTypes.includes(proxyType));
    return {
      enabled: this.costPolicy.enabled,
      browserAllowed: this.configuration.scrapingAnt.browserAllowed && Boolean(this.scrapingAntProvider?.capabilities.browser),
      residentialAllowed: this.configuration.scrapingAnt.residentialAllowed,
      availableProxyTypes,
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
      httpDispatchCount: this.httpDispatchCount,
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
      httpDispatchCount: metadata.httpDispatchCount,
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
    strategyScopeId?: string,
    strategyLimits?: StrategyLimits
  ): Promise<RetrievalResponse> {
    throwIfCancelled(request.signal, context);
    const normalizedRequest = normalizeRetrievalRequest(request);
    if (!normalizedRequest) {
      throw new RetrievalError({
        code: 'configuration',
        message: 'The retrieval strategy and proxy combination is unsupported'
      });
    }
    const provider = this.selectProvider(normalizedRequest);
    if (normalizedRequest.proxyType === 'residential'
      && (!this.configuration.scrapingAnt.residentialAllowed
        || !this.configuration.scrapingAnt.availableProxyTypes.includes('residential'))) {
      throw new RetrievalError({
        code: 'configuration',
        message: 'Residential retrieval is not explicitly authorised and enabled'
      });
    }
    validateCapability(provider, normalizedRequest);
    const stableScopeId = strategyScopeId || deriveStrategyScopeId(normalizedRequest);
    const limits = strategyLimits || resolveStrategyLimits(normalizedRequest.purpose, {});

    const linkedSignal = linkAbortSignals(context.signal, request.signal);
    try {
      return await this.runAttempt(provider, normalizedRequest, context, selectionToken, stableScopeId, limits);
    } catch (error) {
      throw this.normalizeError(error, context, linkedSignal.signal);
    } finally {
      linkedSignal.dispose();
    }
  }

  private async runAttempt(
    provider: RetrievalProvider,
    request: NormalizedRetrievalRequest,
    context: RetrievalOperationContext,
    selectionToken?: string,
    strategyScopeId?: string,
    strategyLimits?: StrategyLimits
  ): Promise<RetrievalResponse> {
    throwIfCancelled(request.signal, context);
    await this.validateTarget(request.url, request.purpose, context, request.signal);
    throwIfCancelled(request.signal, context);

    let reservation: RetrievalCostReservation | undefined;
    let strategyToken: string | undefined;
    if (provider.capabilities.paid) {
      const estimate = this.costPolicy.estimate(request.url, request.strategy, request.proxyType);
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
      strategyToken = this.reserveStrategySelection(
        request,
        context,
        selectionToken,
        strategyScopeId,
        strategyLimits || resolveStrategyLimits(request.purpose, {})
      );
    } catch (error) {
      reservation?.release();
      throw error;
    }

    let providerInvoked = false;
    let dispatchSequence: number | undefined;
    let dispatchId: string | undefined;
    try {
      if (reservation) this.metadataFor(context).reservations.set(reservation.attemptId, reservation);
      const response = await this.dispatchProviderAttempt(provider, request, context, reservation, observation => {
        if (reservation && !reservation.markDispatched()) {
          throw new RetrievalError({ code: 'budget', message: 'Paid retrieval budget is unavailable', provider: provider.name });
        }
        providerInvoked = true;
        dispatchSequence = this.recordDispatch(request, context, reservation, strategyToken, strategyScopeId);
      }, observation => {
        // Redirect hops are distinct benchmark dispatches; terminal
        // callbacks must use the last hop rather than the first submission.
        dispatchId = observation.dispatchId;
      });
      const normalizedResponse = normalizeRetrievalResponse(response, request);
      try {
        this.metadataFor(context).onNormalizedResponse?.(normalizedResponse, reservation, dispatchId);
      } catch {
        // Benchmark/diagnostic observers cannot alter retrieval semantics.
      }
      this.recordResponse(normalizedResponse, context, dispatchSequence);
      if (reservation) {
        context.cost.settle(reservation, normalizedResponse.cost);
        this.metadataFor(context).pendingReconciliations.delete(reservation);
      }
      return normalizedResponse;
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
        this.notifyError(context, safeError, undefined, dispatchId);
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
      this.notifyError(context, safeError, reservation, dispatchId);
      throw safeError;
    }
  }

  private notifyError(
    context: RetrievalOperationContext,
    error: RetrievalError,
    reservation?: RetrievalCostReservation,
    dispatchId?: string
  ): void {
    try {
      this.metadataFor(context).onError?.(error, reservation, dispatchId);
    } catch {
      // Diagnostics cannot alter retrieval, accounting, or fallback semantics.
    }
  }

  private async dispatchProviderAttempt(
    provider: RetrievalProvider,
    request: NormalizedRetrievalRequest,
    context: RetrievalOperationContext,
    reservation: RetrievalCostReservation | undefined,
    onDispatch: (observation: RetrievalDispatchObservation) => void,
    onObservedDispatch?: (observation: RetrievalDispatchObservation) => void
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
        failureKind: retrievalFailureKindForAbort(linkedSignal.signal, context, managed.timedOut?.()),
        cost: provider.capabilities.paid
          ? { known: false, credits: null, reason: 'cancelled_before_provider_completion' }
          : { known: true, credits: 0 }
      }));
    };
    let attemptObserved = false;
    let underlyingProviderPromise: Promise<RetrievalResponse> | undefined;
    const observer: RetrievalDispatchObserver = {
      onDispatch: observation => {
        onObservedDispatch?.(observation);
        // The reservation marker is the first operation at the actual
        // provider boundary. If it rejects, no underlying transport runs and
        // the global HTTP observer is deliberately not notified.
        if (!attemptObserved) {
          onDispatch(observation);
          attemptObserved = true;
        }
        context.dispatchObserver?.onDispatch?.({
          ...observation,
          combination: request.combination.id
        });
      },
      onResponse: observation => {
        try {
          context.dispatchObserver?.onResponse?.({
            ...observation,
            combination: request.combination.id
          });
        } catch {
          // Response diagnostics cannot change retrieval or accounting.
        }
      },
      onError: observation => context.dispatchObserver?.onError?.({
        ...observation,
        combination: request.combination.id
      })
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
          failureKind: retrievalFailureKindForAbort(linkedSignal.signal, context, (context as Partial<ManagedOperationContext>).timedOut?.()),
          cost: provider.capabilities.paid
            ? { known: false, credits: null, reason: 'cancelled_before_provider_dispatch' }
            : { known: true, credits: 0 }
        });
      }
      const providerRequest: RetrievalRequest = { ...request, dispatchObserver: observer };
      // A transport-owning provider reports its own actual dispatch boundary.
      // If an external/legacy context omitted the optional slot, inject the
      // same limiter into the provider context rather than emitting a second
      // synthetic observation around the whole provider call.
      const providerContext = provider.capabilities.transportSlotManagement === true && !context.withDispatchSlot
        ? { ...context, withDispatchSlot: this.limiter }
        : context;
      const invokeProvider = () => provider.retrieve(providerRequest, providerContext);
      // Concrete transport providers acquire source eligibility themselves;
      // their use of context.withDispatchSlot surrounds only the actual HTTP
      // call. Legacy or neutral injected providers retain the outer limiter.
      if (provider.capabilities.transportSlotManagement === true) {
        underlyingProviderPromise = invokeProvider();
        return underlyingProviderPromise;
      }
      // A cancelled caller must not leave a service slot occupied while an
      // abort-ignoring compatibility provider settles its late result.
      return this.limiter(() => {
        // A provider that declares dispatchObservation owns the actual
        // provider_api event even when the legacy outer limiter remains. Do
        // not manufacture a second observation at the limiter boundary.
        if (provider.capabilities.dispatchObservation !== true) {
          observer.onDispatch?.({
            dispatchId: createRetrievalDispatchId(),
            role: 'provider_api',
            origin: safeOrigin(request.url),
            submittedAt: Date.now()
          });
        }
        underlyingProviderPromise = invokeProvider();
        return Promise.race([underlyingProviderPromise, cancellation]);
      }, linkedSignal.signal);
    });

    try {
      if (linkedSignal.signal.aborted) onAbort();
      else linkedSignal.signal.addEventListener('abort', onAbort, { once: true });
      return await Promise.race([providerPromise, cancellation]);
    } catch (error) {
      if (cancelledBeforeProviderCompletion && reservation) {
        this.observeLateAttempt(underlyingProviderPromise || providerPromise, context, reservation);
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
    request: NormalizedRetrievalRequest,
    context: RetrievalOperationContext,
    _selectionToken: string | undefined,
    strategyScopeId: string | undefined,
    limits: StrategyLimits
  ): string | undefined {
    if (request.strategy === 'direct') return undefined;
    if (request.strategy === 'browser' && !this.configuration.scrapingAnt.browserAllowed) {
      throw new RetrievalError({ code: 'configuration', message: 'Browser escalation is not enabled' });
    }

    const metadata = this.metadataFor(context);
    const counters = this.strategyCounters(metadata, strategyScopeId);
    const combinationId = request.combination.id;
    let combination = counters.combinations.get(combinationId);
    if (!combination) {
      if (counters.paidStrategySelections >= limits.maxPaidStrategySelections) {
        throw new RetrievalError({ code: 'budget', message: 'The retrieval strategy selection limit was reached' });
      }
      combination = { dispatches: 0, pendingDispatches: 0 };
      counters.combinations.set(combinationId, combination);
      counters.paidStrategySelections++;
    }

    const perCombinationLimit = request.strategy === 'browser' ? MAX_BROWSER_DISPATCHES : MAX_STATIC_DISPATCHES;
    if (combination.dispatches + combination.pendingDispatches >= perCombinationLimit) {
      throw new RetrievalError({ code: 'budget', message: 'The retrieval combination dispatch limit was reached' });
    }
    if (request.strategy === 'browser'
      && counters.browserDispatches + counters.pendingBrowserDispatches >= limits.maxBrowserDispatches) {
      throw new RetrievalError({ code: 'budget', message: 'The browser strategy dispatch limit was reached' });
    }

    const token = `retrieval-selection-${++this.strategySequence}`;
    counters.selectionTokens.set(token, {
      combinationId,
      newlySelected: combination.dispatches === 0 && combination.pendingDispatches === 0,
      dispatched: false
    });
    combination.pendingDispatches++;
    if (request.strategy === 'browser') counters.pendingBrowserDispatches++;
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
    const selection = counters.selectionTokens.get(token);
    if (!selection) return;
    counters.selectionTokens.delete(token);
    if (selection.dispatched) return;

    const combination = counters.combinations.get(selection.combinationId);
    if (!combination) return;
    combination.pendingDispatches = Math.max(0, combination.pendingDispatches - 1);
    if (strategy === 'browser') counters.pendingBrowserDispatches = Math.max(0, counters.pendingBrowserDispatches - 1);
    if (combination.dispatches === 0 && combination.pendingDispatches === 0) {
      counters.combinations.delete(selection.combinationId);
      counters.paidStrategySelections = Math.max(0, counters.paidStrategySelections - 1);
    }
  }

  private recordHttpDispatch(
    context: RetrievalOperationContext,
    _observation: RetrievalDispatchObservation
  ): void {
    const metadata = this.metadataFor(context);
    metadata.httpDispatchCount++;
    this.httpDispatchCount++;
  }

  private recordHttpResponse(
    _context: RetrievalOperationContext,
    _observation: RetrievalDispatchObservation
  ): void {
    // Status accounting remains owned by the normalized provider response;
    // this hook intentionally receives no raw headers or response body.
  }

  private recordDispatch(
    request: NormalizedRetrievalRequest,
    context: RetrievalOperationContext,
    reservation?: RetrievalCostReservation,
    strategyToken?: string,
    strategyScopeId?: string
  ): number {
    const requestSequence = ++this.requestSequence;
    this.requestCount++;
    this.lastRequestSequence = requestSequence;
    this.lastStrategy = request.strategy;
    const metadata = this.metadataFor(context);
    metadata.dispatchCount++;
    metadata.strategyCounts[request.strategy]++;
    metadata.lastStrategy = request.strategy;
    if (reservation) metadata.dispatchSequences.set(reservation, requestSequence);

    if (request.strategy !== 'direct' && strategyToken) {
      const counters = this.strategyCounters(metadata, strategyScopeId);
      const selection = counters.selectionTokens.get(strategyToken);
      const combination = counters.combinations.get(request.combination.id);
      if (selection && combination && !selection.dispatched) {
        selection.dispatched = true;
        combination.pendingDispatches = Math.max(0, combination.pendingDispatches - 1);
        combination.dispatches++;
        if (request.strategy === 'browser') {
          counters.pendingBrowserDispatches = Math.max(0, counters.pendingBrowserDispatches - 1);
          counters.browserDispatches++;
        }
      }
    }
    return requestSequence;
  }

  private metadataFor(context: RetrievalOperationContext): OperationMetadata {
    const key = context as object;
    const existing = this.operationMetadata.get(key);
    if (existing) return existing;
    const created: OperationMetadata = {
      dispatchCount: 0,
      httpDispatchCount: 0,
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
      counters = {
        paidStrategySelections: 0,
        browserDispatches: 0,
        pendingBrowserDispatches: 0,
        selectionTokens: new Map(),
        combinations: new Map(),
        completed: new Map(),
        flights: new Map()
      };
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
          failureKind: retrievalFailureKindForAbort(context.signal, context, managed.timedOut?.()),
          cost: error.cost,
          lateCost: error.lateCost
        });
      }
      return error;
    }
    if (context.signal.aborted) {
      return new RetrievalError({
        code: managed.timedOut?.() ? 'timeout' : 'cancelled',
        message: managed.timedOut?.() ? 'Retrieval operation timed out' : 'Retrieval operation was cancelled',
        failureKind: retrievalFailureKindForAbort(context.signal, context, managed.timedOut?.())
      });
    }
    if (signal?.aborted) {
      return new RetrievalError({
        code: 'cancelled',
        message: 'Retrieval operation was cancelled',
        failureKind: retrievalFailureKindForAbort(signal || context.signal, context)
      });
    }
    return new RetrievalError({ code: 'network', message: 'Retrieval attempt failed', retryable: true });
  }
}

function inferOperationPurpose(steps: readonly RetrievalStrategyStep[]): RetrievalPurpose | undefined {
  const purpose = steps[0]?.request.purpose;
  if (!purpose || steps.some(step => step.request.purpose !== purpose)) return undefined;
  return purpose;
}

function isGlobalProviderTermination(error: RetrievalError): boolean {
  if (!error.provider) return false;
  if (new Set(['invalid_request', 'auth_or_credits_unknown', 'target_unavailable', 'concurrency_limited', 'provider_error']).has(error.code)) {
    return true;
  }
  // A server_error synthesized from a target response is recoverable as a
  // combination failure. A provider API 5xx (or an unclassified provider
  // server failure) closes the paid chain only after retry exhaustion.
  return error.code === 'server_error'
    && error.targetStatus === undefined
    && (error.apiStatus === undefined || error.apiStatus >= 500);
}

function validateCapability(provider: RetrievalProvider, request: NormalizedRetrievalRequest): void {
  const capabilities = provider.capabilities;
  const supportedProxyTypes = capabilities.proxyTypes || ['datacenter'];
  if (!supportedProxyTypes.includes(request.proxyType)) {
    throw new RetrievalError({
      code: 'configuration',
      message: 'The selected provider does not support the requested proxy combination',
      provider: provider.name
    });
  }
  if (capabilities.combinations && !capabilities.combinations.includes(request.combination.id)) {
    throw new RetrievalError({
      code: 'configuration',
      message: 'The selected provider does not support the requested retrieval combination',
      provider: provider.name
    });
  }
  if (capabilities.purposes && !capabilities.purposes.includes(request.purpose)) {
    throw new RetrievalError({
      code: 'configuration',
      message: 'The selected provider does not support the requested retrieval purpose',
      provider: provider.name
    });
  }
  if (request.strategy !== 'direct' && !capabilities.paid) {
    throw new RetrievalError({
      code: 'configuration',
      message: 'The selected provider does not support paid retrieval',
      provider: provider.name
    });
  }
  if (request.strategy === 'browser' && !capabilities.browser) {
    throw new RetrievalError({ code: 'configuration', message: 'The selected provider does not support browser retrieval', provider: provider.name });
  }
  if (request.documentFormat === 'html_with_iframes' && !capabilities.iframeDocuments && request.strategy !== 'direct') {
    throw new RetrievalError({ code: 'configuration', message: 'The selected provider does not return iframe documents', provider: provider.name });
  }
}

function compactCachedResponse(response: RetrievalResponse): RetrievalResponse {
  const { document: _document, ...finite } = response;
  return finite;
}

function normalizeRetrievalResponse(
  response: RetrievalResponse,
  request: NormalizedRetrievalRequest
): RetrievalResponse {
  return {
    provider: response.provider,
    strategy: request.strategy,
    proxyType: request.proxyType,
    combination: request.combination.id as RetrievalCombinationId,
    ...(response.apiStatus === undefined ? {} : { apiStatus: response.apiStatus }),
    ...(response.targetStatus === undefined ? {} : { targetStatus: response.targetStatus }),
    ...(response.document === undefined ? {} : { document: response.document }),
    ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
    cost: response.cost
  };
}

function throwIfCancelled(signal: AbortSignal | undefined, context: RetrievalOperationContext): void {
  if (signal?.aborted || context.signal.aborted) {
    const managed = context as Partial<ManagedOperationContext>;
    throw new RetrievalError({
      code: managed.timedOut?.() ? 'timeout' : 'cancelled',
      message: managed.timedOut?.() ? 'Retrieval operation timed out' : 'Retrieval operation was cancelled',
      failureKind: retrievalFailureKindForAbort(signal || context.signal, context, managed.timedOut?.())
    });
  }
  if (context.remainingMs() <= 0) {
    throw new RetrievalError({
      code: 'timeout',
      message: 'Retrieval operation timed out',
      failureKind: 'operation_deadline'
    });
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'unknown';
  }
}

function isUnbypassableStrategyError(error: RetrievalError, context: RetrievalOperationContext): boolean {
  if (isGlobalProviderTermination(error)) return true;
  if (['security', 'cancelled', 'timeout', 'configuration', 'response_too_large', 'document_limit'].includes(error.code)) return true;
  return error.code === 'budget' && context.cost.snapshot().paidClosed;
}

function resolveStrategyLimits(
  purpose: RetrievalRequest['purpose'],
  options: Pick<RetrievalRetryOptions, 'maxPaidStrategySelections' | 'maxBrowserDispatches'>
): StrategyLimits {
  const publisherOrScholar = purpose === 'publisher_discovery' || purpose === 'scholar_search';
  return {
    maxPaidStrategySelections: normalizeNonNegativeLimit(
      options.maxPaidStrategySelections,
      publisherOrScholar ? MAX_PAID_COMBINATION_SELECTIONS : 3
    ),
    maxBrowserDispatches: normalizeNonNegativeLimit(
      options.maxBrowserDispatches,
      publisherOrScholar ? 2 : 1
    )
  };
}

function normalizeNonNegativeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === Number.POSITIVE_INFINITY) return value;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function deriveStrategyScopeId(request: RetrievalRequest): string {
  let normalizedUrl = request.url;
  try {
    const url = new URL(request.url);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    const sortedSearch = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
    url.search = '';
    for (const [key, value] of sortedSearch) url.searchParams.append(key, value);
    normalizedUrl = url.toString();
  } catch {
    // Target validation will produce the user-facing error; this key remains
    // local and only prevents a malformed request from resetting counters.
  }
  const query = request.query
    ? JSON.stringify(Object.entries(request.query).sort(([left], [right]) => left.localeCompare(right)))
    : '';
  return `${request.purpose}\u0000${normalizedUrl}\u0000${query}`;
}

function appendAttemptedCombination(
  state: RetrievalStrategyState,
  combination: RetrievalCombinationId | undefined,
  strategy: RetrievalStrategy
): RetrievalStrategyState {
  const attemptedCombinations = [...(state.attemptedCombinations || [])];
  const fallbackCombination = strategy === 'direct' ? 'direct:datacenter' : `${strategy}:datacenter` as RetrievalCombinationId;
  const resolved = combination || fallbackCombination;
  if (!attemptedCombinations.includes(resolved)) attemptedCombinations.push(resolved);
  return {
    ...state,
    attemptedStrategies: [...state.attemptedStrategies, strategy],
    attemptedCombinations
  };
}

async function waitForStrategyFlight<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  context: RetrievalOperationContext,
  providerName: string,
  paid: boolean
): Promise<T> {
  if (signal.aborted) {
    throw new RetrievalError({
      code: 'cancelled',
      message: 'Retrieval operation was cancelled',
      provider: providerName,
      failureKind: retrievalFailureKindForAbort(signal, context),
      cost: paid ? { known: false, credits: null, reason: 'cancelled_before_provider_completion' } : { known: true, credits: 0 }
    });
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const managed = context as Partial<ManagedOperationContext>;
      reject(new RetrievalError({
        code: managed.timedOut?.() || context.remainingMs() <= 0 ? 'timeout' : 'cancelled',
        message: managed.timedOut?.() || context.remainingMs() <= 0
          ? 'Retrieval operation timed out'
          : 'Retrieval operation was cancelled',
        provider: providerName,
        failureKind: retrievalFailureKindForAbort(signal, context, managed.timedOut?.()),
        cost: paid ? { known: false, credits: null, reason: 'cancelled_before_provider_completion' } : { known: true, credits: 0 }
      }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
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
  const relay = () => relayAbortReason(controller, primary.aborted ? primary : secondary!);
  if (primary.aborted || secondary.aborted) relay();
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
