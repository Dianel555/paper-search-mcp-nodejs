import * as cheerio from 'cheerio';
import { Paper } from '../models/Paper.js';
import { CapabilityUnavailableError } from '../utils/CapabilityErrors.js';
import { sanitizeDoi, withTimeout } from '../utils/SecurityUtils.js';
import {
  disposeResponseBody,
  getHeaderValue,
  isPublicAddress,
  validatePublicHttpUrl,
  type PublicUrlValidation
} from '../utils/PublicNetwork.js';
import { PublicHttpClient, type PublicHttpRequester } from './PublicHttpClient.js';
import { PdfAccessVerifier, type PdfVerificationResult } from './PdfAccessVerifier.js';
import { hasSensitiveCandidateCredentials, OutboundSecurityError, OutboundSecurityPolicy, SensitiveOutboundTargetError } from '../retrieval/OutboundSecurityPolicy.js';
import { isValidAccessDiscoveryMaxItems, parseRetrievalConfiguration, type RetrievalConfiguration } from '../retrieval/Configuration.js';
import { createRetrievalService } from '../retrieval/createRetrievalService.js';
import { RETRIEVAL_OPERATION_TIMEOUT_MS } from '../retrieval/RetrievalService.js';
import {
  RetrievalError,
  type AccessArtifact,
  type DocumentProvenance,
  type FiniteDocument,
  type RetrievalOperationContext,
  type RetrievalProvider,
  type RetrievalProxyType,
  type RetrievalPurpose,
  type RetrievalResponse,
  type RetrievalStrategy
} from '../retrieval/types.js';
import { TIMEOUTS } from '../config/constants.js';
import { createConcurrencyLimiter } from '../utils/ConcurrencyLimiter.js';
import { abortForRetrievalScope, relayAbortReason } from '../retrieval/abortDiagnostics.js';

// Discovery shares the service operation ceiling so ordinary callers and
// benchmark production paths exercise the same timeout policy.
const DEFAULT_DISCOVERY_TIMEOUT_MS = RETRIEVAL_OPERATION_TIMEOUT_MS;
const MAX_DISCOVERY_TIMEOUT_MS = RETRIEVAL_OPERATION_TIMEOUT_MS;
const MAX_DISCOVERY_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_CANDIDATES = 20;

export type AccessDiscoveryState =
  | 'oa_candidate'
  | 'pdf_verified'
  | 'not_found'
  | 'restricted'
  | 'failed'
  | 'skipped';

export interface AccessDiscoveryEvidence {
  readonly url: string;
  readonly method: AccessArtifact['method'];
  readonly source: DocumentProvenance;
}

export type AccessDiscoveryVerification = PdfVerificationResult;

export interface AccessDiscoveryStatus {
  readonly status: AccessDiscoveryState;
  readonly reason?: string;
  readonly landingUrl?: string;
  readonly landingHost?: string;
  readonly candidateUrl?: string;
  readonly method?: AccessArtifact['method'];
  readonly evidence?: AccessDiscoveryEvidence;
  readonly verification?: AccessDiscoveryVerification;
  readonly candidatesTruncated?: boolean;
  readonly candidateCount?: number;
  readonly apiStatus?: number;
  readonly targetStatus?: number;
  readonly provider?: string;
  readonly strategy?: string;
  readonly proxyType?: 'datacenter' | 'residential';
  /** Known provider-reported cost only; unknown cost is never guessed. */
  readonly creditsCost?: number;
  readonly fallback?: {
    readonly attempted: boolean;
    readonly combinationsAttempted: number;
    readonly reason?: string;
  };
  readonly fetchedAt: string;
}

export interface PublicAccessDiscoveryStrategy {
  readonly strategy: RetrievalStrategy;
  readonly proxyType?: RetrievalProxyType;
}

export interface PublicAccessDiscoveryRunOptions {
  readonly verifyPdf?: boolean;
  readonly maxItems?: number;
  /** Internal operation supplied by the MCP/platform composition boundary. */
  readonly operation?: RetrievalOperationContext;
  /** Internal benchmark seam for one selected strategy without fallback. */
  readonly strategy?: PublicAccessDiscoveryStrategy;
}

export interface PublicAccessDiscoveryService {
  createOperation(options?: { signal?: AbortSignal; timeoutMs?: number; purpose?: RetrievalPurpose }): RetrievalOperationContext & { dispose?: () => void };
  retrieveWithRetry?(
    request: {
      readonly url: string;
      readonly purpose: 'publisher_discovery';
      readonly strategy: 'direct' | 'static' | 'browser';
      readonly proxyType?: 'datacenter' | 'residential';
      readonly documentFormat: 'html' | 'html_with_iframes';
      readonly signal?: AbortSignal;
    },
    context?: RetrievalOperationContext,
    options?: {
      readonly strategyScopeId?: string;
      readonly shouldRetryResponse?: (response: RetrievalResponse) => boolean | Promise<boolean>;
    }
  ): Promise<RetrievalResponse>;
  /** Optional one-attempt seam used by independent strategy comparisons. */
  retrieveOnce?: (
    request: {
      readonly url: string;
      readonly purpose: 'publisher_discovery';
      readonly strategy: 'direct' | 'static' | 'browser';
      readonly proxyType?: 'datacenter' | 'residential';
      readonly documentFormat: 'html' | 'html_with_iframes';
      readonly signal?: AbortSignal;
    },
    context?: RetrievalOperationContext
  ) => Promise<RetrievalResponse>;
  getProcessStatus(): {
    readonly enabled: boolean;
    readonly browserAllowed: boolean;
    readonly residentialAllowed?: boolean;
    readonly availableProxyTypes?: readonly ('datacenter' | 'residential')[];
  };
}

export interface PublicAccessDiscoveryOptions {
  /** Internal bounded-test seam; production callers use the extended default. */
  discoveryTimeoutMs?: number;
  retrievalService?: PublicAccessDiscoveryService;
  configuration?: RetrievalConfiguration;
  directProvider?: RetrievalProvider;
  scrapingAntProvider?: RetrievalProvider;
  publicHttpClient?: PublicHttpClient;
  /** Test/adapter seam; the owned client still composes contextual redirect checks. */
  publicHttpRequester?: PublicHttpRequester;
  validateUrl?: (url: string) => Promise<PublicUrlValidation>;
  /** Shared clock for deterministic offline workflow callers. */
  now?: () => number;
}

interface CandidateRecord {
  readonly artifact: AccessArtifact;
  readonly raw: string;
  readonly validSyntax: boolean;
}

interface CandidateEvaluation {
  readonly artifact?: AccessArtifact;
  readonly candidateCount: number;
  readonly candidatesTruncated: boolean;
}

interface PageClassification {
  readonly kind: 'candidate' | 'restricted' | 'not_found' | 'target_error' | 'rate_limited' | 'dynamic' | 'clean' | 'candidate_limit' | 'failed' | 'unknown';
  readonly candidate?: CandidateEvaluation;
  readonly targetStatus?: number;
}

interface ProviderFailureClassification {
  readonly kind: 'restricted' | 'provider' | 'fallback' | 'failed';
  readonly reason: string;
  readonly apiStatus?: number;
  readonly targetStatus?: number;
}

interface FallbackObservation {
  readonly phase: 'direct' | 'paid';
  readonly response?: RetrievalResponse;
  readonly page?: PageClassification;
  readonly failure?: ProviderFailureClassification;
}

interface DiscoveryOutcome {
  readonly status: AccessDiscoveryStatus;
  /** Internal lifetime of the first discovery flight; never exposed. */
  readonly scopeDeadlineAt?: number;
}

type ManagedDoiResponse = Awaited<ReturnType<PublicHttpClient['request']>> & {
  readonly dispose: () => void;
};

interface ResolvedDoi {
  readonly finalUrl: string;
  readonly leftResolver: boolean;
  readonly targetStatus?: number;
  readonly pageResponse?: RetrievalResponse;
}

interface DiscoveryFlight {
  readonly controller: AbortController;
  readonly cancel: () => void;
  readonly scopeDeadlineAt: number;
  readonly deadlineTimer: ReturnType<typeof setTimeout>;
  promise: Promise<DiscoveryOutcome>;
  waiters: number;
  settled: boolean;
}

interface VerificationFlight {
  readonly controller: AbortController;
  readonly cancel: () => void;
  readonly deadlineAt: number;
  readonly deadlineTimer: ReturnType<typeof setTimeout>;
  promise: Promise<PdfVerificationResult>;
  waiters: number;
  settled: boolean;
}

/**
 * DOI-only, best-effort public access discovery. Core Paper retrieval owns the
 * caller's operation; this class only adds bounded evidence and never treats a
 * candidate as an open-license or complete-download claim.
 */
export class PublicAccessDiscovery {
  private readonly retrievalService: PublicAccessDiscoveryService;
  private readonly publicHttpClient: PublicHttpClient;
  private readonly securityPolicy: OutboundSecurityPolicy;
  private readonly pdfVerifier: PdfAccessVerifier;
  private readonly discoveryTimeoutMs: number;
  private readonly defaultMaxItems: number;
  private readonly discoveryFlights = new WeakMap<object, Map<string, DiscoveryFlight>>();
  private readonly verificationFlights = new WeakMap<object, Map<string, VerificationFlight>>();

  constructor(
    serviceOrLegacyScraper?: PublicAccessDiscoveryService,
    options: PublicAccessDiscoveryOptions = {}
  ) {
    const configuration = options.configuration || parseRetrievalConfiguration();
    this.defaultMaxItems = configuration.accessDiscoveryMaxItems;
    this.discoveryTimeoutMs = Number.isFinite(options.discoveryTimeoutMs) && (options.discoveryTimeoutMs || 0) > 0
      ? Math.min(options.discoveryTimeoutMs as number, MAX_DISCOVERY_TIMEOUT_MS)
      : DEFAULT_DISCOVERY_TIMEOUT_MS;
    const validateUrl = options.validateUrl || ((url: string) => validatePublicHttpUrl(url));
    this.securityPolicy = new OutboundSecurityPolicy({
      validatePublicUrl: async url => {
        await this.assertDiscoveryTarget(url);
        return validateUrl(url);
      }
    });
    this.publicHttpClient = options.publicHttpClient || new PublicHttpClient({
      client: options.publicHttpRequester,
      purpose: 'publisher_discovery',
      securityPolicy: this.securityPolicy
    });
    this.pdfVerifier = new PdfAccessVerifier({
      publicHttpClient: this.publicHttpClient.withPurpose('pdf_probe'),
      now: options.now
    });

    if (options.retrievalService) {
      this.retrievalService = options.retrievalService;
      return;
    }
    if (serviceOrLegacyScraper) {
      this.retrievalService = serviceOrLegacyScraper;
      return;
    }

    this.retrievalService = createRetrievalService({
      directClient: this.publicHttpClient,
      directProvider: options.directProvider,
      scrapingAntProvider: options.scrapingAntProvider,
      configuration,
      securityPolicy: this.securityPolicy
    });
  }

  async enrich(
    papers: Paper[],
    options: PublicAccessDiscoveryRunOptions = {}
  ): Promise<Paper[]> {
    if (options.maxItems !== undefined && !isValidAccessDiscoveryMaxItems(options.maxItems)) {
      throw new Error('maxItems must be an integer between 1 and 100');
    }
    const limit = Math.min(options.maxItems ?? this.defaultMaxItems, papers.length);
    const ownedOperation = options.operation ? undefined : this.retrievalService.createOperation({
      timeoutMs: this.discoveryTimeoutMs,
      purpose: 'publisher_discovery'
    });
    const operation = options.operation || ownedOperation!;
    const enrichmentLimiter = createConcurrencyLimiter(3);
    const scopedOptions = options.operation ? options : { ...options, operation };
    try {
      return await Promise.all(papers.map((paper, index) => index < limit
        ? enrichmentLimiter(() => this.enrichOne(paper, scopedOptions), operation.signal)
          .catch(error => this.cancelledOrFailedPaper(paper, error))
        : Promise.resolve(this.skippedPaper(paper, 'discovery_limit'))));
    } finally {
      ownedOperation?.dispose?.();
    }
  }

  private skippedPaper(paper: Paper, reason: string): Paper {
    const result: Paper = { ...paper, extra: { ...(paper.extra || {}) } };
    this.applyOutcome(result, { status: this.status('skipped', { reason }) });
    return result;
  }

  private cancelledOrFailedPaper(paper: Paper, error: unknown): Paper {
    const isCancelled = error instanceof Error && error.name === 'AbortError';
    return this.skippedPaper(paper, isCancelled ? 'cancelled' : 'discovery_failed');
  }

  private async enrichOne(
    paper: Paper,
    options: PublicAccessDiscoveryRunOptions
  ): Promise<Paper> {
    const result: Paper = {
      ...paper,
      extra: { ...(paper.extra || {}) }
    };
    const doiResult = sanitizeDoi(paper.doi);
    if (!doiResult.valid) {
      this.applyOutcome(result, { status: this.status('skipped', { reason: 'invalid_doi' }) });
      return result;
    }

    const ownsOperation = !options.operation;
    const operationController = ownsOperation ? new AbortController() : undefined;
    const ownedOperation = ownsOperation
      ? this.retrievalService.createOperation({
        signal: operationController!.signal,
        timeoutMs: this.discoveryTimeoutMs,
        purpose: 'publisher_discovery'
      })
      : undefined;
    const operation = options.operation || ownedOperation!;
    const itemController = new AbortController();
    const relayAbort = () => relayAbortReason(itemController, operation.signal);
    if (operation.signal.aborted) relayAbort();
    else operation.signal.addEventListener('abort', relayAbort, { once: true });
    let outcome: DiscoveryOutcome | undefined;
    try {
      const discoveryPromise = this.discoverPaper(
        doiResult.sanitized,
        operation,
        options.verifyPdf === true,
        itemController.signal,
        `doi:${doiResult.sanitized.toLowerCase()}${strategyScopeSuffix(options.strategy)}`,
        options.strategy
      );
      try {
        outcome = await withTimeout(
          discoveryPromise,
          Math.min(this.discoveryTimeoutMs, Math.max(1, operation.remainingMs())),
          'Public access discovery timed out',
          () => abortForRetrievalScope(itemController)
        );
      } catch (error) {
        // Abort the waiter, then allow the already-bounded producer to return
        // any completed candidate/reducer snapshot. This is especially
        // important when optional PDF verification is the only stalled step.
        try {
          outcome = await discoveryPromise;
        } catch {
          throw error;
        }
      }
    } catch (error) {
        const status = error instanceof OutboundSecurityError
        ? this.status('restricted', { reason: 'restricted_target' })
        : error instanceof CapabilityUnavailableError
          ? this.status('skipped', { reason: 'provider_unavailable' })
          : error instanceof RetrievalError && error.code === 'security'
            ? this.status('restricted', { reason: 'restricted_target' })
            : error instanceof RetrievalError && error.code === 'response_too_large'
              ? this.status('failed', { reason: 'response_too_large' })
              : error instanceof RetrievalError && error.code === 'document_limit'
                ? this.status('failed', { reason: 'document_limit' })
                : error instanceof RetrievalError && error.code === 'cancelled'
                  ? this.status(operation.remainingMs() <= 0 ? 'failed' : 'skipped', { reason: operation.remainingMs() <= 0 ? 'deadline_exceeded' : 'cancelled' })
                  : error instanceof Error && error.name === 'AbortError'
                    ? this.status(operation.remainingMs() <= 0 ? 'failed' : 'skipped', { reason: operation.remainingMs() <= 0 ? 'deadline_exceeded' : 'cancelled' })
                    : error instanceof RetrievalError && error.code === 'timeout'
                      ? this.status('failed', { reason: 'deadline_exceeded' })
                      : error instanceof RetrievalError && error.code === 'configuration'
                        ? this.status('skipped', { reason: 'provider_unavailable' })
                        : error instanceof RetrievalError && error.code === 'target_unavailable'
                          ? this.status('failed', { reason: 'target_unavailable' })
                          : this.status('failed', { reason: 'discovery_failed' });
      outcome = { status };
    } finally {
      itemController.abort();
      operation.signal.removeEventListener('abort', relayAbort);
      if (ownsOperation) {
        operationController?.abort();
        ownedOperation?.dispose?.();
      }
    }

    if (outcome) this.applyOutcome(result, outcome);
    return result;
  }

  private async discoverPaper(
    doi: string,
    operation: RetrievalOperationContext,
    verifyPdf: boolean,
    signal: AbortSignal,
    strategyScopeId: string,
    selectedStrategy?: PublicAccessDiscoveryStrategy
  ): Promise<DiscoveryOutcome> {
    const base = await this.getDiscoveryBase(doi, operation, signal, strategyScopeId, selectedStrategy);
    if (!verifyPdf || !base.status.candidateUrl) return cloneDiscoveryOutcome(base);

    const baseStatus = cloneAccessDiscoveryStatus(base.status);
    const scopeExpired = base.scopeDeadlineAt !== undefined
      && operationNow(operation) >= base.scopeDeadlineAt;
    if (scopeExpired) {
      return {
        scopeDeadlineAt: base.scopeDeadlineAt,
        status: {
          ...baseStatus,
          status: 'oa_candidate',
          verification: { status: 'inconclusive', reason: 'aborted_or_timeout' }
        }
      };
    }

    let verification: PdfVerificationResult;
    try {
      verification = {
        ...(await this.getPdfVerification(
          base.status.candidateUrl,
          operation,
          signal,
          strategyScopeId,
          base.scopeDeadlineAt
        ))
      };
    } catch (error) {
      // Verification is an optional derivative. Any verifier failure keeps
      // the already established candidate and is never allowed to restart
      // discovery or escalate to a provider.
      verification = {
        status: isAbortError(error) || operation.signal.aborted || operation.remainingMs() <= 0
          ? 'inconclusive'
          : 'failed',
        reason: isAbortError(error) || operation.signal.aborted || operation.remainingMs() <= 0
          ? 'aborted_or_timeout'
          : 'pdf_probe_failed'
      };
    }
    return {
      scopeDeadlineAt: base.scopeDeadlineAt,
      status: {
        ...baseStatus,
        status: verification.status === 'verified' ? 'pdf_verified' : 'oa_candidate',
        verification: { ...verification }
      }
    };
  }

  private async getDiscoveryBase(
    doi: string,
    operation: RetrievalOperationContext,
    signal: AbortSignal,
    strategyScopeId: string,
    selectedStrategy?: PublicAccessDiscoveryStrategy
  ): Promise<DiscoveryOutcome> {
    if (signal.aborted || operation.signal.aborted) throw createAbortError();
    if (operation.remainingMs() <= 0) throw new RetrievalError({ code: 'timeout', message: 'Discovery operation timed out' });
    const key = strategyScopeId;
    let flights = this.discoveryFlights.get(operation as object);
    if (!flights) {
      flights = new Map();
      this.discoveryFlights.set(operation as object, flights);
    }
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const relayAbort = () => relayAbortReason(controller, operation.signal);
      if (operation.signal.aborted) relayAbort();
      else operation.signal.addEventListener('abort', relayAbort, { once: true });
      const scopeStartedAt = operation.deadlineAt - Math.max(0, operation.remainingMs());
      const scopeDeadlineAt = Math.min(operation.deadlineAt, scopeStartedAt + this.discoveryTimeoutMs);
      let cancel!: () => void;
      const cancelled = new Promise<DiscoveryOutcome>((_resolve, reject) => {
        cancel = () => reject(createAbortError());
      });
      const underlying = this.discoverPaperBase(doi, operation, controller.signal, strategyScopeId, selectedStrategy)
        .then(outcome => ({ ...cloneDiscoveryOutcome(outcome), scopeDeadlineAt }));
      const deadlineTimer = setTimeout(() => {
        abortForRetrievalScope(controller);
        cancel();
      }, Math.max(0, scopeDeadlineAt - operationNow(operation)));
      flight = {
        controller,
        cancel,
        scopeDeadlineAt,
        deadlineTimer,
        promise: Promise.race([underlying, cancelled]),
        waiters: 0,
        settled: false
      };
      flights.set(key, flight);
      flight.promise = flight.promise.finally(() => {
        flight!.settled = true;
        clearTimeout(flight!.deadlineTimer);
        operation.signal.removeEventListener('abort', relayAbort);
      });
    }
    flight.waiters++;
    try {
      return await waitForDiscoveryFlight(flight.promise, signal);
    } catch (error) {
      // At the operation deadline, let the already-cancelled producer finish
      // its bounded reducer so observed direct evidence is preserved. An
      // unrelated parent cancellation remains waiter-local and never waits on
      // an abort-ignoring producer.
      if (operation.signal.aborted && operation.remainingMs() <= 0) {
        flight.controller.abort();
        return await flight.promise;
      }
      throw error;
    } finally {
      flight.waiters--;
      if (flight.waiters === 0 && !flight.settled) {
        flight.cancel();
        flight.controller.abort();
      }
    }
  }

  private async getPdfVerification(
    candidateUrl: string,
    operation: RetrievalOperationContext,
    signal: AbortSignal,
    strategyScopeId: string,
    scopeDeadlineAt?: number
  ): Promise<PdfVerificationResult> {
    if (signal.aborted || operation.signal.aborted) return { status: 'inconclusive', reason: 'aborted_or_timeout' };
    const effectiveDeadlineAt = Math.min(operation.deadlineAt, scopeDeadlineAt ?? operation.deadlineAt);
    let flights = this.verificationFlights.get(operation as object);
    if (!flights) {
      flights = new Map();
      this.verificationFlights.set(operation as object, flights);
    }
    let flight = flights.get(strategyScopeId);
    if (!flight && (operation.remainingMs() <= 0 || operationNow(operation) >= effectiveDeadlineAt)) {
      return { status: 'inconclusive', reason: 'aborted_or_timeout' };
    }
    if (!flight) {
      const controller = new AbortController();
      const relayAbort = () => relayAbortReason(controller, operation.signal);
      if (operation.signal.aborted) relayAbort();
      else operation.signal.addEventListener('abort', relayAbort, { once: true });
      const deadlineAt = effectiveDeadlineAt;
      let cancel!: () => void;
      const cancelled = new Promise<PdfVerificationResult>(resolve => {
        cancel = () => resolve({ status: 'inconclusive', reason: 'aborted_or_timeout' });
      });
      const underlying = (async (): Promise<PdfVerificationResult> => {
        try {
          await this.validateDiscoveryUrl(candidateUrl, controller.signal);
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return { status: 'inconclusive', reason: 'aborted_or_timeout' };
          if (error instanceof OutboundSecurityError || error instanceof SensitiveOutboundTargetError) {
            return { status: 'failed', reason: 'restricted_target' };
          }
          return { status: 'failed', reason: 'verification_target_rejected' };
        }
        return this.pdfVerifier.verify(candidateUrl, controller.signal, operation.dispatchObserver, deadlineAt, operation.withDispatchSlot);
      })();
      const deadlineTimer = setTimeout(() => {
        abortForRetrievalScope(controller);
        cancel();
      }, Math.max(0, deadlineAt - operationNow(operation)));
      flight = {
        controller,
        cancel,
        deadlineAt,
        deadlineTimer,
        promise: Promise.race([underlying, cancelled]),
        waiters: 0,
        settled: false
      };
      flights.set(strategyScopeId, flight);
      flight.promise = flight.promise.finally(() => {
        flight!.settled = true;
        clearTimeout(flight!.deadlineTimer);
        operation.signal.removeEventListener('abort', relayAbort);
      });
    }
    flight.waiters++;
    try {
      return await waitForVerificationFlight(flight.promise, signal);
    } catch (error) {
      // A cancelled waiter must not wait indefinitely for an abort-ignoring
      // verifier; the candidate remains available to the caller as an
      // inconclusive optional derivative.
      throw error;
    } finally {
      flight.waiters--;
      if (flight.waiters === 0 && !flight.settled) {
        flight.cancel();
        flight.controller.abort();
      }
    }
  }

  private async discoverPaperBase(
    doi: string,
    operation: RetrievalOperationContext,
    signal: AbortSignal,
    strategyScopeId: string,
    selectedStrategy?: PublicAccessDiscoveryStrategy
  ): Promise<DiscoveryOutcome> {
    const landing = await this.resolveDoi(doi, operation, signal);
    if (!landing.leftResolver) {
      throw new RetrievalError({
        code: 'target_unavailable',
        message: 'DOI resolution did not establish a Publisher target'
      });
    }
    const landingUrl = landing.finalUrl;
    if (landing.targetStatus === 429) {
      return this.outcome(this.status('failed', {
        reason: 'target_rate_limited',
        landingUrl,
        landingHost: new URL(landingUrl).hostname,
        targetStatus: landing.targetStatus
      }));
    }
    await this.validateDiscoveryUrl(landingUrl, signal);
    const landingHost = new URL(landingUrl).hostname;
    const baseStatus = { landingUrl, landingHost };
    const observations: FallbackObservation[] = [];

    if (selectedStrategy) {
      if (landing.pageResponse && selectedStrategy.strategy !== 'direct') {
        let resolverPage: PageClassification;
        try {
          resolverPage = await this.classifyPage(landing.pageResponse, signal);
        } catch (error) {
          if (signal.aborted || operation.signal.aborted || isAbortError(error)) throw error;
          resolverPage = { kind: 'failed', targetStatus: landing.pageResponse.targetStatus };
        }
        if (resolverPage.kind === 'restricted'
          || resolverPage.kind === 'rate_limited'
          || resolverPage.kind === 'target_error'
          || resolverPage.kind === 'not_found'
          || resolverPage.kind === 'candidate_limit') {
          // Retain only terminal resolver evidence. Clean/dynamic/candidate
          // resolver pages must not outrank the selected paid result below.
          observations.push({ phase: 'direct', response: landing.pageResponse, page: resolverPage });
          return this.reduceFallbackOutcome(baseStatus, observations);
        }
      }
      return this.retrieveSelectedStrategy(
        landingUrl,
        landing.pageResponse,
        selectedStrategy,
        operation,
        baseStatus,
        observations,
        signal
      );
    }

    let directResponse: RetrievalResponse;
    try {
      if (!landing.pageResponse && !this.retrievalService.retrieveWithRetry) {
        throw new RetrievalError({
          code: 'configuration',
          message: 'Publisher retry retrieval is unavailable'
        });
      }
      directResponse = landing.pageResponse || await this.retrievalService.retrieveWithRetry!({
        url: landingUrl,
        purpose: 'publisher_discovery',
        strategy: 'direct',
        proxyType: 'datacenter',
        documentFormat: 'html_with_iframes',
        signal
      }, operation, {
        strategyScopeId,
        shouldRetryResponse: response => {
          const targetStatus = response.targetStatus ?? response.document?.targetStatus;
          return targetStatus !== undefined
            && targetStatus >= 500
            && targetStatus <= 599
            && !responseHasPermissionRestriction(response);
        }
      });
    } catch (error) {
      const classified = classifyProviderFailure(error);
      const failure = isDirectRecoverableFailure(error)
        ? { ...classified, reason: 'direct_failed' }
        : classified;
      observations.push({ phase: 'direct', failure });
      if (failure.kind === 'restricted' || failure.reason === 'target_rate_limited' || isNonSwitchableDirectFailure(error)
        || signal.aborted || operation.signal.aborted || !this.canUsePaidFallback()) {
        return this.reduceFallbackOutcome(baseStatus, observations);
      }
      return this.tryPaidStrategies(landingUrl, operation, baseStatus, observations, signal, strategyScopeId);
    }

    let directPage: PageClassification;
    try {
      directPage = await this.classifyPage(directResponse, signal);
    } catch (error) {
      if (signal.aborted || operation.signal.aborted || isAbortError(error)) throw error;
      directPage = { kind: 'failed', targetStatus: directResponse.targetStatus };
    }
    const directObservation: FallbackObservation = { phase: 'direct', response: directResponse, page: directPage };
    observations.push(directObservation);
    if (directPage.kind === 'candidate') return this.applyCandidate(directResponse, directPage.candidate!, baseStatus);
    if (directPage.kind === 'restricted' || directPage.kind === 'rate_limited') return this.reduceFallbackOutcome(baseStatus, observations);
    if (directPage.kind === 'candidate_limit') return this.reduceFallbackOutcome(baseStatus, observations);
    if (directPage.kind === 'not_found') {
      return this.reduceFallbackOutcome(baseStatus, observations);
    }
    if (!this.canUsePaidFallback()) return this.reduceFallbackOutcome(baseStatus, observations);
    return this.tryPaidStrategies(landingUrl, operation, baseStatus, observations, signal, strategyScopeId);
  }

  /**
   * Benchmark-only comparison path. It keeps DOI resolution and normal page
   * classification, but deliberately submits one selected strategy and never
   * enters the production fallback loop.
   */
  private async retrieveSelectedStrategy(
    landingUrl: string,
    resolverPageResponse: RetrievalResponse | undefined,
    selectedStrategy: PublicAccessDiscoveryStrategy,
    operation: RetrievalOperationContext,
    baseStatus: { readonly landingUrl: string; readonly landingHost: string },
    observations: FallbackObservation[],
    signal: AbortSignal
  ): Promise<DiscoveryOutcome> {
    if (signal.aborted || operation.signal.aborted) throw createAbortError();
    if (selectedStrategy.strategy === 'direct' && selectedStrategy.proxyType === 'residential') {
      return this.outcome(this.status('failed', {
        ...baseStatus,
        reason: 'unsupported_strategy'
      }));
    }

    let response: RetrievalResponse;
    try {
      if (!this.retrievalService.retrieveOnce && !(selectedStrategy.strategy === 'direct' && resolverPageResponse)) {
        throw new RetrievalError({
          code: 'configuration',
          message: 'A single-strategy Publisher comparison requires a one-attempt retrieval service'
        });
      }
      response = selectedStrategy.strategy === 'direct' && resolverPageResponse
        ? resolverPageResponse
        : await this.retrievalService.retrieveOnce!({
          url: landingUrl,
          purpose: 'publisher_discovery',
          strategy: selectedStrategy.strategy,
          proxyType: selectedStrategy.proxyType || 'datacenter',
          documentFormat: 'html_with_iframes',
          signal
        }, operation);
    } catch (error) {
      if (signal.aborted || operation.signal.aborted || isAbortError(error)) throw error;
      observations.push({ phase: selectedStrategy.strategy === 'direct' ? 'direct' : 'paid', failure: classifyProviderFailure(error) });
      return this.reduceFallbackOutcome(baseStatus, observations);
    }

    let page: PageClassification;
    try {
      page = await this.classifyPage(response, signal);
    } catch (error) {
      if (signal.aborted || operation.signal.aborted || isAbortError(error)) throw error;
      page = { kind: 'failed', targetStatus: response.targetStatus };
    }
    observations.push({
      phase: selectedStrategy.strategy === 'direct' ? 'direct' : 'paid',
      response,
      page
    });
    if (page.kind === 'candidate' && page.candidate) {
      return this.applyCandidate(response, page.candidate, baseStatus);
    }
    return this.reduceFallbackOutcome(baseStatus, observations);
  }

  private async tryPaidStrategies(
    landingUrl: string,
    operation: RetrievalOperationContext,
    baseStatus: { readonly landingUrl: string; readonly landingHost: string },
    observations: FallbackObservation[],
    signal: AbortSignal,
    strategyScopeId: string
  ): Promise<DiscoveryOutcome> {
    const process = this.retrievalService.getProcessStatus();
    const plans = paidFallbackPlans(process);
    if (!this.retrievalService.retrieveWithRetry) return this.reduceFallbackOutcome(baseStatus, observations);
    for (const plan of plans) {
      if (signal.aborted || operation.signal.aborted || operation.remainingMs() <= 0) {
        return this.reduceFallbackOutcome(baseStatus, observations);
      }
      let response: RetrievalResponse;
      try {
        response = await this.retrievalService.retrieveWithRetry!({
          url: landingUrl,
          purpose: 'publisher_discovery',
          strategy: plan.strategy,
          proxyType: plan.proxyType,
          documentFormat: plan.strategy === 'browser' ? 'html_with_iframes' : 'html_with_iframes',
          signal
        }, operation, { strategyScopeId });
      } catch (error) {
        const failure = classifyProviderFailure(error);
        observations.push({ phase: 'paid', failure });
        if (signal.aborted || operation.signal.aborted || operation.remainingMs() <= 0) {
          return this.reduceFallbackOutcome(baseStatus, observations);
        }
        if (failure.kind === 'restricted' || isNonSwitchablePaidFailure(error, operation)) {
          return this.reduceFallbackOutcome(baseStatus, observations);
        }
        continue;
      }

      let page: PageClassification;
      try {
        page = await this.classifyPage(response, signal);
      } catch (error) {
        if (signal.aborted || operation.signal.aborted || isAbortError(error)) throw error;
        page = { kind: 'failed', targetStatus: response.targetStatus };
      }
      const observation: FallbackObservation = { phase: 'paid', response, page };
      observations.push(observation);
      if (page.kind === 'candidate') return this.applyCandidate(response, page.candidate!, baseStatus);
      if (page.kind === 'not_found' || page.kind === 'restricted' || page.kind === 'rate_limited' || page.kind === 'candidate_limit') {
        return this.reduceFallbackOutcome(baseStatus, observations);
      }
    }
    return this.reduceFallbackOutcome(baseStatus, observations);
  }

  private reduceFallbackOutcome(
    baseStatus: { readonly landingUrl: string; readonly landingHost: string },
    observations: readonly FallbackObservation[]
  ): DiscoveryOutcome {
    const fallback = fallbackDiagnostics(observations);
    const restricted = observations.find(observation => observation.page?.kind === 'restricted' || observation.failure?.kind === 'restricted');
    if (restricted) {
      const response = restricted.response;
      const page = restricted.page;
      return this.outcome(this.status('restricted', {
        ...baseStatus,
        reason: restricted.failure?.reason || 'restricted_page',
        ...fallback,
        ...(response ? this.pageDetails(response, page) : {})
      }));
    }
    const resourceFailure = observations.find(observation =>
      observation.failure?.reason === 'response_too_large' || observation.failure?.reason === 'document_limit'
    );
    if (resourceFailure) {
      const failure = resourceFailure.failure!;
      return this.outcome(this.status('failed', {
        ...baseStatus,
        reason: failure.reason,
        ...fallback,
        ...(failure.apiStatus === undefined ? {} : { apiStatus: failure.apiStatus }),
        ...(failure.targetStatus === undefined ? {} : { targetStatus: failure.targetStatus })
      }));
    }

    const targetAbsence = observations.find(observation =>
      observation.page?.kind === 'target_error' && (observation.page.targetStatus === 404 || observation.page.targetStatus === 410)
      || observation.failure?.targetStatus === 404 || observation.failure?.targetStatus === 410
    );
    const notFound = observations.find(observation => observation.page?.kind === 'not_found');
    // Explicit target absence is stronger than a later/earlier candidate
    // ceiling: truncation must never turn a known 404/410 or clean
    // "not found" statement into an ambiguous skipped result.
    if (targetAbsence) {
      const response = targetAbsence.response;
      return this.outcome(this.status('not_found', {
        ...baseStatus,
        reason: 'target_not_found',
        ...fallback,
        ...(response ? this.pageDetails(response, targetAbsence.page) : {}),
        ...(targetAbsence.failure?.targetStatus === undefined ? {} : { targetStatus: targetAbsence.failure.targetStatus })
      }));
    }

    if (notFound) {
      const response = notFound.response;
      return this.outcome(this.status('not_found', {
        ...baseStatus,
        reason: 'target_not_found',
        ...fallback,
        ...(response ? this.pageDetails(response, notFound.page) : {})
      }));
    }

    const candidateLimit = observations.find(observation => observation.page?.kind === 'candidate_limit');
    if (candidateLimit) {
      const response = candidateLimit.response;
      return this.outcome(this.status('skipped', {
        ...baseStatus,
        reason: 'candidate_limit',
        ...fallback,
        ...(response ? this.pageDetails(response, candidateLimit.page) : {})
      }));
    }
    const clean = observations.find(observation => observation.page?.kind === 'clean');
    if (clean) {
      const response = clean.response;
      return this.outcome(this.status('not_found', {
        ...baseStatus,
        reason: 'no_candidate',
        ...fallback,
        ...(response ? this.pageDetails(response, clean.page) : {})
      }));
    }

    const last = observations[observations.length - 1];
    const dynamic = observations.find(observation => observation.page?.kind === 'dynamic');
    if (dynamic && last?.failure?.kind === 'fallback') {
      // A cancelled/unavailable ordinary fallback cannot erase the direct
      // page's bounded dynamic observation or turn it into a false success.
      const response = dynamic.response;
      return this.outcome(this.status('not_found', {
        ...baseStatus,
        reason: 'dynamic_unresolved',
        ...fallback,
        ...(response ? this.pageDetails(response, dynamic.page) : {})
      }));
    }
    if (last?.failure) {
      const failure = last.failure;
      return this.outcome(this.status(
        failure.kind === 'provider' ? 'skipped' : 'failed',
        {
          ...baseStatus,
          reason: failure.reason,
          ...fallback,
          ...(failure.apiStatus === undefined ? {} : { apiStatus: failure.apiStatus }),
          ...(failure.targetStatus === undefined ? {} : { targetStatus: failure.targetStatus }),
          ...(last.response ? this.pageDetails(last.response, last.page) : {})
        }
      ));
    }
    const lastPage = last?.page;
    const lastResponse = last?.response;
    return this.outcome(this.status(
      lastPage?.kind === 'unknown' || lastPage?.kind === 'rate_limited' || lastPage?.kind === 'failed' || lastPage?.kind === 'target_error' ? 'failed' : 'not_found',
      {
        ...baseStatus,
        reason: lastPage?.kind === 'unknown' ? 'target_status_unknown' : lastPage?.kind === 'rate_limited' ? 'target_rate_limited' : lastPage?.kind === 'target_error' ? 'target_error' : lastPage?.kind === 'failed' ? 'direct_failed' : lastPage?.kind === 'dynamic' ? 'dynamic_unresolved' : 'no_candidate',
        ...fallback,
        ...(lastResponse ? this.pageDetails(lastResponse, lastPage) : {})
      }
    ));
  }

  private async classifyPage(
    response: RetrievalResponse,
    signal: AbortSignal
  ): Promise<PageClassification> {
    const document = response.document;
    const targetStatus = response.targetStatus ?? document?.targetStatus;
    const pageText = document ? documentText(document) : '';
    const pageMarkup = document
      ? [document.html, ...document.iframes.map(frame => frame.html)].join(' ')
      : '';
    if (document && isPermissionRestrictedPage(pageText, pageMarkup)) return { kind: 'restricted', targetStatus };
    // HTTP permission/rate-limit and explicit absence facts outrank a
    // challenge token in the returned body. A 404 CAPTCHA page is still a
    // target error, while a 401 CAPTCHA page is still restricted.
    if (targetStatus === 401 || targetStatus === 407 || targetStatus === 423 || targetStatus === 429) {
      return { kind: targetStatus === 429 ? 'rate_limited' : 'restricted', targetStatus };
    }
    if (targetStatus === 404 || targetStatus === 410) return { kind: 'target_error', targetStatus };
    if (document && isChallengePage(pageText, pageMarkup)) return { kind: 'failed', targetStatus };
    if (!document) {
      return { kind: targetStatus !== undefined && targetStatus >= 400 ? 'failed' : 'unknown', targetStatus };
    }
    if (targetStatus !== undefined && (targetStatus < 200 || targetStatus >= 300)) {
      return { kind: targetStatus === 404 || targetStatus === 410 ? 'target_error' : 'failed', targetStatus };
    }
    if (!document.html.trim() && document.iframes.length === 0) {
      return { kind: 'failed', targetStatus };
    }
    if (targetStatus !== undefined && targetStatus >= 200 && targetStatus < 300 && isExplicitlyNotFound(pageText)) {
      return { kind: 'not_found', targetStatus };
    }

    const candidate = await this.findCandidate(document, signal);
    if (candidate.artifact) return { kind: 'candidate', candidate, targetStatus };
    if (candidate.candidatesTruncated) return { kind: 'candidate_limit', candidate, targetStatus };
    // A missing target status is deliberately inconclusive, but it can still
    // enter an explicitly authorised finite fallback sequence.
    if (signal.aborted) throw createAbortError();
    if (targetStatus === undefined) return { kind: 'unknown', candidate, targetStatus };
    if (targetStatus >= 200 && targetStatus < 300 && await this.hasApprovedDynamicShape(document, signal)) {
      return { kind: 'dynamic', candidate, targetStatus };
    }
    return { kind: 'clean', candidate, targetStatus };
  }

  private async findCandidate(
    document: FiniteDocument,
    signal: AbortSignal
  ): Promise<CandidateEvaluation> {
    const records = collectCandidates(document);
    const candidatesTruncated = records.length > MAX_CANDIDATES;
    const recordsToEvaluate = records.slice(0, MAX_CANDIDATES);
    let firstSafe: AccessArtifact | undefined;

    for (const record of recordsToEvaluate) {
      if (signal.aborted) return { candidateCount: records.length, candidatesTruncated };
      if (!record.validSyntax) continue;
      try {
        await this.validateDiscoveryUrl(record.artifact.url, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        continue;
      }
      if (signal.aborted) return { candidateCount: records.length, candidatesTruncated };
      firstSafe = record.artifact;
      break;
    }

    return {
      artifact: firstSafe,
      candidateCount: records.length,
      candidatesTruncated
    };
  }

  private applyCandidate(
    response: RetrievalResponse,
    evaluation: CandidateEvaluation,
    baseStatus: { readonly landingUrl: string; readonly landingHost: string }
  ): DiscoveryOutcome {
    const artifact = evaluation.artifact;
    if (!artifact) return this.outcome(this.status('failed', { reason: 'candidate_missing' }));
    return this.outcome(this.status('oa_candidate', {
      ...baseStatus,
      candidateUrl: artifact.url,
      method: artifact.method,
      evidence: artifact,
      candidatesTruncated: evaluation.candidatesTruncated,
      candidateCount: evaluation.candidateCount,
      provider: response.provider,
      strategy: response.strategy,
      ...(response.proxyType ? { proxyType: response.proxyType } : {}),
      ...knownCost(response),
      ...this.pageDetails(response)
    }));
  }

  private async resolveDoi(
    doi: string,
    operation: RetrievalOperationContext,
    signal: AbortSignal
  ): Promise<ResolvedDoi> {
    const doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
    let response = await this.requestDoi(doiUrl, { method: 'HEAD' }, operation, signal);
    let pageResponse: RetrievalResponse | undefined;
    if (response.response.status === 405 || response.response.status === 501) {
      response.dispose();
      response = await this.requestDoi(doiUrl, {
        method: 'GET',
        responseType: 'stream',
        consumeStreamBodyWithinDispatchSlot: true,
        maxBodyBytes: MAX_DISCOVERY_RESPONSE_BYTES,
        streamBodyConsumer: (body: unknown, requestSignal?: AbortSignal) => readBoundedDiscoveryText(body, operation, requestSignal || signal)
      }, operation, signal);
      try {
        pageResponse = await this.toDirectPageResponse(response, operation, signal);
      } finally {
        response.dispose();
      }
    } else {
      response.dispose();
    }

    const leftResolver = !isDoiResolverUrl(response.finalUrl);
    if (!leftResolver) {
      throw new RetrievalError({
        code: 'target_unavailable',
        message: 'DOI resolution did not establish a Publisher target',
        targetStatus: toHttpStatus(response.response.status)
      });
    }
    return {
      finalUrl: response.finalUrl,
      leftResolver,
      targetStatus: toHttpStatus(response.response.status),
      pageResponse
    };
  }

  private async requestDoi(
    url: string,
    config: Record<string, unknown>,
    operation: RetrievalOperationContext,
    parentSignal: AbortSignal
  ): Promise<ManagedDoiResponse> {
    const controller = new AbortController();
    const relayAbort = () => relayAbortReason(controller, parentSignal);
    if (parentSignal.aborted) relayAbort();
    else parentSignal.addEventListener('abort', relayAbort, { once: true });
    const remainingMs = operation.remainingMs();
    if (remainingMs <= 0) {
      controller.abort();
      parentSignal.removeEventListener('abort', relayAbort);
      throw createAbortError();
    }

    let released = false;
    let lateResponse: Awaited<ReturnType<PublicHttpClient['request']>> | undefined;
    const requestPromise = this.publicHttpClient.request(url, {
      ...config,
      timeout: Math.min(TIMEOUTS.DEFAULT, remainingMs),
      deadlineAt: operation.deadlineAt,
      signal: controller.signal,
      dispatchObserver: operation.dispatchObserver,
      ...(operation.withDispatchSlot ? { dispatchSlot: operation.withDispatchSlot } : {}),
      holdSourceLease: true
    });
    requestPromise.then(response => {
      lateResponse = response;
      if (released) {
        disposeResponseBody(response.response.data);
        response.release?.();
      }
    }, () => undefined);
    const release = () => {
      if (released) return;
      released = true;
      parentSignal.removeEventListener('abort', relayAbort);
      controller.abort();
      disposeResponseBody(lateResponse?.response.data);
      lateResponse?.release?.();
    };

    try {
      const response = await withTimeout(
        requestPromise,
        remainingMs,
        'DOI resolution timed out',
        () => controller.abort()
      );
      lateResponse = response;
      return { ...response, dispose: release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async toDirectPageResponse(
    response: Awaited<ReturnType<PublicHttpClient['request']>>,
    operation: RetrievalOperationContext,
    signal: AbortSignal
  ): Promise<RetrievalResponse> {
    const targetStatus = toHttpStatus(response.response.status);
    const html = await readBoundedDiscoveryText(response.response.data, operation, signal);
    return {
      provider: 'direct',
      strategy: 'direct',
      targetStatus,
      document: {
        kind: 'html',
        html,
        iframes: [],
        source: { provenance: 'trusted_direct', finalUrl: response.finalUrl },
        ...(targetStatus === undefined ? {} : { targetStatus })
      },
      ...(getHeaderValue(response.response.headers, 'content-type')
        ? { contentType: getHeaderValue(response.response.headers, 'content-type') }
        : {}),
      cost: { known: true, credits: 0 }
    };
  }

  private canUsePaidFallback(): boolean {
    return this.retrievalService.getProcessStatus().enabled;
  }

  private canUseBrowserFallback(): boolean {
    const status = this.retrievalService.getProcessStatus();
    return status.enabled && status.browserAllowed;
  }

  private async hasApprovedDynamicShape(document: FiniteDocument, signal: AbortSignal): Promise<boolean> {
    const sources = [
      { html: document.html, source: document.source },
      ...document.iframes.map(frame => ({ html: frame.html, source: frame.source }))
    ];
    for (const entry of sources) {
      if (hasEmptyPdfShape(entry.html)) return true;
      for (const rawDataSrc of dynamicDataSources(entry.html)) {
        const dataSrc = resolveDynamicDataSrc(rawDataSrc, entry.source);
        if (!dataSrc) continue;
        try {
          await this.validateDiscoveryUrl(dataSrc, signal);
          return true;
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error;
        }
      }
    }
    return false;
  }

  private async validateDiscoveryUrl(url: string, signal?: AbortSignal): Promise<PublicUrlValidation> {
    if (hasSensitiveCandidateCredentials(url)) throw new SensitiveOutboundTargetError();
    const validation = this.securityPolicy.validate(url, 'publisher_discovery');
    return signal ? awaitWithAbort(validation, signal) : validation;
  }

  private async assertDiscoveryTarget(url: string): Promise<void> {
    if (isRestrictedDiscoveryTarget(url)) throw new SensitiveOutboundTargetError();
  }

  private pageDetails(response: RetrievalResponse, page?: PageClassification): Record<string, unknown> {
    return {
      ...(response.apiStatus === undefined ? {} : { apiStatus: response.apiStatus }),
      ...(page?.targetStatus === undefined && response.targetStatus === undefined
        ? {}
        : { targetStatus: page?.targetStatus ?? response.targetStatus }),
      ...(page?.candidate ? {
        candidateCount: page.candidate.candidateCount,
        candidatesTruncated: page.candidate.candidatesTruncated
      } : {})
    };
  }

  private applyOutcome(result: Paper, outcome: DiscoveryOutcome): void {
    const candidateUrl = outcome.status.candidateUrl;
    if (candidateUrl && !result.pdfUrl) result.pdfUrl = candidateUrl;
    result.extra = { ...(result.extra || {}), accessDiscovery: outcome.status };
  }

  private outcome(status: AccessDiscoveryStatus): DiscoveryOutcome {
    return { status };
  }

  private status(state: AccessDiscoveryState, details: Omit<AccessDiscoveryStatus, 'status' | 'fetchedAt'>): AccessDiscoveryStatus {
    return {
      status: state,
      ...details,
      fetchedAt: new Date().toISOString()
    };
  }
}

function collectCandidates(document: FiniteDocument): CandidateRecord[] {
  const records: CandidateRecord[] = [];
  const seen = new Set<string>();
  if (!collectFromHtml(document.html, document.source, records, seen)) return records;
  for (const iframe of document.iframes) {
    if (!collectFromHtml(iframe.html, iframe.source, records, seen, true, [iframe.src])) return records;
  }
  return records;
}

function collectFromHtml(
  html: string,
  source: DocumentProvenance,
  records: CandidateRecord[],
  seen: Set<string>,
  iframe = false,
  additionalSources: readonly string[] = []
): boolean {
  const $ = cheerio.load(html || '');
  const add = (raw: string | undefined, method: AccessArtifact['method']): boolean => {
    if (!raw) return true;
    const resolved = resolveCandidate(raw, source);
    const record: CandidateRecord = {
      raw,
      validSyntax: Boolean(resolved),
      artifact: {
        url: resolved || raw,
        method: iframe ? 'iframe_pdf' : method,
        source: evidenceProvenance(source)
      }
    };
    const key = record.validSyntax ? record.artifact.url : `${record.artifact.method}:${record.raw}`;
    if (seen.has(key)) return true;
    seen.add(key);
    records.push(record);
    return records.length <= MAX_CANDIDATES;
  };
  const each = (selector: string, visit: (element: any) => boolean): boolean => {
    let keepGoing = true;
    $(selector).each((_index, element) => {
      if (!keepGoing) return false;
      keepGoing = visit(element);
      return keepGoing;
    });
    return keepGoing;
  };

  if (!each('meta[name="citation_pdf_url" i]', element => add($(element).attr('content'), 'citation_pdf_url'))) return false;
  if (!each('link[rel~="alternate"][type="application/pdf" i]', element => add($(element).attr('href'), 'alternate_pdf'))) return false;
  if (!each('a[href], link[href]', element => {
    const href = $(element).attr('href');
    return !href || !/\.pdf(?:[?#].*)?$/i.test(href) || add(href, 'pdf_anchor');
  })) return false;
  if (!each('iframe[src]', element => {
    const src = $(element).attr('src');
    return !src || !/\.pdf(?:[?#].*)?$/i.test(src) || add(src, 'iframe_pdf');
  })) return false;
  return additionalSources.every(sourceUrl =>
    !sourceUrl || !/\.pdf(?:[?#].*)?$/i.test(sourceUrl) || add(sourceUrl, 'iframe_pdf')
  );
}

function resolveCandidate(raw: string, source: DocumentProvenance): string | undefined {
  try {
    const isAbsolute = /^https?:\/\//i.test(raw);
    if (!isAbsolute && source.provenance !== 'trusted_direct') return undefined;
    const resolved = new URL(raw, source.provenance === 'trusted_direct' ? source.finalUrl : undefined);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    if (resolved.username || resolved.password) return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function evidenceProvenance(source: DocumentProvenance): DocumentProvenance {
  const raw = source.provenance === 'trusted_direct' ? source.finalUrl : source.submittedUrl;
  if (!hasSensitiveCandidateCredentials(raw)) return source;
  try {
    const sanitized = new URL(raw);
    sanitized.search = '';
    sanitized.hash = '';
    return { provenance: 'unknown_remote', submittedUrl: sanitized.toString() };
  } catch {
    return { provenance: 'unknown_remote', submittedUrl: '[redacted]' };
  }
}

function documentText(document: FiniteDocument): string {
  return [document.html, ...document.iframes.map(frame => frame.html)]
    .map(html => cheerio.load(html || '').text())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function responseHasPermissionRestriction(response: RetrievalResponse): boolean {
  const document = response.document;
  if (!document) return false;
  const markup = [document.html, ...document.iframes.map(frame => frame.html)].join(' ');
  return isPermissionRestrictedPage(documentText(document), markup);
}

function isPermissionRestrictedPage(text: string, markup?: string): boolean {
  const source = markup ? permissionContentText(markup) : text;
  return /(?:subscription\s+required|institutional\s+(?:access|login)|(?:behind\s+(?:a\s+)?paywall|paywall\s+(?:required|access|subscription))|purchase\s+(?:access|article)|full\s*text\s+(?:is\s+)?(?:unavailable|restricted)|institutional\s+subscription|member\s+access)/i.test(source)
    || /(?:please|you\s+must|must)\s+(?:sign|log)\s*in\b|(?:sign|log)\s*in\s+(?:to\s+(?:access|continue|view)|is\s+required|required)|(?:full\s*text|article|access)\s+(?:requires?|needs?)\s+(?:a\s+)?(?:sign\s*in|log\s*in|login)/i.test(source);
}

function isChallengePage(text: string, markup?: string): boolean {
  const source = markup ? challengeContentText(markup) : text;
  return /(?:captcha|recaptcha)\s+(?:verification|required|challenge|check)|(?:verify|complete)\s+(?:the\s+)?(?:captcha|recaptcha)|cloudflare|just\s+a\s+moment|checking\s+your\s+browser|verify\s+you\s+are\s+human|please\s+wait/i.test(source);
}

function permissionContentText(markup: string): string {
  return filteredContentText(markup, false);
}

function challengeContentText(markup: string): string {
  // Challenge markers in noscript fallbacks are not reliable page-gate
  // evidence; retain noscript only for the permission classifier, where it
  // can contain the real subscription/login message shown without scripts.
  return filteredContentText(markup, true);
}

function filteredContentText(markup: string, removeNoscript: boolean): string {
  const $ = cheerio.load(markup || '');
  const root = $.root();
  // Script/style source is implementation metadata, not visible access
  // evidence. A normal publisher page can mention a challenge vendor in its
  // anti-bot bundle; treating that token as a challenge masks real papers.
  const selectors = 'nav, header, footer, [role="navigation"], script, style, template'
    + (removeNoscript ? ', noscript' : '');
  root.find(selectors).remove();
  return `${root.text()} ${root.html() || ''}`;
}

function isExplicitlyNotFound(text: string): boolean {
  return /(?:article|paper|page|record)\s+(?:not\s+found|does\s+not\s+exist)|no\s+such\s+(?:article|record)|content\s+(?:not\s+found|unavailable)/i.test(text);
}

function dynamicDataSources(html: string): string[] {
  const $ = cheerio.load(html || '');
  return $('iframe').toArray().flatMap(element => {
    const frame = $(element);
    const id = (frame.attr('id') || '').trim().toLowerCase();
    const classTokens = (frame.attr('class') || '').split(/\s+/).filter(Boolean).map(token => token.toLowerCase());
    const hasPdfToken = id === 'pdf' || classTokens.includes('pdf-viewer');
    const src = frame.attr('src')?.trim() || '';
    const dataSrc = frame.attr('data-src')?.trim() || '';
    return hasPdfToken && src === '' && dataSrc ? [dataSrc] : [];
  });
}

function hasEmptyPdfShape(html: string): boolean {
  const $ = cheerio.load(html || '');
  const pdfContainer = $('#pdf');
  return pdfContainer.length > 0
    && !pdfContainer.is('iframe')
    && $('iframe').length === 0
    && pdfContainer.children().length === 0
    && pdfContainer.text().trim() === ''
    && $('script[src]').length > 0;
}

function isSafeDynamicDataSrc(value: string): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (isIPLiteral(hostname) && !isPublicAddress(hostname)) return false;
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && Boolean(hostname)
      && !hasSensitiveCandidateCredentials(value)
      && !['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata.google.internal', 'metadata.google.com'].includes(hostname)
      && !hostname.endsWith('.localhost')
      && !hostname.endsWith('.local')
      && !hostname.endsWith('.internal');
  } catch {
    return false;
  }
}

function resolveDynamicDataSrc(value: string, source: DocumentProvenance): string | undefined {
  try {
    if (source.provenance !== 'trusted_direct' && !/^https?:\/\//i.test(value)) return undefined;
    const resolved = new URL(value, source.provenance === 'trusted_direct' ? source.finalUrl : undefined).toString();
    return isSafeDynamicDataSrc(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function waitForDiscoveryFlight(
  promise: Promise<DiscoveryOutcome>,
  signal: AbortSignal
): Promise<DiscoveryOutcome> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
  });
}

function waitForVerificationFlight(
  promise: Promise<PdfVerificationResult>,
  signal: AbortSignal
): Promise<PdfVerificationResult> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); }
    );
  });
}

function operationNow(operation: RetrievalOperationContext): number {
  return operation.deadlineAt - Math.max(0, operation.remainingMs());
}

function cloneDiscoveryOutcome(outcome: DiscoveryOutcome): DiscoveryOutcome {
  return {
    status: cloneAccessDiscoveryStatus(outcome.status),
    ...(outcome.scopeDeadlineAt === undefined ? {} : { scopeDeadlineAt: outcome.scopeDeadlineAt })
  };
}

function cloneAccessDiscoveryStatus(status: AccessDiscoveryStatus): AccessDiscoveryStatus {
  return {
    ...status,
    ...(status.evidence
      ? { evidence: { ...status.evidence, source: { ...status.evidence.source } } }
      : {}),
    ...(status.verification ? { verification: { ...status.verification } } : {}),
    ...(status.fallback ? { fallback: { ...status.fallback } } : {})
  };
}

function isDoiResolverUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return hostname === 'doi.org' || hostname === 'dx.doi.org';
  } catch {
    return false;
  }
}

function toHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

async function readBoundedDiscoveryText(
  body: unknown,
  operation: RetrievalOperationContext,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted || operation.signal.aborted || operation.remainingMs() <= 0) {
    disposeResponseBody(body);
    throw createAbortError();
  }
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    ensureDiscoverySize(Buffer.byteLength(body));
    return body;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    ensureDiscoverySize(body.byteLength);
    return Buffer.from(body).toString('utf8');
  }
  if (!isAsyncIterable(body)) {
    throw new RetrievalError({ code: 'invalid_request', message: 'DOI response body is not supported', provider: 'direct' });
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      if (signal.aborted || operation.signal.aborted || operation.remainingMs() <= 0) throw createAbortError();
      const next = await awaitWithAbort(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      const chunk = next.value;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
      total += buffer.byteLength;
      ensureDiscoverySize(total, body);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    disposeResponseBody(body);
    try {
      const closing = iterator.return?.();
      if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(closing).catch(() => undefined);
      }
    } catch {
      // Keep the bounded discovery result/error while releasing the body.
    }
  }
}

function ensureDiscoverySize(size: number, body?: unknown): void {
  if (size <= MAX_DISCOVERY_RESPONSE_BYTES) return;
  disposeResponseBody(body);
  throw new RetrievalError({
    code: 'response_too_large',
    message: 'DOI response exceeds the allowed size',
    provider: 'direct'
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isIPLiteral(hostname: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':');
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw createAbortError();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

type PaidFallbackPlan = {
  readonly strategy: 'static' | 'browser';
  readonly proxyType: 'datacenter' | 'residential';
};

function paidFallbackPlans(status: PublicAccessDiscoveryService['getProcessStatus'] extends () => infer T ? T : never): readonly PaidFallbackPlan[] {
  if (!status.enabled) return [];
  const configuredProxyTypes = status.availableProxyTypes || ['datacenter'];
  const proxyTypes = configuredProxyTypes.filter(proxyType => proxyType === 'datacenter' || (
    proxyType === 'residential' && status.residentialAllowed === true
  ));
  const plans: PaidFallbackPlan[] = [];
  for (const proxyType of ['datacenter', 'residential'] as const) {
    if (!proxyTypes.includes(proxyType)) continue;
    plans.push({ strategy: 'static', proxyType });
    if (status.browserAllowed) plans.push({ strategy: 'browser', proxyType });
  }
  return plans;
}

function fallbackDiagnostics(observations: readonly FallbackObservation[]): {
  fallback: AccessDiscoveryStatus['fallback'];
} {
  const paid = observations.filter(observation => observation.phase === 'paid');
  const lastPaid = paid[paid.length - 1];
  return {
    fallback: {
      attempted: paid.length > 0,
      combinationsAttempted: paid.length,
      ...(lastPaid?.failure ? { reason: lastPaid.failure.reason } : {})
    }
  };
}

function isDirectRecoverableFailure(error: unknown): boolean {
  return error instanceof RetrievalError
    && error.targetStatus !== 429
    && ['network', 'server_error', 'timeout', 'target_unavailable', 'provider_error', 'detected', 'concurrency_limited'].includes(error.code);
}

function isNonSwitchableDirectFailure(error: unknown): boolean {
  return error instanceof RetrievalError && [
    'invalid_request',
    'auth_or_credits_unknown',
    'budget',
    'security',
    'response_too_large',
    'document_limit'
  ].includes(error.code);
}

function isNonSwitchablePaidFailure(error: unknown, operation: RetrievalOperationContext): boolean {
  if (operation.cost.snapshot().paidClosed) return true;
  if (!(error instanceof RetrievalError)) return false;
  if (error.targetStatus === 429) return true;
  if ([
    'invalid_request',
    'auth_or_credits_unknown',
    'budget',
    'security',
    'response_too_large',
    'document_limit'
  ].includes(error.code)) return true;
  return operation.cost.snapshot().paidClosed && [
    'provider_error',
    'target_unavailable',
    'concurrency_limited',
    'server_error'
  ].includes(error.code);
}

function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  if (error instanceof SensitiveOutboundTargetError || error instanceof RetrievalError && error.code === 'security') {
    return {
      kind: 'restricted',
      reason: 'restricted_target',
      ...(error instanceof RetrievalError && error.apiStatus === undefined ? {} : { apiStatus: error instanceof RetrievalError ? error.apiStatus : undefined }),
      ...(error instanceof RetrievalError && error.targetStatus === undefined ? {} : { targetStatus: error instanceof RetrievalError ? error.targetStatus : undefined })
    };
  }
  if (error instanceof RetrievalError) {
    const details = {
      ...(error.apiStatus === undefined ? {} : { apiStatus: error.apiStatus }),
      ...(error.targetStatus === undefined ? {} : { targetStatus: error.targetStatus })
    };
    if (error.targetStatus === 429) return { kind: 'failed', reason: 'target_rate_limited', ...details };
    if (error.code === 'auth_or_credits_unknown') return { kind: 'provider', reason: 'provider_auth_or_credits', ...details };
    if (error.code === 'budget') return { kind: 'provider', reason: 'paid_budget_unavailable', ...details };
    if (error.code === 'configuration' || error.code === 'cancelled' || error.code === 'timeout') {
      return { kind: 'fallback', reason: 'provider_unavailable', ...details };
    }
    if (error.code === 'target_unavailable') return { kind: 'failed', reason: 'target_unavailable', ...details };
    if (error.code === 'response_too_large' || error.code === 'document_limit') {
      return { kind: 'failed', reason: error.code, ...details };
    }
    return { kind: 'failed', reason: 'provider_failed', ...details };
  }
  return { kind: 'failed', reason: 'provider_failed' };
}

function knownCost(response: RetrievalResponse): Record<string, number> {
  return response.cost.known ? { creditsCost: response.cost.credits } : {};
}

function strategyScopeSuffix(strategy?: PublicAccessDiscoveryStrategy): string {
  if (!strategy) return '';
  return `:${strategy.strategy}:${strategy.proxyType || 'datacenter'}`;
}

function isRestrictedDiscoveryTarget(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (labels.some(label => /^(?:login|signin|sign-in|auth|sso|mfa|idp|account|institution|institutional)$/.test(label))) return true;
  if (/(?:^|\.)\b(?:clarivate|webofscience)\.com$/.test(hostname)) return true;
  if (url.pathname.split('/').some(segment => /^(?:login|signin|sign-in|auth|sso|saml|oauth|authorize|authorization|mfa|account|institution|institutional-access)$/i.test(segment))) return true;
  return [...url.searchParams.keys()].some(key => /^(?:login|signin|sign-in|auth|sso|saml|oauth|authorize|authorization|mfa|account|institutional-access)$/i.test(key));
}

export default PublicAccessDiscovery;
