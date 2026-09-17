import {
  GoogleScholarSearcher,
  type GoogleScholarRetrievalService
} from '../../platforms/GoogleScholarSearcher.js';
import {
  PublicAccessDiscovery,
  type PublicAccessDiscoveryService
} from '../../services/PublicAccessDiscovery.js';
import {
  PublicHttpClient,
  type PublicHttpRequester
} from '../../services/PublicHttpClient.js';
import { PublicSourceDispatchScheduler } from '../../services/PublicSourceDispatchScheduler.js';
import { OutboundSecurityPolicy } from '../OutboundSecurityPolicy.js';
import { BenchmarkAdmissionError } from './admission.js';
import { DirectHttpProvider } from '../DirectHttpProvider.js';
import { RETRIEVAL_OPERATION_TIMEOUT_MS, RetrievalService } from '../RetrievalService.js';
import {
  ScrapingAntProvider,
  type ScrapingAntProviderClient
} from '../ScrapingAntProvider.js';
import {
  getRetrievalBudgetDefaults,
  parseRetrievalConfiguration,
  type RetrievalConfiguration
} from '../Configuration.js';
import type {
  RetrievalCostObservation,
  RetrievalDispatchObserver,
  RetrievalOperationContext
} from '../types.js';
import {
  BenchmarkCostBridge,
  executePublisherCell,
  executeScholarCell,
  observeNormalizedResponse,
  observeRetrievalError,
  observeDispatchError,
  BENCHMARK_DISCOVERY_TIMEOUT_MS,
  type ActiveFixtureCell,
  type ComparisonScholar,
  type FixtureServices
} from './workflowExecutor.js';
import type {
  BenchmarkCellCombination,
  BenchmarkDispatchCombination,
  BenchmarkPlan,
  BenchmarkReport
} from './types.js';
import type { RetrievalCombinationId } from '../types.js';
import {
  runBenchmark,
  type BenchmarkAttemptHandle,
  type BenchmarkCellExecutionContext,
  type BenchmarkCellExecutor
} from './runner.js';
import type { BenchmarkCorpusValidation } from './types.js';
import { validateBenchmarkReport } from './report.js';

/** Frozen corpus accepted for the one reviewed live campaign. */
export const FROZEN_LIVE_CORPUS_VERSION = '03f9f62fe6df7ed3d5a32c2d18dda88e8d0e0982c0f9ab47cc4719157864d883';
const REQUIRED_LIVE_PUBLISHER_SAMPLES = 20;
const REQUIRED_LIVE_SCHOLAR_SAMPLES = 10;
const REQUIRED_LIVE_CELLS = 360;
const REQUIRED_LIVE_OPERATION_BUDGET = 500;
const REQUIRED_LIVE_REQUEST_LIMIT = 125;

export interface LiveBenchmarkExecutorOptions {
  readonly configuration?: RetrievalConfiguration;
  readonly securityPolicy?: OutboundSecurityPolicy;
  readonly sourceScheduler?: PublicSourceDispatchScheduler;
  /** Test seam; production uses the PublicHttpClient's real Axios transport. */
  readonly directRequester?: PublicHttpRequester;
  /** Test seam below the Scholar session/request policy. */
  readonly scholarRequester?: PublicHttpRequester;
  /** Test seam; production uses ScrapingAntProvider's real Axios transport. */
  readonly scrapingAntClient?: ScrapingAntProviderClient;
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly retrySleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly retryRandom?: () => number;
  readonly now?: () => number;
  readonly onPaidSettlement?: (phase: 'settle' | 'reconcile', observation: RetrievalCostObservation) => void;
}

export interface LiveBenchmarkPreflightOptions {
  readonly configuration?: RetrievalConfiguration;
  readonly securityPolicy?: OutboundSecurityPolicy;
  readonly plannedCells?: number;
  readonly checkTargets?: boolean;
  /** Explicit human approval for the configured Scholar proxy endpoint. */
  readonly scholarProxyApproved?: boolean;
}

export interface LiveBenchmarkPreflight {
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly corpusVersion: string;
  readonly plannedCells: number;
}

/** Hard cap for one explicitly targeted failure-diagnostic pass. */
export const MAX_LIVE_FAILURE_DIAGNOSTIC_CELLS = 8;
export const LIVE_FAILURE_DIAGNOSTIC_LIMITS = {
  credits: 500,
  httpDispatches: 100,
  elapsedMs: 600_000
} as const;

export interface LiveFailureDiagnosticOptions {
  /** The completed/partial fixed-plan report from which failures are selected. */
  readonly sourceReport: BenchmarkReport;
  /** Must be a bounded subset of cells whose source outcome is exactly failed. */
  readonly selectedCellIds: readonly string[];
  readonly runId: string;
  readonly codeVersion: string;
  readonly configVersion: string;
  /** Test seam; production callers should omit this and use executorOptions. */
  readonly executeCell?: BenchmarkCellExecutor;
  readonly executorOptions?: LiveBenchmarkExecutorOptions;
}

export interface LiveFailureDiagnosticBundle {
  readonly diagnostic: 'live_failure_validation';
  readonly sourceRunId: string;
  readonly sourceRunStatus: BenchmarkReport['runStatus'];
  readonly selectedFailedCellIds: readonly string[];
  readonly report: BenchmarkReport;
  readonly json: string;
  readonly markdown: string;
}

/**
 * Re-run only a bounded, explicitly selected subset of failures while keeping
 * the fixed runner, locks, admission ledgers, and immutable source report.
 * This is diagnostic evidence only; its 360-cell report cannot replace a full
 * acceptance run or make any not_run cell pass.
 */
export async function runLiveFailureDiagnostics(
  validation: BenchmarkCorpusValidation,
  plan: BenchmarkPlan,
  options: LiveFailureDiagnosticOptions
): Promise<LiveFailureDiagnosticBundle> {
  validateBenchmarkReport(options.sourceReport, plan);
  if (options.sourceReport.mode !== 'live') {
    throw new BenchmarkAdmissionError('not_authorized', 'Failure diagnostics require a live source report');
  }
  if (options.sourceReport.corpusVersion !== validation.corpusVersion) {
    throw new BenchmarkAdmissionError('run_limit', 'Failure diagnostics require the current corpus version');
  }

  const selectedCellIds = [...new Set(options.selectedCellIds)];
  if (selectedCellIds.length === 0 || selectedCellIds.length > MAX_LIVE_FAILURE_DIAGNOSTIC_CELLS) {
    throw new BenchmarkAdmissionError('run_limit', 'Failure diagnostics exceed the bounded selection limit');
  }
  const sourceCells = new Map(options.sourceReport.cells.map(cell => [cell.cellId, cell] as const));
  for (const cellId of selectedCellIds) {
    if (sourceCells.get(cellId)?.outcome !== 'failed') {
      throw new BenchmarkAdmissionError('run_limit', 'Failure diagnostics may select only source failed cells');
    }
  }

  const liveExecutor = options.executeCell || createLiveBenchmarkCellExecutor(options.executorOptions);
  if (liveExecutor.offlineOnly) {
    throw new BenchmarkAdmissionError('not_authorized', 'Failure diagnostics cannot use an offline executor');
  }
  const selected = new Set(selectedCellIds);
  const diagnosticExecutor = liveExecutor.liveOnly
    ? liveExecutor
    : Object.assign(
      (cell: Parameters<BenchmarkCellExecutor>[0], sample: Parameters<BenchmarkCellExecutor>[1], context: Parameters<BenchmarkCellExecutor>[2]) =>
        liveExecutor(cell, sample, context),
      { liveOnly: true as const }
    ) as BenchmarkCellExecutor;
  const bundle = await runBenchmark({
    validation,
    plan,
    runId: options.runId,
    mode: 'live',
    codeVersion: options.codeVersion,
    configVersion: options.configVersion,
    executeCell: diagnosticExecutor,
    shouldExecuteCell: cell => selected.has(cell.cellId),
    limits: LIVE_FAILURE_DIAGNOSTIC_LIMITS
  });
  const metadata = {
    diagnostic: 'live_failure_validation' as const,
    sourceRunId: options.sourceReport.runId,
    sourceRunStatus: options.sourceReport.runStatus,
    selectedFailedCellIds: selectedCellIds
  };
  return {
    ...metadata,
    report: bundle.report,
    json: JSON.stringify({ ...metadata, report: bundle.report }, null, 2),
    markdown: [
      '# Live failure validation (diagnostic)',
      '',
      `- Source run: \`${metadata.sourceRunId}\``,
      `- Source status: \`${metadata.sourceRunStatus}\``,
      `- Selected failed cells: ${selectedCellIds.length}`,
      `- Diagnostic run: \`${bundle.report.runId}\``,
      '',
      'This bounded report is diagnostic evidence only. It does not replace the fixed 360-cell live acceptance run.',
      '',
      bundle.markdown
    ].join('\n')
  };
}

interface LiveCellTracking {
  readonly pending: Set<BenchmarkAttemptHandle>;
  readonly startedAt: WeakMap<object, number>;
  /** Header-observation duration retained when body completion is cancelled. */
  readonly headerElapsedMs: WeakMap<object, number>;
}

const liveTracking = new WeakMap<object, LiveCellTracking>();

/**
 * Validate all non-negotiable prerequisites without submitting HTTP bytes.
 * Missing credentials/capabilities are a campaign blocker, not a reason to
 * silently shrink the frozen comparison matrix.
 */
export async function preflightLiveBenchmark(
  validation: BenchmarkCorpusValidation,
  options: LiveBenchmarkPreflightOptions = {}
): Promise<LiveBenchmarkPreflight> {
  const configuration = options.configuration || parseRetrievalConfiguration();
  const plannedCells = options.plannedCells ?? REQUIRED_LIVE_CELLS;
  const reasons: string[] = [];

  if (validation.corpusVersion !== FROZEN_LIVE_CORPUS_VERSION) {
    reasons.push('The live campaign requires the reviewed frozen corpus version');
  }
  if (validation.corpus.publisher.length !== REQUIRED_LIVE_PUBLISHER_SAMPLES) {
    reasons.push('The live campaign requires exactly 20 Publisher samples');
  }
  if (validation.corpus.scholar.length !== REQUIRED_LIVE_SCHOLAR_SAMPLES) {
    reasons.push('The live campaign requires exactly 10 Scholar samples');
  }
  if (plannedCells !== REQUIRED_LIVE_CELLS) {
    reasons.push('The live campaign requires exactly 360 planned cells');
  }

  const paid = configuration.scrapingAnt;
  if (!paid.configured) reasons.push('SCRAPINGANT_API_KEY is missing');
  if (!paid.enabled) reasons.push('SCRAPINGANT_ENABLED is not true');
  if (!paid.paidEnabled) reasons.push('Paid retrieval is not enabled by the validated configuration');
  if (!paid.browserAllowed) reasons.push('Browser escalation is not explicitly authorized');
  if (!paid.residentialAllowed || !paid.availableProxyTypes.includes('residential')) {
    reasons.push('Residential retrieval is not explicitly authorized within the configured proxy ceiling');
  }
  const publisherBudget = getRetrievalBudgetDefaults(configuration, 'publisher_discovery');
  const scholarBudget = getRetrievalBudgetDefaults(configuration, 'scholar_search');
  if ([publisherBudget, scholarBudget].some(budget => budget.maxCreditsPerRequest < REQUIRED_LIVE_REQUEST_LIMIT)) {
    reasons.push('The configured per-request credit limit is below the fixed 125-credit comparison price');
  }
  if ([publisherBudget, scholarBudget].some(budget => budget.maxCreditsPerOperation < REQUIRED_LIVE_OPERATION_BUDGET)) {
    reasons.push('The configured per-operation credit limit is below the fixed benchmark operation budget');
  }
  if (hasUnapprovedScholarProxy(options.scholarProxyApproved === true)) {
    reasons.push('The effective Scholar proxy configuration requires a separate TLS-safe review before live use');
  }

  if (reasons.length === 0 && options.checkTargets !== false) {
    const securityPolicy = options.securityPolicy || new OutboundSecurityPolicy();
    const targets = new Map<string, 'publisher_discovery' | 'scholar_search'>();
    for (const sample of validation.corpus.publisher) {
      targets.set(`https://doi.org/${encodeURIComponent(sample.doi)}`, 'publisher_discovery');
      targets.set(sample.evidenceUrl, 'publisher_discovery');
      for (const candidate of sample.candidateUrls) targets.set(candidate, 'publisher_discovery');
    }
    targets.set('https://scholar.google.com', 'scholar_search');
    for (const [url, purpose] of targets) {
      try {
        await securityPolicy.validate(url, purpose);
      } catch {
        // Do not echo public URLs or error messages into diagnostics. The
        // request-level security boundary will still revalidate every target.
        reasons.push(purpose === 'scholar_search'
          ? 'The Scholar target failed public-network preflight'
          : 'A frozen Publisher target failed public-network preflight');
        break;
      }
    }
  }

  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    corpusVersion: validation.corpusVersion,
    plannedCells
  };
}

/**
 * Live production benchmark executor. It uses the real production clients,
 * security policy, source scheduler, provider capability checks, retries,
 * cancellation and linked benchmark/production ledgers. It has no offlineOnly
 * marker and is never constructed with fixture responses.
 */
export function createLiveBenchmarkCellExecutor(
  options: LiveBenchmarkExecutorOptions = {}
): BenchmarkCellExecutor {
  const configuration = options.configuration || parseRetrievalConfiguration();
  const sourceScheduler = options.sourceScheduler || new PublicSourceDispatchScheduler({ now: options.now });
  const securityPolicy = options.securityPolicy || new OutboundSecurityPolicy();
  const publisherHttpClient = new PublicHttpClient({
    purpose: 'publisher_discovery',
    client: options.directRequester,
    securityPolicy,
    sourceScheduler
  });
  const paidProvider = new ScrapingAntProvider({
    // A disabled configuration must never accidentally turn a supplied key
    // into transport capability.
    apiKey: configuration.scrapingAnt.paidEnabled ? configuration.scrapingAnt.apiKey : undefined,
    client: options.scrapingAntClient,
    sourceScheduler
  });
  const publisherService = new RetrievalService({
    directProvider: new DirectHttpProvider({ publicHttpClient: publisherHttpClient }),
    scrapingAntProvider: paidProvider,
    configuration,
    securityPolicy,
    retrySleep: options.retrySleep,
    retryRandom: options.retryRandom,
    now: options.now
  });

  let scholarService!: RetrievalService;
  const productionScholar = new GoogleScholarSearcher(undefined, {
    transport: 'auto',
    securityPolicy,
    sourceScheduler,
    publicHttpRequester: options.scholarRequester,
    delay: options.delay,
    scrapingAntProvider: paidProvider,
    retrievalServiceFactory: scholarHttpClient => {
      scholarService = createScholarService(
        scholarHttpClient,
        paidProvider,
        configuration,
        securityPolicy,
        options
      );
      return scholarService;
    }
  });

  const singlePublisherService: PublicAccessDiscoveryService = {
    createOperation: operationOptions => publisherService.createOperation(operationOptions),
    getProcessStatus: () => publisherService.getProcessStatus(),
    retrieveOnce: (request, context) => publisherService.retrieveOnce(request, context)
  };
  const publisherDiscoveryOptions = {
    configuration,
    // ScrapingAnt's API itself is capped at 60 seconds; keep the discovery
    // scope aligned with the existing 120-second operation bound so a slow
    // paid response is not cancelled by an earlier local discovery timer.
    discoveryTimeoutMs: BENCHMARK_DISCOVERY_TIMEOUT_MS,
    publicHttpClient: publisherHttpClient,
    // Keep DOI/landing/candidate validation on the same injected security
    // policy as the transport; do not accidentally fall back to a second DNS
    // resolver inside PublicAccessDiscovery.
    validateUrl: async (url: string) => securityPolicy.validate(url, 'publisher_discovery'),
    now: options.now
  };
  const publisherDiscovery = new PublicAccessDiscovery(publisherService, publisherDiscoveryOptions);
  const comparisonPublisherDiscovery = new PublicAccessDiscovery(
    singlePublisherService,
    publisherDiscoveryOptions
  );

  const comparisonScholars = new Map<string, ComparisonScholar>();
  const getComparisonScholar = (combination: BenchmarkCellCombination): ComparisonScholar => {
    const existing = comparisonScholars.get(combination);
    if (existing) return existing;
    const transport = combination === 'direct' ? 'direct' : 'scrapingant';
    let comparisonService!: RetrievalService;
    const singleService: GoogleScholarRetrievalService = {
      createOperation: operationOptions => comparisonService.createOperation(operationOptions),
      getProcessStatus: () => comparisonService.getProcessStatus(),
      retrieveOnce: (request, context) => comparisonService.retrieveOnce(request, context)
    };
    const searcher = new GoogleScholarSearcher(undefined, {
      transport,
      securityPolicy,
      sourceScheduler,
      publicHttpRequester: options.scholarRequester,
      scrapingAntProvider: paidProvider,
      delay: options.delay,
      retrievalServiceFactory: scholarHttpClient => {
        comparisonService = createScholarService(
          scholarHttpClient,
          paidProvider,
          configuration,
          securityPolicy,
          options
        );
        return singleService;
      }
    });
    const comparison = { searcher, service: comparisonService };
    comparisonScholars.set(combination, comparison);
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

  let active: ActiveFixtureCell | undefined;
  const executor: BenchmarkCellExecutor = async (cell, sample, context) => {
    if (active) throw new Error('Live benchmark executor only supports one active cell');
    const bridge = new BenchmarkCostBridge(
      context,
      configuration,
      sample.kind === 'publisher' ? 'publisher_discovery' : 'scholar_search',
      options.onPaidSettlement
    );
    const liveCell: ActiveFixtureCell = {
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
    const tracking: LiveCellTracking = {
      pending: new Set(),
      startedAt: new WeakMap(),
      headerElapsedMs: new WeakMap()
    };
    liveTracking.set(liveCell, tracking);
    active = liveCell;
    let operation: (RetrievalOperationContext & { dispose?: () => void }) | undefined;
    try {
      const retrievalService = sample.kind === 'publisher'
        ? services.publisherService
        : cell.mode === 'production'
          ? services.scholarService
          : services.getComparisonScholar(cell.combination).service;
      operation = retrievalService.createOperation({
        signal: context.signal,
        timeoutMs: Math.min(
          RETRIEVAL_OPERATION_TIMEOUT_MS,
          Math.max(1, context.run.deadlineAt - context.now())
        ),
        operationId: `${context.run.snapshot().runId}:${cell.cellId}:retrieval`,
        purpose: sample.kind === 'publisher' ? 'publisher_discovery' : 'scholar_search',
        cost: bridge,
        dispatchObserver: createLiveDispatchObserver(liveCell),
        onNormalizedResponse: (response, reservation, dispatchId) => {
          const attempt = reservation
            ? liveCell.providerAttempts.get(reservation as object)
            : dispatchId ? liveCell.dispatchAttempts.get(dispatchId) : undefined;
          const elapsedMs = attempt
            ? elapsedMsForAttempt(tracking, attempt, context)
            : 0;
          observeNormalizedResponse(liveCell, response, reservation, elapsedMs, dispatchId);
          if (attempt) tracking.pending.delete(attempt);
        },
        onError: (error, reservation, dispatchId) => {
          const attempt = reservation
            ? liveCell.providerAttempts.get(reservation as object)
            : dispatchId ? liveCell.dispatchAttempts.get(dispatchId) : undefined;
          const elapsedMs = attempt
            ? elapsedMsForAttempt(tracking, attempt, context)
            : 0;
          observeRetrievalError(liveCell, error, reservation, elapsedMs, dispatchId);
          if (attempt) tracking.pending.delete(attempt);
        }
      });

      if (sample.kind === 'publisher') {
        return await executePublisherCell(cell, sample, context, operation, liveCell, services);
      }
      return await executeScholarCell(cell, sample, context, operation, liveCell, services);
    } finally {
      completePendingLiveAttempts(liveCell, tracking, context);
      operation?.dispose?.();
      liveCell.providerAttempts.clear();
      liveTracking.delete(liveCell);
      if (active === liveCell) active = undefined;
    }
  };

  return Object.assign(executor, { liveOnly: true as const });
}

function createScholarService(
  scholarHttpClient: PublicHttpClient,
  paidProvider: ScrapingAntProvider,
  configuration: RetrievalConfiguration,
  securityPolicy: OutboundSecurityPolicy,
  options: LiveBenchmarkExecutorOptions
): RetrievalService {
  return new RetrievalService({
    directProvider: new DirectHttpProvider({
      publicHttpClient: scholarHttpClient,
      publicHttpClients: { scholar_search: scholarHttpClient }
    }),
    scrapingAntProvider: paidProvider,
    configuration,
    securityPolicy,
    retrySleep: options.retrySleep,
    retryRandom: options.retryRandom,
    now: options.now
  });
}

function createLiveDispatchObserver(active: ActiveFixtureCell): RetrievalDispatchObserver {
  return {
    onDispatch: observation => {
      const tracking = liveTracking.get(active);
      if (!tracking) return;
      if (observation.role === 'provider_api') {
        const linked = active.bridge.findDispatchedPaidReservation();
        const dispatchCombination = toDispatchCombination(observation.combination);
        if (!linked) throw new Error('Live paid dispatch lacked a linked benchmark reservation');
        const startedAt = active.context.now();
        const attempt = active.context.recordAttempt({
          dispatchId: observation.dispatchId,
          role: 'provider_api',
          combination: active.cell.combination,
          dispatchCombination,
          reason: 'none',
          estimate: linked.estimate,
          reservation: linked.reservation
        });
        active.httpDispatchCount++;
        active.serviceAttemptCount++;
        tracking.pending.add(attempt);
        active.pendingAttempts.add(attempt);
        tracking.startedAt.set(attempt, startedAt);
        active.dispatchAttempts.set(observation.dispatchId, attempt);
        active.dispatchStartedAt.set(observation.dispatchId, startedAt);
        active.observedStatuses.set(attempt, { apiStatus: null, targetStatus: null });
        active.providerAttempts.set(linked.retrievalReservation as object, attempt);
        return;
      }

      const role = observation.resource || 'page';
      active.context.recordHttpDispatch();
      const startedAt = active.context.now();
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
      tracking.pending.add(attempt);
      active.pendingAttempts.add(attempt);
      tracking.startedAt.set(attempt, startedAt);
      active.dispatchAttempts.set(observation.dispatchId, attempt);
      active.dispatchStartedAt.set(observation.dispatchId, startedAt);
      active.observedStatuses.set(attempt, { apiStatus: null, targetStatus: null });
      if (role === 'init') active.sawScholarInitialization = true;
    },
    onResponse: observation => {
      const tracking = liveTracking.get(active);
      if (!tracking) return;
      const role = observation.role === 'provider_api'
        ? 'provider_api'
        : observation.resource || 'page';
      const attempt = active.dispatchAttempts.get(observation.dispatchId);
      const status = observation.status ?? null;
      if (role === 'provider_api') {
        active.lastApiStatus = status;
        if (!attempt) return;
        const observed = active.observedStatuses.get(attempt) || { apiStatus: null, targetStatus: null };
        active.observedStatuses.set(attempt, { apiStatus: status, targetStatus: observed.targetStatus });
        const elapsedMs = elapsedMsForAttempt(tracking, attempt, active.context);
        tracking.headerElapsedMs.set(attempt, elapsedMs);
        attempt.complete({
          apiStatus: status,
          targetStatus: observed.targetStatus,
          reason: status !== null && (status < 200 || status >= 300) ? 'target_failed' : 'none',
          failureKind: null,
          elapsedMs
        });
        // Keep the attempt linked until RetrievalService reports the
        // normalized provider error; that callback carries billing data.
        return;
      }

      active.lastTargetStatus = status;
      if (role === 'init') active.scholarInitializationSucceeded = status !== null && status >= 200 && status < 300;
      if (!attempt) return;
      const observed = active.observedStatuses.get(attempt) || { apiStatus: null, targetStatus: null };
      const targetStatus = status ?? observed.targetStatus;
      active.observedStatuses.set(attempt, { apiStatus: observed.apiStatus, targetStatus });
      const elapsedMs = elapsedMsForAttempt(tracking, attempt, active.context);
      tracking.headerElapsedMs.set(attempt, elapsedMs);
      attempt.complete({
        apiStatus: observed.apiStatus,
        targetStatus,
        reason: status !== null && (status < 200 || status >= 300) ? 'target_failed' : 'none',
        failureKind: null,
        elapsedMs
      });
      if (observation.bodyPending === true) {
        // Keep body-pending attempts until RetrievalService has parsed the
        // finite body; a body-limit/parse error must update this attempt.
        return;
      }
      removeLiveAttempt(active, tracking, observation.dispatchId, attempt);
    },
    onError: observation => {
      const tracking = liveTracking.get(active);
      if (!tracking) return;
      const attempt = active.dispatchAttempts.get(observation.dispatchId);
      observeDispatchError(active, observation);
      if (attempt) tracking.pending.delete(attempt);
    }
  };
}

function removeLiveAttempt(
  active: ActiveFixtureCell,
  tracking: LiveCellTracking,
  dispatchId: string,
  attempt: BenchmarkAttemptHandle
): void {
  tracking.pending.delete(attempt);
  active.pendingAttempts.delete(attempt);
  active.dispatchAttempts.delete(dispatchId);
  active.dispatchStartedAt.delete(dispatchId);
  active.observedStatuses.delete(attempt);
  for (const [key, candidate] of active.dispatchAttempts) {
    if (candidate === attempt) {
      active.dispatchAttempts.delete(key);
      active.dispatchStartedAt.delete(key);
    }
  }
  for (const [key, candidate] of active.providerAttempts) {
    if (candidate === attempt) active.providerAttempts.delete(key);
  }
}

function completePendingLiveAttempts(
  active: ActiveFixtureCell,
  tracking: LiveCellTracking,
  context: BenchmarkCellExecutionContext
): void {
  const timedOut = context.signal.aborted || context.now() >= context.deadlineAt;
  for (const attempt of tracking.pending) {
    // Keep any already-observed API/target status when body parsing or a late
    // settlement fails after the transport response has arrived.
    attempt.complete({
      reason: timedOut ? 'scope_exhausted' : 'target_failed',
      failureKind: timedOut ? 'scope_deadline' : null,
      elapsedMs: tracking.headerElapsedMs.get(attempt)
        ?? elapsedMsForAttempt(tracking, attempt, context)
    });
    active.pendingAttempts.delete(attempt);
    active.observedStatuses.delete(attempt);
    for (const [key, candidate] of active.dispatchAttempts) {
      if (candidate === attempt) {
        active.dispatchAttempts.delete(key);
        active.dispatchStartedAt.delete(key);
      }
    }
  }
  tracking.pending.clear();
}

function toDispatchCombination(
  combination: RetrievalCombinationId | undefined
): BenchmarkDispatchCombination {
  if (combination === 'static:datacenter'
    || combination === 'browser:datacenter'
    || combination === 'static:residential'
    || combination === 'browser:residential') return combination;
  throw new Error('Live paid dispatch lacked concrete combination evidence');
}

function elapsedMsForAttempt(
  tracking: LiveCellTracking,
  attempt: BenchmarkAttemptHandle,
  context: BenchmarkCellExecutionContext
): number {
  const startedAt = tracking.startedAt.get(attempt);
  return Math.max(0, context.now() - (startedAt === undefined ? context.now() : startedAt));
}

function hasUnapprovedScholarProxy(approved: boolean): boolean {
  const configured = process.env.SCHOLAR_PROXY?.trim();
  const aliases = [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy'
  ];
  if (!configured && !aliases.some(name => Boolean(process.env[name]?.trim()))) return false;
  if (!approved || !configured) return true;
  try {
    const proxyUrl = new URL(configured);
    return ![
      'http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'
    ].includes(proxyUrl.protocol.toLowerCase()) || !proxyUrl.hostname;
  } catch {
    return true;
  }
}
