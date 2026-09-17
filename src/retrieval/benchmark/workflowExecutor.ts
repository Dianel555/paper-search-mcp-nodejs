import type { AxiosRequestConfig } from 'axios';
import { PaperFactory, type Paper } from '../../models/Paper.js';
import {
  GoogleScholarSearcher,
  type GoogleScholarRetrievalService
} from '../../platforms/GoogleScholarSearcher.js';
import {
  PublicAccessDiscovery,
  type AccessDiscoveryStatus,
  type PublicAccessDiscoveryService,
  type PublicAccessDiscoveryStrategy
} from '../../services/PublicAccessDiscovery.js';
import {
  PublicHttpClient,
  type PublicHttpRequester,
  type PublicHttpResponseData
} from '../../services/PublicHttpClient.js';
import { PublicSourceDispatchScheduler } from '../../services/PublicSourceDispatchScheduler.js';
import { OutboundSecurityPolicy } from '../OutboundSecurityPolicy.js';
import { DirectHttpProvider } from '../DirectHttpProvider.js';
import { RETRIEVAL_OPERATION_TIMEOUT_MS, RetrievalService } from '../RetrievalService.js';
import { RetrievalCostPolicy } from '../RetrievalCostPolicy.js';
import { ScrapingAntProvider, type ScrapingAntProviderClient, type ScrapingAntProviderResponse } from '../ScrapingAntProvider.js';
import { createRetrievalDispatchId } from '../dispatchId.js';
import {
  getRetrievalBudgetDefaults,
  parseRetrievalConfiguration,
  type RetrievalConfiguration
} from '../Configuration.js';
import type {
  RetrievalCostController,
  RetrievalCostObservation,
  RetrievalCostReservation,
  RetrievalCostSnapshot,
  RetrievalOperationContext,
  RetrievalDispatchObservation,
  RetrievalError,
  RetrievalErrorCode,
  RetrievalPurpose,
  RetrievalResponse
} from '../types.js';
import {
  BenchmarkAdmissionError,
  type BenchmarkAdmissionErrorCode,
  type RunReservation
} from './admission.js';
import {
  matchPublisherCandidate,
  matchScholarIdentity
} from './corpus.js';
import {
  DEFAULT_PUBLISHER_WORKFLOW_FIXTURES,
  DEFAULT_SCHOLAR_WORKFLOW_FIXTURES
} from './defaultFixtures.js';
import type {
  BenchmarkAttempt,
  BenchmarkCell,
  BenchmarkCellCombination,
  BenchmarkDispatchCombination,
  BenchmarkExecutionResult,
  BenchmarkReason,
  BenchmarkSample,
  BenchmarkSessionState
} from './types.js';
import type {
  BenchmarkAttemptHandle,
  BenchmarkCellExecutionContext,
  BenchmarkCellExecutor
} from './runner.js';

const FIXTURE_ADDRESS = { address: '203.0.113.10', family: 4 } as const;
const MAX_WORKFLOW_FIXTURE_RESULTS = 5;
/** Shared benchmark production timeout for offline/live parity. */
export const BENCHMARK_DISCOVERY_TIMEOUT_MS = RETRIEVAL_OPERATION_TIMEOUT_MS;

/**
 * A raw response returned below the real business entry points. The resolver
 * is deliberately keyed by cell/sample/role/combination; it cannot return a
 * scored candidate or Scholar Paper directly.
 */
export interface BenchmarkWorkflowFixtureResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly data?: unknown;
}

export interface BenchmarkWorkflowFixtureRequest {
  readonly cell: BenchmarkCell;
  readonly sample: BenchmarkSample;
  readonly role: BenchmarkAttempt['role'];
  readonly transport: 'direct' | 'scrapingant';
  /** The concrete transport combination used for this request. */
  readonly combination: BenchmarkCellCombination;
  readonly estimatedCredits: number;
  readonly url: string;
  readonly targetUrl?: string;
  readonly method: string;
  /** Internal fixture observation only; never copied into a report. */
  readonly headers: Readonly<Record<string, unknown>>;
}

export type BenchmarkWorkflowFixtureResolver = (
  request: BenchmarkWorkflowFixtureRequest
) => BenchmarkWorkflowFixtureResponse | Promise<BenchmarkWorkflowFixtureResponse>;

export interface ProductionBenchmarkExecutorOptions {
  /** Fixed raw-response fixture resolver; the default is a positive-control set. */
  readonly resolveFixture?: BenchmarkWorkflowFixtureResolver;
  /** Default retains real pacing. Tests may advance this with fake timers. */
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Default retains real retry backoff; tests can advance it with fake timers. */
  readonly retrySleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** One scheduler is shared by Publisher, Scholar and paid target origins. */
  readonly sourceScheduler?: PublicSourceDispatchScheduler;
  /** Optional deterministic clock used by offline workflow runs. */
  readonly now?: () => number;
  /** Non-semantic test observation for linked settlement/reconciliation. */
  readonly onPaidSettlement?: (phase: 'settle' | 'reconcile', observation: RetrievalCostObservation) => void;
  /** Defaults enable all reviewed fixture combinations without real credentials. */
  readonly configuration?: RetrievalConfiguration;
}

export interface PendingPaidReservation {
  readonly reservation: RunReservation;
  readonly retrievalReservation: RetrievalCostReservation;
  readonly productionReservation: RetrievalCostReservation;
  readonly estimate: number;
}

/**
 * Bridges a real RetrievalService operation ledger to the benchmark's own
 * run/operation admission. The provider still owns settlement timing; this
 * adapter only translates the normalized observation to its linked reservation.
 */
export class BenchmarkCostBridge implements RetrievalCostController {
  private readonly pending: PendingPaidReservation[] = [];
  private readonly productionLedger: RetrievalCostController;
  private sequence = 0;
  private closedReason?: BenchmarkAdmissionErrorCode;

  constructor(
    private readonly context: BenchmarkCellExecutionContext,
    configuration: RetrievalConfiguration,
    purpose: RetrievalPurpose,
    private readonly onPaidSettlement?: (phase: 'settle' | 'reconcile', observation: RetrievalCostObservation) => void
  ) {
    const defaults = getRetrievalBudgetDefaults(configuration, purpose);
    this.productionLedger = new RetrievalCostPolicy({
      budget: defaults.maxCreditsPerOperation,
      maxCreditsPerRequest: defaults.maxCreditsPerRequest,
      enabled: configuration.scrapingAnt.paidEnabled
    }).createLedger();
  }

  get budget(): number {
    return Math.min(this.context.operation.snapshot().budget, this.productionLedger.budget);
  }

  reserve(estimate: number): RetrievalCostReservation | null {
    if (this.closedReason) {
      throw new BenchmarkAdmissionError(this.closedReason, 'Benchmark paid admission is closed');
    }
    const productionReservation = this.productionLedger.reserve(estimate);
    if (!productionReservation) return null;

    let reservation: RunReservation;
    try {
      reservation = this.context.reservePaid(estimate);
    } catch (error) {
      productionReservation.release();
      throw error;
    }
    const retrievalReservation: RetrievalCostReservation = {
      attemptId: `benchmark-bridge-${++this.sequence}`,
      estimate,
      markDispatched: () => {
        if (!productionReservation.markDispatched()) {
          this.removePending(retrievalReservation);
          reservation.release();
          throw new BenchmarkAdmissionError('operation_budget_exceeded', 'Production paid admission changed before dispatch');
        }
        try {
          reservation.markDispatched(this.context.signal);
        } catch (error) {
          // Both markers are still pre-transport. Roll them back instead of
          // manufacturing unknown billing for a request that sent no bytes.
          productionReservation.cancelBeforeTransport!();
          this.removePending(retrievalReservation);
          reservation.release();
          throw error;
        }
        return true;
      },
      release: () => {
        productionReservation.release();
        reservation.release();
      }
    };
    this.pending.push({ reservation, retrievalReservation, productionReservation, estimate });
    return retrievalReservation;
  }

  settle(
    retrievalReservation: RetrievalCostReservation,
    observation: RetrievalCostObservation
  ): void {
    this.settleLinked(retrievalReservation, observation, false);
  }

  reconcile(
    retrievalReservation: RetrievalCostReservation,
    observation: RetrievalCostObservation
  ): void {
    this.settleLinked(retrievalReservation, observation, true);
  }

  close(reason: string): void {
    const mapped = mapBridgeCloseReason(reason);
    if (!mapped || this.closedReason) return;
    this.closedReason = mapped;
    this.productionLedger.close(mapped);
    this.context.operation.close(mapped);
    if (mapped === 'pricing_unknown') this.context.run.close(mapped);
  }

  snapshot(): RetrievalCostSnapshot {
    const operation = this.context.operation.snapshot();
    const production = this.productionLedger.snapshot();
    const run = this.context.run.snapshot();
    const paidClosedReason = this.closedReason
      || production.paidClosedReason
      || operation.paidClosedReason
      || run.paidClosedReason;
    return {
      budget: Math.min(operation.budget, production.budget),
      admissionUsed: Math.max(operation.settledCredits, production.admissionUsed),
      reservedCredits: Math.max(operation.reservedCredits, production.reservedCredits),
      reportedCredits: Math.max(operation.reportedCredits, production.reportedCredits),
      reportedCreditsKnown: operation.reportedCostKnown && production.reportedCreditsKnown && run.reportedCostKnown,
      unknownCostAttempts: Math.max(operation.unknownCostAttempts, production.unknownCostAttempts, run.unknownCostAttempts),
      paidClosed: Boolean(this.closedReason) || production.paidClosed || operation.paidClosed || run.paidClosed,
      ...(paidClosedReason ? { paidClosedReason } : {})
    };
  }

  private removePending(retrievalReservation: RetrievalCostReservation): void {
    const index = this.pending.findIndex(entry => entry.retrievalReservation === retrievalReservation);
    if (index >= 0) this.pending.splice(index, 1);
  }

  /** Find the reservation already marked at the real provider boundary. */
  findDispatchedPaidReservation(): PendingPaidReservation | undefined {
    return this.pending.find(entry => entry.reservation.dispatched && !entry.reservation.settled);
  }

  /** Claim the reservation already marked at the real provider boundary. */
  claimPaidReservation(): PendingPaidReservation {
    const index = this.pending.findIndex(entry => entry.reservation.dispatched && !entry.reservation.settled);
    if (index < 0) {
      throw new BenchmarkAdmissionError('run_limit', 'A paid fixture request had no linked reservation');
    }
    const [entry] = this.pending.splice(index, 1);
    return entry;
  }

  private settleLinked(
    retrievalReservation: RetrievalCostReservation,
    observation: RetrievalCostObservation,
    reconciliation: boolean
  ): void {
    const entry = this.pending.find(candidate => candidate.retrievalReservation === retrievalReservation)
      || claimedReservations.get(retrievalReservation);
    if (!entry) return;
    const actual = observation.known ? observation.credits : null;
    if (reconciliation) this.productionLedger.reconcile?.(entry.productionReservation, observation);
    else this.productionLedger.settle(entry.productionReservation, observation);
    entry.reservation.settle(actual);
    try {
      this.onPaidSettlement?.(reconciliation ? 'reconcile' : 'settle', observation);
    } catch {
      // Test/diagnostic observers cannot alter retrieval or settlement semantics.
    }
  }
}

const claimedReservations = new WeakMap<object, PendingPaidReservation>();

function mapBridgeCloseReason(reason: string): BenchmarkAdmissionErrorCode | undefined {
  const supported: readonly BenchmarkAdmissionErrorCode[] = [
    'pricing_unknown',
    'request_cost_limit',
    'operation_budget_exceeded',
    'reservation_contended',
    'run_limit',
    'actual_cost_exceeded',
    'cancelled',
    'provider_error',
    'deadline_exceeded',
    'not_authorized'
  ];
  return supported.includes(reason as BenchmarkAdmissionErrorCode)
    ? reason as BenchmarkAdmissionErrorCode
    : undefined;
}

export interface ActiveFixtureCell {
  readonly cell: BenchmarkCell;
  readonly sample: BenchmarkSample;
  readonly context: BenchmarkCellExecutionContext;
  readonly bridge: BenchmarkCostBridge;
  readonly startedAt: number;
  httpDispatchCount: number;
  serviceAttemptCount: number;
  lastApiStatus: number | null;
  lastTargetStatus: number | null;
  pendingRedirect: boolean;
  sawScholarInitialization: boolean;
  scholarInitializationSucceeded: boolean;
  /** Last safe retrieval failure; no raw message/configuration is retained. */
  lastFailure?: {
    readonly code: RetrievalErrorCode;
    readonly failureKind?: RetrievalError['failureKind'];
    readonly apiStatus: number | null;
    readonly targetStatus: number | null;
  };
  /** Attempts that have dispatched but have not received terminal attribution. */
  readonly pendingAttempts: Set<BenchmarkAttemptHandle>;
  /** Every transport dispatch is correlated by its concrete process-local ID. */
  readonly dispatchAttempts: Map<string, BenchmarkAttemptHandle>;
  readonly dispatchStartedAt: Map<string, number>;
  readonly observedStatuses: WeakMap<object, { apiStatus: number | null; targetStatus: number | null }>;
  /** Normalized paid responses retain the reservation link as a second key. */
  readonly providerAttempts: Map<object, BenchmarkAttemptHandle>;
  /** Set by the service observer immediately before the fixture client runs. */
  providerDispatchId?: string;
}

class FixtureDirectRequester implements PublicHttpRequester {
  constructor(
    private readonly getActive: () => ActiveFixtureCell | undefined,
    private readonly resolveFixture: BenchmarkWorkflowFixtureResolver
  ) {}

  async request(config: AxiosRequestConfig): Promise<PublicHttpResponseData> {
    const active = requireActive(() => this.getActive());
    const url = typeof config.url === 'string' ? config.url : '';
    const role = classifyDirectRole(active, url);
    const fixtureRequest: BenchmarkWorkflowFixtureRequest = {
      cell: active.cell,
      sample: active.sample,
      role,
      transport: 'direct',
      combination: 'direct',
      estimatedCredits: 0,
      url,
      method: String(config.method || 'GET').toUpperCase(),
      headers: copyHeaders(config.headers)
    };
    try {
      const response = await this.resolveFixture(fixtureRequest);
      active.lastApiStatus = null;
      active.lastTargetStatus = response.status;
      if (isRedirect(response.status, response.headers)) active.pendingRedirect = true;
      if (role === 'init') {
        active.sawScholarInitialization = true;
        active.scholarInitializationSucceeded = response.status >= 200 && response.status < 300;
      }
      return toPublicResponse(response);
    } catch (error) {
      // RetrievalService invokes the operation error observer after it has
      // normalized and settled this submitted attempt.
      throw error;
    }
  }
}

class FixtureScrapingAntClient implements ScrapingAntProviderClient {
  constructor(
    private readonly getActive: () => ActiveFixtureCell | undefined,
    private readonly resolveFixture: BenchmarkWorkflowFixtureResolver
  ) {}

  async request(config: AxiosRequestConfig): Promise<ScrapingAntProviderResponse> {
    const active = requireActive(() => this.getActive());
    const params = config.params && typeof config.params === 'object'
      ? config.params as Record<string, unknown>
      : {};
    const targetUrl = typeof params.url === 'string' ? params.url : '';
    const strategy: 'static' | 'browser' = params.browser === true ? 'browser' : 'static';
    const proxyType = params.proxy_type === 'residential' ? 'residential' : 'datacenter';
    const combination = `${strategy}:${proxyType}` as BenchmarkDispatchCombination;
    const linked = active.bridge.claimPaidReservation();
    claimedReservations.set(linked.retrievalReservation as object, linked);
    const fixtureRequest: BenchmarkWorkflowFixtureRequest = {
      cell: active.cell,
      sample: active.sample,
      role: 'provider_api',
      transport: 'scrapingant',
      combination,
      estimatedCredits: linked.estimate,
      url: typeof config.url === 'string' ? config.url : 'https://api.scrapingant.com/v2/general',
      targetUrl,
      method: String(config.method || 'GET').toUpperCase(),
      headers: copyHeaders(config.headers)
    };
    beginPaidAttempt(active, linked, combination);
    try {
      const response = await this.resolveFixture(fixtureRequest);
      active.lastApiStatus = response.status;
      active.lastTargetStatus = null;
      return response;
    } catch (error) {
      // RetrievalService invokes the operation error observer after it has
      // normalized and settled this submitted attempt.
      throw error;
    }
  }
}

export interface ComparisonScholar {
  readonly searcher: GoogleScholarSearcher;
  readonly service: RetrievalService;
}

export interface FixtureServices {
  readonly publisherService: RetrievalService;
  readonly scholarService: RetrievalService;
  readonly publisherDiscovery: PublicAccessDiscovery;
  readonly comparisonPublisherDiscovery: PublicAccessDiscovery;
  readonly productionScholar: GoogleScholarSearcher;
  readonly scholarSessionStates: Map<string, boolean>;
  readonly getComparisonScholar: (combination: BenchmarkCellCombination) => ComparisonScholar;
}

/**
 * Offline transports still use the same dispatch/response boundary as live
 * transports. The resolver remains below that boundary and never creates a
 * scored result directly.
 */
function createOfflineDispatchObserver(active: ActiveFixtureCell): {
  readonly onDispatch: (observation: RetrievalDispatchObservation) => void;
  readonly onResponse: (observation: RetrievalDispatchObservation) => void;
  readonly onError: (observation: RetrievalDispatchObservation) => void;
} {
  return {
    onDispatch: observation => {
      if (observation.role === 'provider_api') {
        active.providerDispatchId = observation.dispatchId;
        return;
      }
      const role = observation.resource || 'page';
      active.context.recordHttpDispatch();
      const attempt = active.context.recordAttempt({
        dispatchId: observation.dispatchId,
        role,
        combination: active.cell.combination,
        dispatchCombination: 'direct',
        reason: 'none',
        estimate: 0,
        reportedCredits: 0,
        costKnown: true
      });
      active.httpDispatchCount++;
      active.serviceAttemptCount++;
      active.pendingAttempts.add(attempt);
      active.dispatchAttempts.set(observation.dispatchId, attempt);
      active.dispatchStartedAt.set(observation.dispatchId, active.context.now());
      active.observedStatuses.set(attempt, { apiStatus: null, targetStatus: null });
      if (role === 'init') active.sawScholarInitialization = true;
    },
    onResponse: observation => {
      const attempt = active.dispatchAttempts.get(observation.dispatchId);
      const status = observation.status ?? null;
      if (observation.role === 'provider_api') {
        active.lastApiStatus = status;
        if (!attempt) return;
        const observed = active.observedStatuses.get(attempt) || { apiStatus: null, targetStatus: null };
        active.observedStatuses.set(attempt, { apiStatus: status, targetStatus: observed.targetStatus });
        attempt.complete({
          apiStatus: status,
          targetStatus: observed.targetStatus,
          reason: status !== null && (status < 200 || status >= 300) ? 'target_failed' : 'none',
          failureKind: null,
          elapsedMs: elapsedMsForDispatch(active, observation.dispatchId)
        });
        return;
      }
      active.lastTargetStatus = status;
      if (observation.resource === 'init') {
        active.scholarInitializationSucceeded = status !== null && status >= 200 && status < 300;
      }
      if (!attempt) return;
      const observed = active.observedStatuses.get(attempt) || { apiStatus: null, targetStatus: null };
      const targetStatus = status ?? observed.targetStatus;
      active.observedStatuses.set(attempt, { apiStatus: observed.apiStatus, targetStatus });
      attempt.complete({
        apiStatus: observed.apiStatus,
        targetStatus,
        reason: status !== null && (status < 200 || status >= 300) ? 'target_failed' : 'none',
        failureKind: null,
        elapsedMs: elapsedMsForDispatch(active, observation.dispatchId)
      });
      // A body-pending response is parsed after this callback. Other
      // resources are fully represented by the finite response observation.
      if (observation.bodyPending === true) return;
      removeActiveAttempt(active, observation.dispatchId, attempt);
    },
    onError: observation => observeDispatchError(active, observation)
  };
}

function elapsedMsForDispatch(active: ActiveFixtureCell, dispatchId?: string): number {
  if (!dispatchId) return 0;
  const startedAt = active.dispatchStartedAt.get(dispatchId);
  return startedAt === undefined ? 0 : Math.max(0, active.context.now() - startedAt);
}

function removeActiveAttempt(
  active: ActiveFixtureCell,
  dispatchId: string | undefined,
  attempt: BenchmarkAttemptHandle
): void {
  active.pendingAttempts.delete(attempt);
  if (dispatchId) {
    active.dispatchAttempts.delete(dispatchId);
    active.dispatchStartedAt.delete(dispatchId);
  }
  for (const [key, candidate] of active.dispatchAttempts) {
    if (candidate === attempt) {
      active.dispatchAttempts.delete(key);
      active.dispatchStartedAt.delete(key);
    }
  }
  active.observedStatuses.delete(attempt);
  for (const [key, candidate] of active.providerAttempts) {
    if (candidate === attempt) active.providerAttempts.delete(key);
  }
}

/** Attribute a failed PublicHttpClient dispatch, including non-service calls. */
export function observeDispatchError(
  active: ActiveFixtureCell,
  observation: RetrievalDispatchObservation
): void {
  const attempt = active.dispatchAttempts.get(observation.dispatchId);
  const observed = attempt ? active.observedStatuses.get(attempt) : undefined;
  const apiStatus = observed?.apiStatus ?? null;
  const targetStatus = observation.status ?? observed?.targetStatus ?? null;
  const failureKind = observation.failureKind;
  const code: RetrievalErrorCode = failureKind === 'operation_deadline'
    ? 'timeout'
    : failureKind === 'scope_deadline' || failureKind === 'cancelled'
      ? 'cancelled'
      : failureKind === 'response_body' ? 'network' : 'network';
  active.lastFailure = { code, failureKind, apiStatus, targetStatus };
  active.lastApiStatus = apiStatus;
  active.lastTargetStatus = targetStatus;
  if (!attempt) return;
  active.observedStatuses.set(attempt, { apiStatus, targetStatus });
  attempt.complete({
    apiStatus,
    targetStatus,
    reason: benchmarkReasonForRetrievalError({ code, failureKind, targetStatus }),
    failureKind: failureKind ?? null,
    elapsedMs: elapsedMsForDispatch(active, observation.dispatchId)
  });
  removeActiveAttempt(active, observation.dispatchId, attempt);
}

/**
 * Reviewed offline production harness. It executes real Publisher/Scholar
 * business entry points and real provider/client parsing, but its network
 * boundary is a fixed response resolver; therefore it is never a live runner.
 */
export function createProductionBenchmarkCellExecutor(
  options: ProductionBenchmarkExecutorOptions = {}
): BenchmarkCellExecutor {
  const resolveFixture = options.resolveFixture || defaultFixtureResolver;
  const sourceScheduler = options.sourceScheduler || new PublicSourceDispatchScheduler({
    now: options.now
  });
  const configuration = options.configuration || parseRetrievalConfiguration({
    SCRAPINGANT_API_KEY: 'offline-fixture-key',
    SCRAPINGANT_ENABLED: 'true',
    SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
    SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
    SCRAPINGANT_PROXY_TYPE: 'residential'
  });
  const securityPolicy = new OutboundSecurityPolicy({
    validatePublicUrl: async url => fixtureUrlValidation(url)
  });

  let active: ActiveFixtureCell | undefined;
  const directRequester = new FixtureDirectRequester(() => active, resolveFixture);
  const paidClient = new FixtureScrapingAntClient(() => active, resolveFixture);
  const publisherHttpClient = new PublicHttpClient({
    purpose: 'publisher_discovery',
    client: directRequester,
    securityPolicy,
    sourceScheduler
  });
  const paidProvider = new ScrapingAntProvider({
    apiKey: 'offline-fixture-key',
    client: paidClient,
    sourceScheduler
  });
  const publisherService = new RetrievalService({
    directProvider: new DirectHttpProvider({ publicHttpClient: publisherHttpClient }),
    scrapingAntProvider: paidProvider,
    configuration,
    securityPolicy,
    retrySleep: options.retrySleep,
    now: options.now
  });

  let scholarService!: RetrievalService;
  const productionScholar = new GoogleScholarSearcher(undefined, {
    transport: 'auto',
    securityPolicy,
    sourceScheduler,
    publicHttpRequester: directRequester,
    delay: options.delay,
    scrapingAntProvider: paidProvider,
    retrievalServiceFactory: scholarHttpClient => {
      scholarService = new RetrievalService({
        directProvider: new DirectHttpProvider({
          publicHttpClient: scholarHttpClient,
          publicHttpClients: { scholar_search: scholarHttpClient }
        }),
        scrapingAntProvider: paidProvider,
        configuration,
        securityPolicy,
        retrySleep: options.retrySleep,
        now: options.now
      });
      return scholarService;
    }
  });

  const singlePublisherService: PublicAccessDiscoveryService = {
    createOperation: optionsForOperation => publisherService.createOperation(optionsForOperation),
    getProcessStatus: () => publisherService.getProcessStatus(),
    retrieveOnce: (request, context) => publisherService.retrieveOnce(request, context)
  };
  const publisherDiscoveryOptions = {
    configuration,
    // Keep the benchmark harness on the same discovery policy as ordinary
    // production callers.
    discoveryTimeoutMs: BENCHMARK_DISCOVERY_TIMEOUT_MS,
    publicHttpClient: publisherHttpClient,
    validateUrl: async (url: string) => fixtureUrlValidation(url),
    now: options.now
  };
  const publisherDiscovery = new PublicAccessDiscovery(publisherService, publisherDiscoveryOptions);
  const comparisonPublisherDiscovery = new PublicAccessDiscovery(
    singlePublisherService,
    publisherDiscoveryOptions
  );

  const comparisonScholars = new Map<string, ComparisonScholar>();
  const getComparisonScholar = (combination: BenchmarkCellCombination): ComparisonScholar => {
    const key = combination;
    const existing = comparisonScholars.get(key);
    if (existing) return existing;
    const transport = combination === 'direct' ? 'direct' : 'scrapingant';
    let comparisonService!: RetrievalService;
    const singleService: GoogleScholarRetrievalService = {
      createOperation: optionsForOperation => comparisonService.createOperation(optionsForOperation),
      getProcessStatus: () => comparisonService.getProcessStatus(),
      retrieveOnce: (request, context) => comparisonService.retrieveOnce(request, context)
    };
    const searcher = new GoogleScholarSearcher(undefined, {
      transport,
      retrievalServiceFactory: scholarHttpClient => {
        comparisonService = new RetrievalService({
          directProvider: new DirectHttpProvider({
            publicHttpClient: scholarHttpClient,
            publicHttpClients: { scholar_search: scholarHttpClient }
          }),
          scrapingAntProvider: paidProvider,
          configuration,
          securityPolicy,
          retrySleep: options.retrySleep,
          now: options.now
        });
        return singleService;
      },
      securityPolicy,
      sourceScheduler,
      publicHttpRequester: directRequester,
      delay: options.delay
    });
    const comparison = { searcher, service: comparisonService };
    comparisonScholars.set(key, comparison);
    return comparison;
  };

  const scholarSessionStates = new Map<string, boolean>();
  const services: FixtureServices = {
    publisherService,
    scholarService,
    publisherDiscovery,
    comparisonPublisherDiscovery,
    productionScholar,
    scholarSessionStates,
    getComparisonScholar
  };

  const executor: BenchmarkCellExecutor = async (cell, sample, context) => {
    const bridge = new BenchmarkCostBridge(
      context,
      configuration,
      sample.kind === 'publisher' ? 'publisher_discovery' : 'scholar_search',
      options.onPaidSettlement
    );
    if (active) throw new Error('Benchmark workflow executor only supports one active cell');
    const fixtureCell: ActiveFixtureCell = {
      cell,
      sample,
      context,
      bridge,
      startedAt: context.now(),
      httpDispatchCount: 0,
      serviceAttemptCount: 0,
      lastApiStatus: null,
      lastTargetStatus: null,
      pendingRedirect: false,
      sawScholarInitialization: false,
      scholarInitializationSucceeded: false,
      pendingAttempts: new Set(),
      dispatchAttempts: new Map(),
      dispatchStartedAt: new Map(),
      observedStatuses: new WeakMap(),
      providerAttempts: new Map()
    };
    active = fixtureCell;
    let operation: (RetrievalOperationContext & { dispose?: () => void }) | undefined;
    try {
      const comparisonScholar = sample.kind === 'scholar' && cell.mode === 'comparison'
        ? services.getComparisonScholar(cell.combination)
        : undefined;
      const retrievalService = sample.kind === 'publisher'
        ? services.publisherService
        : cell.mode === 'production'
          ? services.scholarService
          : comparisonScholar!.service;
      operation = retrievalService.createOperation({
        signal: context.signal,
        timeoutMs: Math.min(
          RETRIEVAL_OPERATION_TIMEOUT_MS,
          Math.max(1, context.run.deadlineAt - context.now())
        ),
        operationId: `${context.run.snapshot().runId}:${cell.cellId}:retrieval`,
        purpose: sample.kind === 'publisher' ? 'publisher_discovery' : 'scholar_search',
        cost: bridge,
        dispatchObserver: createOfflineDispatchObserver(fixtureCell),
        onNormalizedResponse: (response, reservation, dispatchId) => observeNormalizedResponse(
          fixtureCell,
          response,
          reservation,
          elapsedMsForDispatch(fixtureCell, dispatchId),
          dispatchId
        ),
        onError: (error, reservation, dispatchId) => observeRetrievalError(
          fixtureCell,
          error,
          reservation,
          elapsedMsForDispatch(fixtureCell, dispatchId),
          dispatchId
        )
      });

      if (sample.kind === 'publisher') {
        return await executePublisherCell(cell, sample, context, operation!, fixtureCell, services);
      }
      return await executeScholarCell(cell, sample, context, operation!, fixtureCell, services);
    } finally {
      operation?.dispose?.();
      fixtureCell.providerAttempts.clear();
      if (active === fixtureCell) active = undefined;
    }
  };

  return Object.assign(executor, { offlineOnly: true as const });
}

export async function executePublisherCell(
  cell: BenchmarkCell,
  sample: Extract<BenchmarkSample, { kind: 'publisher' }>,
  context: BenchmarkCellExecutionContext,
  operation: RetrievalOperationContext,
  active: ActiveFixtureCell,
  services: FixtureServices
): Promise<Partial<BenchmarkExecutionResult>> {
  const input = PaperFactory.create({
    paperId: sample.sampleId,
    title: sample.expectedTitle,
    doi: sample.doi,
    source: 'benchmark-publisher'
  });
  const result = cell.mode === 'production'
    ? await services.publisherDiscovery.enrich([input], {
      verifyPdf: cell.production?.verifyPdf === true,
      maxItems: 1,
      operation
    })
    : await services.comparisonPublisherDiscovery.enrich([input], {
      verifyPdf: false,
      maxItems: 1,
      operation,
      strategy: benchmarkStrategy(cell.combination)
    });
  const status = readAccessDiscoveryStatus(result[0]?.extra?.accessDiscovery);
  const candidateUrl = status?.candidateUrl;
  const match = candidateUrl
    ? matchPublisherCandidate(sample, candidateUrl)
    : 'not_evaluated';
  const pdfVerification = cell.mode === 'production'
    ? status?.verification?.status === 'verified'
      ? 'verified'
      : status?.verification ? 'failed' : 'not_run'
    : 'not_requested';
  const successful = match === 'matched'
    && (cell.mode !== 'production' || pdfVerification === 'verified');
  return {
    outcome: successful ? 'success' : 'failed',
    stage: cell.mode === 'production' ? 'pdf' : 'candidate',
    reason: successful ? 'none' : publisherFailureReason(status, match, active.lastFailure),
    apiStatus: status?.apiStatus ?? null,
    targetStatus: status?.targetStatus ?? null,
    httpDispatchCount: active.httpDispatchCount,
    serviceAttemptCount: active.serviceAttemptCount,
    elapsedMs: Math.max(0, context.now() - active.startedAt),
    admissionUsed: context.operation.snapshot().settledCredits,
    reportedCredits: context.operation.snapshot().reportedCostKnown
      ? context.operation.snapshot().reportedCredits : null,
    costKnown: context.operation.snapshot().reportedCostKnown ? true : null,
    match,
    pdfVerification,
    localSessionState: 'not_applicable'
  };
}

export async function executeScholarCell(
  cell: BenchmarkCell,
  sample: Extract<BenchmarkSample, { kind: 'scholar' }>,
  context: BenchmarkCellExecutionContext,
  operation: RetrievalOperationContext,
  active: ActiveFixtureCell,
  services: FixtureServices
): Promise<Partial<BenchmarkExecutionResult>> {
  const searcher = cell.mode === 'production'
    ? services.productionScholar
    : services.getComparisonScholar(cell.combination).searcher;
  const before = operation.cost.snapshot();
  let papers: Paper[] = [];
  let error: unknown;
  try {
    papers = cell.mode === 'production'
      ? await searcher.search(sample.query, {
        maxResults: cell.production?.maxResults ?? 5,
        operationContext: operation
      })
      : await searcher.searchSinglePage(sample.query, {
        maxResults: 5,
        operationContext: operation
      }, benchmarkStrategy(cell.combination));
  } catch (caught) {
    error = caught;
    papers = [];
  }
  const matched = papers.find(paper => matchScholarIdentity(sample, {
    doi: paper.doi,
    title: paper.title
  }) === 'matched');
  const match = matched
    ? 'matched'
    : papers.length ? 'mismatched' : 'not_evaluated';
  const after = operation.cost.snapshot();
  const beforeKnown = before.reportedCreditsKnown;
  const costKnown = beforeKnown && after.reportedCreditsKnown;
  const sessionKey = cell.mode === 'production' ? 'production' : cell.combination;
  const hadSession = services.scholarSessionStates.get(sessionKey) === true;
  const localSessionState: BenchmarkSessionState = cell.combination === 'direct' || cell.mode === 'production'
    ? hadSession ? 'warm' : 'cold'
    : 'not_applicable';
  if (active.sawScholarInitialization && active.scholarInitializationSucceeded) {
    services.scholarSessionStates.set(sessionKey, true);
  }
  return {
    outcome: match === 'matched' ? 'success' : 'failed',
    stage: 'parse',
    reason: match === 'matched' ? 'none' : active.lastFailure
      ? benchmarkReasonForRetrievalError(active.lastFailure)
      : scholarFailureReason(error, match),
    apiStatus: active.lastApiStatus,
    targetStatus: active.lastTargetStatus,
    httpDispatchCount: active.httpDispatchCount,
    serviceAttemptCount: active.serviceAttemptCount,
    elapsedMs: Math.max(0, context.now() - active.startedAt),
    admissionUsed: after.admissionUsed,
    reportedCredits: costKnown ? Math.max(0, after.reportedCredits - before.reportedCredits) : null,
    costKnown: costKnown ? true : null,
    match,
    pdfVerification: 'not_requested',
    localSessionState
  };
}

function benchmarkStrategy(combination: BenchmarkCellCombination): PublicAccessDiscoveryStrategy {
  if (combination === 'direct') return { strategy: 'direct', proxyType: 'datacenter' };
  const [strategy, proxyType] = combination.split(':') as ['static' | 'browser', 'datacenter' | 'residential'];
  return { strategy, proxyType };
}

function readAccessDiscoveryStatus(value: unknown): AccessDiscoveryStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<AccessDiscoveryStatus>;
  return typeof candidate.status === 'string' ? candidate as AccessDiscoveryStatus : undefined;
}

function publisherFailureReason(
  status: AccessDiscoveryStatus | undefined,
  match: string,
  failure?: ActiveFixtureCell['lastFailure']
): BenchmarkReason {
  if (match === 'mismatched') return 'identity_mismatch';
  if (status?.verification?.status === 'failed') {
    if (status.verification.reason === 'restricted_target') return 'restricted_target';
    if (status.verification.reason === 'http_status_404'
      || status.verification.reason === 'http_status_410') return 'target_not_found';
    return 'target_failed';
  }
  if (status?.reason === 'restricted_target') return 'restricted_target';
  if (status?.status === 'restricted') return 'restricted_page';
  if (status?.reason === 'candidate_limit') return 'candidate_limit';
  if (status?.reason === 'target_not_found') return 'target_not_found';
  if (status?.reason === 'no_candidate') return 'no_candidate';
  if (status?.reason === 'provider_unavailable') return 'provider_unavailable';
  if (failure) return benchmarkReasonForRetrievalError(failure);
  return status?.reason === 'deadline_exceeded' ? 'scope_exhausted' : 'parse_failed';
}

function scholarFailureReason(
  error: unknown,
  match: string,
  failure?: ActiveFixtureCell['lastFailure']
): BenchmarkReason {
  if (match === 'mismatched') return 'identity_mismatch';
  if (error instanceof BenchmarkAdmissionError) return 'run_limit';
  if (failure) return benchmarkReasonForRetrievalError(failure);
  return 'parse_failed';
}

function beginPaidAttempt(
  active: ActiveFixtureCell,
  linked: PendingPaidReservation,
  combination: BenchmarkDispatchCombination
): BenchmarkAttemptHandle {
  const dispatchId = active.providerDispatchId || createRetrievalDispatchId();
  active.providerDispatchId = undefined;
  active.httpDispatchCount++;
  active.serviceAttemptCount++;
  const attempt = active.context.recordAttempt({
    dispatchId,
    role: 'provider_api',
    combination: active.cell.combination,
    dispatchCombination: combination,
    reason: 'none',
    estimate: linked.estimate,
    reservation: linked.reservation
  });
  active.pendingAttempts.add(attempt);
  active.dispatchAttempts.set(dispatchId, attempt);
  active.dispatchStartedAt.set(dispatchId, active.context.now());
  active.observedStatuses.set(attempt, { apiStatus: null, targetStatus: null });
  active.providerAttempts.set(linked.retrievalReservation as object, attempt);
  return attempt;
}

export function observeNormalizedResponse(
  active: ActiveFixtureCell,
  response: RetrievalResponse,
  reservation?: RetrievalCostReservation,
  elapsedMs = 0,
  dispatchId?: string
): void {
  active.lastFailure = undefined;
  const key = reservation as object | undefined;
  const attempt = (key ? active.providerAttempts.get(key) : undefined)
    || (dispatchId ? active.dispatchAttempts.get(dispatchId) : undefined);
  const observed = attempt ? active.observedStatuses.get(attempt) : undefined;
  const apiStatus = response.apiStatus ?? (reservation ? observed?.apiStatus : null) ?? null;
  const targetStatus = response.targetStatus ?? response.document?.targetStatus
    ?? observed?.targetStatus ?? null;
  active.lastApiStatus = apiStatus;
  active.lastTargetStatus = targetStatus;
  if (!attempt) return;
  active.observedStatuses.set(attempt, { apiStatus, targetStatus });
  const reportedCredits = response.cost.known ? response.cost.credits : null;
  attempt.complete({
    apiStatus,
    targetStatus,
    reason: apiStatus !== null && (apiStatus < 200 || apiStatus >= 300)
      ? 'target_failed' : 'none',
    failureKind: null,
    reportedCredits,
    costKnown: response.cost.known,
    elapsedMs: Math.max(0, elapsedMs)
  });
  removeActiveAttempt(active, dispatchId, attempt);
}

/** Record only the normalized error facts needed by benchmark diagnostics. */
export function observeRetrievalError(
  active: ActiveFixtureCell,
  error: Pick<RetrievalError, 'code' | 'failureKind' | 'apiStatus' | 'targetStatus' | 'cost'>,
  reservation?: RetrievalCostReservation,
  elapsedMs = 0,
  dispatchId?: string
): void {
  const key = reservation as object | undefined;
  const attempt = (key ? active.providerAttempts.get(key) : undefined)
    || (dispatchId ? active.dispatchAttempts.get(dispatchId) : undefined);
  const observed = attempt ? active.observedStatuses.get(attempt) : undefined;
  const apiStatus = error.apiStatus ?? (attempt ? observed?.apiStatus : active.lastApiStatus);
  const targetStatus = error.targetStatus ?? (attempt ? observed?.targetStatus : active.lastTargetStatus);
  active.lastFailure = {
    code: error.code,
    failureKind: error.failureKind,
    apiStatus: apiStatus ?? null,
    targetStatus: targetStatus ?? null
  };
  active.lastApiStatus = apiStatus ?? null;
  active.lastTargetStatus = targetStatus ?? null;
  if (!attempt) return;
  active.observedStatuses.set(attempt, {
    apiStatus: apiStatus ?? null,
    targetStatus: targetStatus ?? null
  });
  attempt.complete({
    apiStatus: apiStatus ?? null,
    targetStatus: targetStatus ?? null,
    reason: benchmarkReasonForRetrievalError({ ...error, targetStatus }),
    failureKind: error.failureKind ?? null,
    ...(error.cost ? {
      reportedCredits: error.cost.known ? error.cost.credits : null,
      costKnown: error.cost.known ? true : null
    } : {}),
    elapsedMs: Math.max(0, elapsedMs)
  });
  removeActiveAttempt(active, dispatchId, attempt);
}

export function benchmarkReasonForRetrievalError(
  error: Pick<RetrievalError, 'code' | 'failureKind'> & { readonly targetStatus?: number | null }
): BenchmarkReason {
  if (error.failureKind === 'scope_deadline'
    || error.failureKind === 'operation_deadline'
    || error.failureKind === 'cancelled') {
    return 'scope_exhausted';
  }
  if (error.failureKind === 'transport_timeout') return 'provider_unavailable';
  if (error.failureKind === 'response_body') return 'parse_failed';
  switch (error.code) {
    case 'security': return 'restricted_target';
    case 'response_too_large':
    case 'document_limit': return 'parse_failed';
    case 'budget': return 'operation_budget_exceeded';
    case 'cancelled':
    case 'timeout': return 'scope_exhausted';
    case 'target_unavailable':
      return error.targetStatus === 404 || error.targetStatus === 410 ? 'target_not_found' : 'target_failed';
    case 'auth_or_credits_unknown':
    case 'configuration':
    case 'invalid_request': return 'provider_unavailable';
    case 'concurrency_limited':
    case 'detected':
    case 'network':
    case 'server_error':
    case 'provider_error': return 'target_failed';
    default: return 'unknown';
  }
}

function mapAdmissionReason(code: BenchmarkAdmissionErrorCode): BenchmarkReason {
  switch (code) {
    case 'request_cost_limit': return 'request_cost_limit';
    case 'operation_budget_exceeded': return 'operation_budget_exceeded';
    case 'unknown_cost': return 'unknown_cost';
    case 'not_authorized': return 'not_authorized';
    case 'deadline_exceeded': return 'scope_exhausted';
    case 'run_limit': return 'run_limit';
    default: return 'target_failed';
  }
}

function requireActive(getActive: () => ActiveFixtureCell | undefined): ActiveFixtureCell {
  const active = getActive();
  if (!active) throw new Error('Benchmark fixture transport used outside an active cell');
  return active;
}

function classifyDirectRole(active: ActiveFixtureCell, url: string): BenchmarkAttempt['role'] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'page';
  }
  if (parsed.hostname === 'doi.org' || parsed.hostname === 'dx.doi.org') return 'doi';
  if (active.pendingRedirect) {
    active.pendingRedirect = false;
    return 'redirect';
  }
  if (parsed.hostname === 'scholar.google.com') {
    return parsed.pathname === '' || parsed.pathname === '/' ? 'init' : 'page';
  }
  if (active.sample.kind === 'publisher' && active.sample.candidateUrls.some(candidate => sameUrl(candidate, url))) {
    return 'pdf';
  }
  return 'page';
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return left === right;
  }
}

function isRedirectStatus(status: number | null): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRedirect(status: number, headers: Readonly<Record<string, unknown>> | undefined): boolean {
  return isRedirectStatus(status) && Boolean(getHeader(headers, 'location'));
}

function parseCredits(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function copyHeaders(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return {};
  return { ...(value as Record<string, unknown>) };
}

function toPublicResponse(response: BenchmarkWorkflowFixtureResponse): PublicHttpResponseData {
  return {
    status: response.status,
    ...(response.headers ? { headers: response.headers } : {}),
    data: response.data
  };
}

function getHeader(headers: Readonly<Record<string, unknown>> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(entry)) return typeof entry[0] === 'string' ? entry[0] : undefined;
  return typeof entry === 'string' || typeof entry === 'number' ? String(entry) : undefined;
}

function fixtureUrlValidation(url: string): { url: string; hostname: string; addresses: [{ address: string; family: 4 }] } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Fixture URL must be HTTP(S)');
  if (parsed.username || parsed.password) throw new Error('Fixture URL must not contain credentials');
  return { url, hostname: parsed.hostname, addresses: [FIXTURE_ADDRESS] };
}

function fixtureIdentityMatches(request: BenchmarkWorkflowFixtureRequest): boolean {
  return request.cell.sampleId === request.sample.sampleId
    && request.cell.sampleKind === request.sample.kind;
}

function matchesDoiRequest(url: string, expectedDoi: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'doi.org' && parsed.hostname !== 'dx.doi.org') return false;
    if (parsed.search || parsed.hash) return false;
    return decodeURIComponent(parsed.pathname.slice(1)).toLowerCase() === expectedDoi.toLowerCase();
  } catch {
    return false;
  }
}

function matchesPublisherTarget(request: BenchmarkWorkflowFixtureRequest, landingUrl: string): boolean {
  const target = request.transport === 'scrapingant' ? request.targetUrl : request.url;
  return typeof target === 'string' && sameUrl(target, landingUrl);
}

function matchesScholarTarget(request: BenchmarkWorkflowFixtureRequest, expectedQuery: string): boolean {
  const target = request.transport === 'scrapingant' ? request.targetUrl : request.url;
  if (!target) return false;
  try {
    const parsed = new URL(target);
    return parsed.origin === 'https://scholar.google.com'
      && parsed.pathname === '/scholar'
      && parsed.searchParams.get('q') === expectedQuery
      && (parsed.searchParams.get('start') || '0') === '0'
      && parsed.searchParams.get('hl') === 'en'
      && parsed.searchParams.get('as_sdt') === '0,5'
      && parsed.searchParams.get('as_vis') === '1';
  } catch {
    return false;
  }
}

export function defaultFixtureResolver(
  request: BenchmarkWorkflowFixtureRequest
): BenchmarkWorkflowFixtureResponse {
  if (!fixtureIdentityMatches(request)) return { status: 404, data: '' };
  if ((request.role === 'page' || request.role === 'provider_api')
    && request.cell.mode === 'comparison'
    && request.combination !== request.cell.combination) {
    return { status: 404, data: '' };
  }
  if (request.role === 'doi') {
    const fixture = request.sample.kind === 'publisher'
      ? DEFAULT_PUBLISHER_WORKFLOW_FIXTURES[request.sample.sampleId]
      : undefined;
    if (!fixture || !matchesDoiRequest(request.url, fixture.doi)) return { status: 404, data: '' };
    return { status: 302, headers: { location: fixture.landingUrl }, data: '' };
  }
  if (request.role === 'redirect') {
    const fixture = request.sample.kind === 'publisher'
      ? DEFAULT_PUBLISHER_WORKFLOW_FIXTURES[request.sample.sampleId]
      : undefined;
    return fixture && sameUrl(request.url, fixture.landingUrl)
      ? { status: 200, headers: { 'content-type': 'text/html' }, data: '' }
      : { status: 404, data: '' };
  }
  if (request.role === 'init') {
    if (!sameUrl(request.url, 'https://scholar.google.com')) return { status: 404, data: '' };
    return {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'set-cookie': ['SCHOLAR_FIXTURE=ready; Path=/; Domain=scholar.google.com']
      },
      data: '<html><body>fixture scholar home</body></html>'
    };
  }
  if (request.role === 'pdf') {
    const fixture = request.sample.kind === 'publisher'
      ? DEFAULT_PUBLISHER_WORKFLOW_FIXTURES[request.sample.sampleId]
      : undefined;
    if (!fixture || !sameUrl(request.url, fixture.candidateUrl)) return { status: 404, data: '' };
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      data: Buffer.from('%PDF-1.7\nbenchmark fixture', 'utf8')
    };
  }
  if (request.sample.kind === 'publisher') {
    const fixture = DEFAULT_PUBLISHER_WORKFLOW_FIXTURES[request.sample.sampleId];
    if (!fixture || !matchesPublisherTarget(request, fixture.landingUrl)) return { status: 404, data: '' };
    const html = publisherFixtureHtml(fixture);
    return request.transport === 'scrapingant'
      ? paidFixtureResponse(html, request.estimatedCredits)
      : { status: 200, headers: { 'content-type': 'text/html' }, data: html };
  }
  const fixture = DEFAULT_SCHOLAR_WORKFLOW_FIXTURES[request.sample.sampleId];
  if (!fixture || !matchesScholarTarget(request, fixture.query)) return { status: 404, data: '' };
  const html = scholarFixtureHtml(fixture);
  return request.transport === 'scrapingant'
    ? paidFixtureResponse(html, request.estimatedCredits)
    : { status: 200, headers: { 'content-type': 'text/html' }, data: html };
}

function paidFixtureResponse(html: string, credits: number): BenchmarkWorkflowFixtureResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'Ant-credits-cost': String(credits)
    },
    data: JSON.stringify({ html, status_code: 200 })
  };
}

function publisherFixtureHtml(fixture: { readonly title: string; readonly candidateUrl: string }): string {
  return `<html><head><title>${escapeHtml(fixture.title)}</title><link rel="alternate" type="application/pdf" href="${escapeAttribute(fixture.candidateUrl)}"></head><body><h1>${escapeHtml(fixture.title)}</h1></body></html>`;
}

function scholarFixtureHtml(fixture: { readonly title: string }): string {
  const expected = scholarResult(fixture.title, 'expected', 'Fixture Authors');
  const unrelated = Array.from({ length: MAX_WORKFLOW_FIXTURE_RESULTS - 1 }, (_, index) =>
    scholarResult(`Unrelated fixture result ${index + 1}`, `other-${index + 1}`, 'Other Authors')
  );
  return `<html><body>${[expected, ...unrelated].join('')}</body></html>`;
}

function scholarResult(title: string, id: string, author: string): string {
  return `<div class="gs_ri"><h3 class="gs_rt"><a href="https://fixture-papers.example/${encodeURIComponent(id)}">${escapeHtml(title)}</a></h3><div class="gs_a">${escapeHtml(author)} - Fixture Journal, 2024 - fixture-papers.example</div><div class="gs_rs">Bounded fixture abstract.</div><div class="gs_fl"><a>Cited by 1</a></div></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}
