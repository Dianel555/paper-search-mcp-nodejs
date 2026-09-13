import * as cheerio from 'cheerio';
import { Paper } from '../models/Paper.js';
import { CapabilityUnavailableError } from '../utils/CapabilityErrors.js';
import { sanitizeDoi, withTimeout } from '../utils/SecurityUtils.js';
import {
  disposeResponseBody,
  isPublicAddress,
  validatePublicHttpUrl,
  type PublicUrlValidation
} from '../utils/PublicNetwork.js';
import { PublicHttpClient, type PublicHttpRequester } from './PublicHttpClient.js';
import { PdfAccessVerifier, type PdfVerificationResult } from './PdfAccessVerifier.js';
import { hasSensitiveCandidateCredentials, OutboundSecurityError, OutboundSecurityPolicy, SensitiveOutboundTargetError } from '../retrieval/OutboundSecurityPolicy.js';
import { isValidAccessDiscoveryMaxItems, parseRetrievalConfiguration, type RetrievalConfiguration } from '../retrieval/Configuration.js';
import { createRetrievalService } from '../retrieval/createRetrievalService.js';
import {
  RetrievalError,
  type AccessArtifact,
  type DocumentProvenance,
  type FiniteDocument,
  type RetrievalOperationContext,
  type RetrievalProvider,
  type RetrievalResponse
} from '../retrieval/types.js';
import { TIMEOUTS } from '../config/constants.js';
import { createConcurrencyLimiter } from '../utils/ConcurrencyLimiter.js';

const DISCOVERY_TIMEOUT_MS = TIMEOUTS.EXTENDED;
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
  /** Known provider-reported cost only; unknown cost is never guessed. */
  readonly creditsCost?: number;
  readonly fetchedAt: string;
}

export interface PublicAccessDiscoveryRunOptions {
  readonly verifyPdf?: boolean;
  readonly maxItems?: number;
  /** Internal operation supplied by the MCP/platform composition boundary. */
  readonly operation?: RetrievalOperationContext;
}

export interface PublicAccessDiscoveryService {
  createOperation(options?: { signal?: AbortSignal; timeoutMs?: number }): RetrievalOperationContext & { dispose?: () => void };
  retrieveWithRetry(
    request: {
      readonly url: string;
      readonly purpose: 'publisher_discovery';
      readonly strategy: 'direct' | 'static' | 'browser';
      readonly documentFormat: 'html' | 'html_with_iframes';
      readonly signal?: AbortSignal;
    },
    context?: RetrievalOperationContext,
    options?: {
      readonly strategyScopeId?: string;
      readonly shouldRetryResponse?: (response: RetrievalResponse) => boolean | Promise<boolean>;
    }
  ): Promise<RetrievalResponse>;
  getProcessStatus(): {
    readonly enabled: boolean;
    readonly browserAllowed: boolean;
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
}

interface CandidateRecord {
  readonly artifact: AccessArtifact;
  readonly raw: string;
  readonly validSyntax: boolean;
}

interface CandidateEvaluation {
  readonly artifact?: AccessArtifact;
  readonly verification?: AccessDiscoveryVerification;
  readonly candidateCount: number;
  readonly candidatesTruncated: boolean;
}

interface PageClassification {
  readonly kind: 'candidate' | 'restricted' | 'not_found' | 'dynamic' | 'clean' | 'candidate_limit' | 'failed' | 'unknown';
  readonly candidate?: CandidateEvaluation;
  readonly targetStatus?: number;
}

interface ProviderFailureClassification {
  readonly kind: 'restricted' | 'provider' | 'fallback' | 'failed';
  readonly reason: string;
}

interface DiscoveryOutcome {
  readonly status: AccessDiscoveryStatus;
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

  constructor(
    serviceOrLegacyScraper?: PublicAccessDiscoveryService,
    options: PublicAccessDiscoveryOptions = {}
  ) {
    const configuration = options.configuration || parseRetrievalConfiguration();
    this.defaultMaxItems = configuration.accessDiscoveryMaxItems;
    this.discoveryTimeoutMs = Number.isFinite(options.discoveryTimeoutMs) && (options.discoveryTimeoutMs || 0) > 0
      ? Math.min(options.discoveryTimeoutMs as number, DISCOVERY_TIMEOUT_MS)
      : DISCOVERY_TIMEOUT_MS;
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
    this.pdfVerifier = new PdfAccessVerifier({ publicHttpClient: this.publicHttpClient });

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
      timeoutMs: this.discoveryTimeoutMs
    });
    const operation = options.operation || ownedOperation!;
    const enrichmentLimiter = createConcurrencyLimiter(3);
    const scopedOptions = options.operation ? options : { ...options, operation };
    try {
      return await Promise.all(papers.map((paper, index) => index < limit
        ? enrichmentLimiter(() => this.enrichOne(paper, scopedOptions, index), operation.signal)
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
    options: PublicAccessDiscoveryRunOptions,
    itemIndex: number
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
        timeoutMs: this.discoveryTimeoutMs
      })
      : undefined;
    const operation = options.operation || ownedOperation!;
    const itemController = new AbortController();
    const relayAbort = () => itemController.abort();
    if (operation.signal.aborted) itemController.abort();
    else operation.signal.addEventListener('abort', relayAbort, { once: true });
    let outcome: DiscoveryOutcome | undefined;
    try {
      outcome = await withTimeout(
        this.discoverPaper(doiResult.sanitized, operation, options.verifyPdf === true, itemController.signal, `doi-${itemIndex}`),
        Math.min(this.discoveryTimeoutMs, Math.max(1, operation.remainingMs())),
        'Public access discovery timed out',
        () => itemController.abort()
      );
    } catch (error) {
      const status = error instanceof OutboundSecurityError
        ? this.status('restricted', { reason: 'restricted_target' })
        : error instanceof CapabilityUnavailableError
          ? this.status('skipped', { reason: 'provider_unavailable' })
          : error instanceof RetrievalError && error.code === 'security'
            ? this.status('restricted', { reason: 'restricted_target' })
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
    strategyScopeId: string
  ): Promise<DiscoveryOutcome> {
    const landing = await this.resolveDoi(doi, signal);
    const landingUrl = landing.finalUrl;
    await this.validateDiscoveryUrl(landingUrl, signal);
    const landingHost = new URL(landingUrl).hostname;
    const baseStatus = { landingUrl, landingHost };

    let directResponse: RetrievalResponse;
    try {
      directResponse = await this.retrievalService.retrieveWithRetry({
        url: landingUrl,
        purpose: 'publisher_discovery',
        strategy: 'direct',
        documentFormat: 'html_with_iframes',
        signal
      }, operation, {
        strategyScopeId,
        shouldRetryResponse: shouldRetryDirectResponse
      });
    } catch (error) {
      const failure = classifyProviderFailure(error);
      if (failure.kind === 'restricted') {
        return this.outcome(this.status('restricted', { ...baseStatus, reason: failure.reason }));
      }
      if (isTerminalDiscoveryFailure(error) || signal.aborted || operation.signal.aborted || !this.canUsePaidFallback()) {
        const directFailure = error instanceof RetrievalError && ['network', 'server_error', 'timeout'].includes(error.code);
        return this.outcome(this.status('failed', {
          ...baseStatus,
          reason: directFailure ? 'direct_failed' : failure.reason,
          ...(error instanceof RetrievalError && error.targetStatus !== undefined
            ? { targetStatus: error.targetStatus }
            : {})
        }));
      }
      return this.tryPaidStrategies(landingUrl, operation, verifyPdf, baseStatus, true, signal, strategyScopeId);
    }

    const directPage = await this.classifyPage(directResponse, landingUrl, signal, verifyPdf);
    if (directPage.kind === 'restricted') {
      return this.outcome(this.status('restricted', {
        ...baseStatus,
        reason: 'restricted_page',
        ...this.pageDetails(directResponse, directPage)
      }));
    }
    if (directPage.kind === 'not_found') {
      return this.outcome(this.status('not_found', {
        ...baseStatus,
        reason: 'target_not_found',
        ...this.pageDetails(directResponse, directPage)
      }));
    }
    if (directPage.kind === 'candidate_limit') {
      return this.outcome(this.status('skipped', {
        ...baseStatus,
        reason: 'candidate_limit',
        ...this.pageDetails(directResponse, directPage)
      }));
    }
    if (directPage.kind === 'candidate') {
      return this.applyCandidate(directResponse, directPage.candidate!, baseStatus);
    }

    const targetStatusBlocksFallback = directPage.kind === 'failed'
      && directPage.targetStatus !== undefined
      && directPage.targetStatus < 500;
    const needsPaidFallback = !targetStatusBlocksFallback
      && (directPage.kind === 'dynamic' || directPage.kind === 'failed');
    if (!needsPaidFallback || !this.canUsePaidFallback()) {
      const dynamicUnresolved = directPage.kind === 'dynamic';
      return this.outcome(this.status(
        directPage.kind === 'failed' ? 'failed' : dynamicUnresolved ? 'not_found' : needsPaidFallback ? 'skipped' : directPage.kind === 'unknown' ? 'failed' : 'not_found',
        {
          ...baseStatus,
          reason: directPage.kind === 'failed'
            ? 'direct_failed'
            : dynamicUnresolved ? 'dynamic_unresolved'
              : needsPaidFallback ? 'provider_unavailable'
                : directPage.kind === 'unknown' ? 'target_status_unknown' : 'no_candidate',
          ...this.pageDetails(directResponse, directPage)
        }
      ));
    }

    return this.tryPaidStrategies(landingUrl, operation, verifyPdf, baseStatus, false, signal, strategyScopeId);
  }

  private async tryPaidStrategies(
    landingUrl: string,
    operation: RetrievalOperationContext,
    verifyPdf: boolean,
    baseStatus: { readonly landingUrl: string; readonly landingHost: string },
    directFailed: boolean,
    signal: AbortSignal,
    strategyScopeId: string
  ): Promise<DiscoveryOutcome> {
    const staticRequest = {
      url: landingUrl,
      purpose: 'publisher_discovery' as const,
      strategy: 'static' as const,
      documentFormat: 'html_with_iframes' as const,
      signal
    };
    let staticResponse: RetrievalResponse;
    try {
      staticResponse = await this.retrievalService.retrieveWithRetry(staticRequest, operation, { strategyScopeId });
    } catch (error) {
      const failure = classifyProviderFailure(error);
      const preserveDynamicEvidence = !directFailed && failure.kind === 'fallback';
      return this.outcome(this.status(
        failure.kind === 'restricted' ? 'restricted' : preserveDynamicEvidence ? 'not_found' : failure.kind === 'failed' ? 'failed' : 'skipped',
        { ...baseStatus, reason: preserveDynamicEvidence ? 'dynamic_unresolved' : failure.reason }
      ));
    }

    const staticPage = await this.classifyPage(staticResponse, landingUrl, signal, verifyPdf);
    if (staticPage.kind === 'restricted') {
      return this.outcome(this.status('restricted', {
        ...baseStatus,
        reason: 'restricted_page',
        ...this.pageDetails(staticResponse, staticPage)
      }));
    }
    if (staticPage.kind === 'not_found') {
      return this.outcome(this.status('not_found', {
        ...baseStatus,
        reason: 'target_not_found',
        ...this.pageDetails(staticResponse, staticPage)
      }));
    }
    if (staticPage.kind === 'candidate_limit') {
      return this.outcome(this.status('skipped', {
        ...baseStatus,
        reason: 'candidate_limit',
        ...this.pageDetails(staticResponse, staticPage)
      }));
    }
    if (staticPage.kind === 'candidate') {
      return this.applyCandidate(staticResponse, staticPage.candidate!, baseStatus);
    }

    if (staticPage.kind === 'dynamic' && this.canUseBrowserFallback()) {
      let browserResponse: RetrievalResponse;
      try {
        browserResponse = await this.retrievalService.retrieveWithRetry({
          ...staticRequest,
          strategy: 'browser'
        }, operation, { strategyScopeId });
      } catch (error) {
        const failure = classifyProviderFailure(error);
        return this.outcome(this.status(
          failure.kind === 'restricted' ? 'restricted' : failure.kind === 'failed' ? 'failed' : 'skipped',
          {
            ...baseStatus,
            reason: failure.reason,
            ...this.pageDetails(staticResponse, staticPage)
          }
        ));
      }
      const browserPage = await this.classifyPage(browserResponse, landingUrl, signal, verifyPdf);
      if (browserPage.kind === 'restricted') {
        return this.outcome(this.status('restricted', {
          ...baseStatus,
          reason: 'restricted_page',
          ...this.pageDetails(browserResponse, browserPage)
        }));
      }
      if (browserPage.kind === 'not_found') {
        return this.outcome(this.status('not_found', {
          ...baseStatus,
          reason: 'target_not_found',
          ...this.pageDetails(browserResponse, browserPage)
        }));
      }
      if (browserPage.kind === 'candidate') {
        return this.applyCandidate(browserResponse, browserPage.candidate!, baseStatus);
      }
      if (browserPage.kind === 'candidate_limit') {
        return this.outcome(this.status('skipped', {
          ...baseStatus,
          reason: 'candidate_limit',
          ...this.pageDetails(browserResponse, browserPage)
        }));
      }
      return this.outcome(this.status(
        browserPage.kind === 'unknown' || browserPage.kind === 'failed' ? 'failed' : 'not_found',
        {
          ...baseStatus,
          reason: browserPage.kind === 'unknown' ? 'target_status_unknown' : browserPage.kind === 'failed' ? 'target_server_error' : 'no_candidate',
          ...this.pageDetails(browserResponse, browserPage)
        }
      ));
    }

    return this.outcome(this.status(
      staticPage.kind === 'unknown' || staticPage.kind === 'failed' || directFailed ? 'failed' : 'not_found',
      {
        ...baseStatus,
        reason: staticPage.kind === 'unknown' ? 'target_status_unknown' : staticPage.kind === 'failed' ? 'target_server_error' : staticPage.kind === 'dynamic' ? 'dynamic_unresolved' : directFailed ? 'direct_failed' : 'no_candidate',
        ...this.pageDetails(staticResponse, staticPage)
      }
    ));
  }

  private async classifyPage(
    response: RetrievalResponse,
    landingUrl: string,
    signal: AbortSignal,
    verifyPdf: boolean
  ): Promise<PageClassification> {
    const document = response.document;
    const targetStatus = response.targetStatus ?? document?.targetStatus;
    if (targetStatus === 401 || targetStatus === 403 || targetStatus === 407 || targetStatus === 429 || targetStatus === 423) {
      return { kind: 'restricted', targetStatus };
    }
    const pageText = document ? documentText(document) : '';
    const pageMarkup = document
      ? [document.html, ...document.iframes.map(frame => frame.html)].join(' ')
      : '';
    if (document && isRestrictedPage(pageText, pageMarkup)) return { kind: 'restricted', targetStatus };
    if (targetStatus === 404 || targetStatus === 410) return { kind: 'not_found', targetStatus };
    if (!document) return { kind: targetStatus !== undefined && targetStatus >= 500 ? 'failed' : 'unknown', targetStatus };
    if (targetStatus !== undefined && (targetStatus < 200 || targetStatus >= 300)) {
      return { kind: 'failed', targetStatus };
    }
    if (targetStatus !== undefined && targetStatus >= 200 && targetStatus < 300 && isExplicitlyNotFound(pageText)) {
      return { kind: 'not_found', targetStatus };
    }

    const candidate = await this.findCandidate(document, signal, verifyPdf);
    if (candidate.artifact) return { kind: 'candidate', candidate, targetStatus };
    if (candidate.candidatesTruncated) return { kind: 'candidate_limit', candidate, targetStatus };
    // Missing target status is deliberately inconclusive even when the body
    // contains a dynamic marker; it must not authorize browser escalation.
    if (signal.aborted) throw createAbortError();
    if (targetStatus === undefined) return { kind: 'unknown', candidate, targetStatus };
    if (targetStatus >= 200 && targetStatus < 300 && await this.hasApprovedDynamicShape(document, signal)) {
      return { kind: 'dynamic', candidate, targetStatus };
    }
    return { kind: 'clean', candidate, targetStatus };
  }

  private async findCandidate(
    document: FiniteDocument,
    signal: AbortSignal,
    verifyPdf: boolean
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

    if (!firstSafe || !verifyPdf) {
      return {
        artifact: firstSafe,
        candidateCount: records.length,
        candidatesTruncated
      };
    }

    const verification = await this.pdfVerifier.verify(firstSafe.url, signal);
    if (signal.aborted) throw createAbortError();
    return {
      artifact: firstSafe,
      verification,
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
    const verification = evaluation.verification;
    return this.outcome(this.status(verification?.status === 'verified' ? 'pdf_verified' : 'oa_candidate', {
      ...baseStatus,
      candidateUrl: artifact.url,
      method: artifact.method,
      evidence: artifact,
      candidatesTruncated: evaluation.candidatesTruncated,
      candidateCount: evaluation.candidateCount,
      provider: response.provider,
      strategy: response.strategy,
      ...knownCost(response),
      ...(verification ? { verification } : {}),
      ...this.pageDetails(response)
    }));
  }

  private async resolveDoi(doi: string, signal: AbortSignal) {
    const doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
    let response = await this.requestDoi(doiUrl, { method: 'HEAD' }, signal);
    if (response.response.status === 405 || response.response.status === 501) {
      disposeResponseBody(response.response.data);
      response = await this.requestDoi(doiUrl, {
        method: 'GET',
        responseType: 'stream'
      }, signal);
    }
    disposeResponseBody(response.response.data);
    if (response.response.status < 200 || response.response.status >= 300) {
      throw new RetrievalError({
        code: 'target_unavailable',
        message: 'DOI resolution failed',
        targetStatus: response.response.status
      });
    }
    return response;
  }

  private async requestDoi(url: string, config: Record<string, unknown>, parentSignal: AbortSignal) {
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', relayAbort, { once: true });

    try {
      return await withTimeout(
        this.publicHttpClient.request(url, {
          ...config,
          timeout: Math.min(TIMEOUTS.DEFAULT, Math.max(1, DISCOVERY_TIMEOUT_MS)),
          signal: controller.signal
        }),
        TIMEOUTS.DEFAULT,
        'DOI resolution timed out',
        () => controller.abort()
      );
    } finally {
      parentSignal.removeEventListener('abort', relayAbort);
      controller.abort();
    }
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

function isRestrictedPage(text: string, markup?: string): boolean {
  const source = markup ? restrictedContentText(markup) : text;
  return /(?:subscription\s+required|institutional\s+(?:access|login)|access\s+denied|paywall|purchase\s+(?:access|article)|full\s*text\s+(?:is\s+)?(?:unavailable|restricted)|captcha|cloudflare|just\s+a\s+moment|checking\s+your\s+browser|verify\s+you\s+are\s+human|please\s+wait)/i.test(source)
    || /(?:please|you\s+must|must)\s+(?:sign|log)\s*in\b|(?:sign|log)\s*in\s+(?:to\s+(?:access|continue|view)|is\s+required|required)|(?:full\s*text|article|access)\s+(?:requires?|needs?)\s+(?:a\s+)?(?:sign\s*in|log\s*in|login)/i.test(source);
}

function restrictedContentText(markup: string): string {
  const $ = cheerio.load(markup || '');
  const root = $.root();
  root.find('nav, header, footer, [role="navigation"]').remove();
  return `${root.text()} ${root.html() || ''}`;
}

function shouldRetryDirectResponse(response: RetrievalResponse): boolean {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  if (targetStatus === undefined || targetStatus < 500) return false;
  const document = response.document;
  if (!document) return true;
  const markup = [document.html, ...document.iframes.map(frame => frame.html)].join(' ');
  return !isRestrictedPage(documentText(document), markup);
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

function classifyProviderFailure(error: unknown): ProviderFailureClassification {
  if (error instanceof SensitiveOutboundTargetError || error instanceof RetrievalError && error.code === 'security') {
    return { kind: 'restricted', reason: 'restricted_target' };
  }
  if (error instanceof RetrievalError) {
    if (error.code === 'auth_or_credits_unknown') return { kind: 'provider', reason: 'provider_auth_or_credits' };
    if (error.code === 'budget') return { kind: 'provider', reason: 'paid_budget_unavailable' };
    if (error.code === 'configuration' || error.code === 'cancelled' || error.code === 'timeout') {
      return { kind: 'fallback', reason: 'provider_unavailable' };
    }
    if (error.code === 'target_unavailable') return { kind: 'failed', reason: 'target_unavailable' };
    if (error.code === 'response_too_large' || error.code === 'document_limit') {
      return { kind: 'failed', reason: error.code };
    }
    return { kind: 'failed', reason: 'provider_failed' };
  }
  return { kind: 'failed', reason: 'provider_failed' };
}

function isTerminalDiscoveryFailure(error: unknown): boolean {
  return error instanceof RetrievalError && [
    'invalid_request',
    'auth_or_credits_unknown',
    'target_unavailable',
    'concurrency_limited',
    'detected',
    'response_too_large',
    'document_limit',
    'provider_error',
    'security'
  ].includes(error.code);
}

function knownCost(response: RetrievalResponse): Record<string, number> {
  return response.cost.known ? { creditsCost: response.cost.credits } : {};
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
