/**
 * Controlled Sci-Hub HTML adapter.
 *
 * This integration is disabled by default, discovers bounded mirror lists from
 * configured directory pages, and never treats an HTML mirror as an official API.
 */

import * as cheerio from 'cheerio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createConcurrencyLimiter } from '../utils/ConcurrencyLimiter.js';
import { PaperSource, type SearchOptions, type DownloadOptions, type PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { CapabilityUnavailableError } from '../utils/CapabilityErrors.js';
import { sanitizeDoi, sanitizeDownloadPath, sanitizeFilename } from '../utils/SecurityUtils.js';
import { TIMEOUTS } from '../config/constants.js';
import { disposeResponseBody, getHeaderValue, isPublicAddress, validatePublicHttpUrl, type PublicUrlValidation } from '../utils/PublicNetwork.js';
import { PublicHttpClient as ControlledPublicHttpClient, type PublicHttpResponse } from '../services/PublicHttpClient.js';
import { toRetrievalError } from '../services/ScrapingAntFetcher.js';
import { type RetrievalOperationOptions, type RetrievalStrategyStep } from '../retrieval/RetrievalService.js';
import { createRetrievalService } from '../retrieval/createRetrievalService.js';
import { hasSensitiveCandidateCredentials, OutboundSecurityPolicy, SensitiveOutboundTargetError } from '../retrieval/OutboundSecurityPolicy.js';
import {
  RetrievalError,
  type DocumentProvenance,
  type RetrievalOperationContext,
  type RetrievalProvider,
  type RetrievalRequest,
  type RetrievalResponse
} from '../retrieval/types.js';
import { logDebug, logWarn } from '../utils/Logger.js';

export type SciHubLookupStatus =
  | 'not_found'
  | 'blocked'
  | 'mirror_unhealthy'
  | 'markup_changed'
  | 'transport_error'
  | 'working'
  | 'not_checked'
  | 'disabled';

export interface MirrorSite {
  url: string;
  lastChecked?: Date;
  responseTime?: number;
  status: SciHubLookupStatus;
  failureCount: number;
}

export interface SciHubPublicHttpRequester {
  request<T = unknown>(url: string, config?: any): Promise<PublicHttpResponse<T>>;
}

export interface SciHubFallbackFetcher {
  isConfigured(): boolean;
  fetch(url: string, options?: Record<string, unknown>): Promise<{
    html: string;
    iframes?: Array<{ src: string; html?: string }>;
    apiStatus?: number;
    pageStatus?: number;
    creditsCost?: number;
  }>;
}

export interface SciHubRetrievalService {
  createOperation(options?: RetrievalOperationOptions): RetrievalOperationContext & { dispose?: () => void };
  retrieveWithStrategies(
    steps: readonly RetrievalStrategyStep[],
    context?: RetrievalOperationContext,
    options?: { maxPaidStrategySelections?: number; maxBrowserDispatches?: number }
  ): Promise<RetrievalResponse>;
  getProcessStatus(): { enabled: boolean; browserAllowed: boolean };
}

export interface SciHubSearcherOptions {
  enabled?: boolean;
  fetchMode?: 'direct' | 'fallback';
  mirrors?: string[];
  healthCheckConcurrency?: number;
  publicHttpClient?: SciHubPublicHttpRequester;
  /** Isolated health probe seam; supplying it does not select the legacy path. */
  healthHttpClient?: SciHubPublicHttpRequester;
  /** Isolated mirror-directory discovery seam for deterministic tests. */
  mirrorDiscoveryHttpClient?: SciHubPublicHttpRequester;
  downloadHttpClient?: SciHubPublicHttpRequester;
  scrapingAntFetcher?: SciHubFallbackFetcher;
  retrievalService?: SciHubRetrievalService;
  /** Internal composition seam for deterministic security-policy tests. */
  securityPolicy?: OutboundSecurityPolicy;
  directProvider?: RetrievalProvider;
  scrapingAntProvider?: RetrievalProvider;
  validateUrl?: (url: string) => Promise<PublicUrlValidation>;
}

interface LookupOutcome {
  status: SciHubLookupStatus;
  paper?: Paper;
  landingUrl: string;
  dynamic: boolean;
  /** Provider/account/operation failures must not poison mirror health. */
  mirrorFailure?: boolean;
  /** Security and bounded-resource failures terminate this lookup chain. */
  terminal?: boolean;
}

/**
 * Compatibility adapter only: RetrievalService owns admission, cancellation,
 * retry and settlement; the legacy fetcher performs one transport call.
 */
class LegacySciHubFallbackProvider implements RetrievalProvider {
  readonly name = 'scrapingant';
  readonly capabilities = {
    html: true,
    iframeDocuments: true,
    pdfCandidates: true,
    browser: true,
    paid: true,
    proxyTypes: ['datacenter'],
    combinations: ['static:datacenter', 'browser:datacenter']
  } as const;

  constructor(private readonly fetcher: SciHubFallbackFetcher) {}

  async retrieve(request: RetrievalRequest, context: RetrievalOperationContext): Promise<RetrievalResponse> {
    if (request.strategy !== 'static' && request.strategy !== 'browser') {
      throw new RetrievalError({
        code: 'invalid_request',
        message: 'The compatibility provider only supports paid Sci-Hub retrieval',
        provider: this.name
      });
    }
    if ((request.proxyType ?? 'datacenter') !== 'datacenter') {
      throw new RetrievalError({
        code: 'configuration',
        message: 'The legacy Sci-Hub provider does not support residential retrieval',
        provider: this.name
      });
    }

    let result: Awaited<ReturnType<SciHubFallbackFetcher['fetch']>>;
    try {
      result = await this.fetcher.fetch(request.url, {
        endpoint: 'extended',
        browser: request.strategy === 'browser',
        proxyType: 'datacenter',
        signal: context.signal,
        singleAttempt: true,
        ...(request.strategy === 'browser'
          ? { waitForSelector: '#pdf, embed[type="application/pdf"]' }
          : {})
      });
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      throw toRetrievalError(error);
    }
    // API success is not target success; preserve unknown target status so
    // browser eligibility cannot be inferred from provider transport status.
    const targetStatus = result.pageStatus;
    const frames = (result.iframes || []).flatMap(frame => {
      // The compatibility contract does not guarantee an iframe final URL;
      // retain bounded HTML for restriction evidence, but never turn a
      // provider-relative value into a guessed remote source.
      let safeSrc = '';
      if (/^https?:\/\//i.test(frame.src)) {
        try {
          const parsed = new URL(frame.src);
          if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
            safeSrc = parsed.toString();
          }
        } catch {
          // Keep the HTML while excluding an unusable source value.
        }
      }
      return [{
        src: safeSrc,
        html: frame.html || '',
        source: { provenance: 'unknown_remote' as const, submittedUrl: request.url }
      }];
    });
    const credits = result.creditsCost;
    return {
      provider: this.name,
      strategy: request.strategy,
      apiStatus: result.apiStatus,
      targetStatus,
      document: {
        kind: 'html',
        html: result.html || '',
        iframes: frames,
        source: { provenance: 'unknown_remote', submittedUrl: request.url },
        targetStatus
      },
      cost: Number.isFinite(credits) && (credits as number) >= 0
        ? { known: true, credits: credits as number }
        : { known: false, credits: null, reason: 'compatibility fetcher did not report credits' }
    };
  }
}

interface HealthFlight {
  readonly id: number;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  readonly rejectDeadline: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  waiters: number;
  detached: boolean;
  timedOut: boolean;
}

interface MirrorDiscoveryResult {
  readonly sourceUrl: string;
  readonly mirrors: string[];
  readonly succeeded: boolean;
}

const MAX_CANDIDATES = 20;
const MAX_DISCOVERED_MIRRORS = 20;
const MIRROR_DIRECTORY_MAX_BYTES = 512 * 1024;

export const SCIHUB_MIRROR_DIRECTORY_URLS = [
  'https://sci-hub.mobi/en/mirrors',
  'https://www.ooopn.com/tool/scihub/'
] as const;

const MIRROR_DIRECTORY_PATTERN = /镜像|mirror/i;

export class SciHubSearcher extends PaperSource {
  private readonly mirrorSites: MirrorSite[];
  private readonly configuredMirrorUrls: string[];
  private readonly publicHttpClient: SciHubPublicHttpRequester;
  private readonly healthHttpClient: SciHubPublicHttpRequester;
  private readonly mirrorDiscoveryHttpClient: SciHubPublicHttpRequester;
  private readonly downloadHttpClient: SciHubPublicHttpRequester;
  private readonly retrievalService: SciHubRetrievalService;
  private readonly securityPolicy: OutboundSecurityPolicy;
  private readonly validateUrl: (url: string) => Promise<PublicUrlValidation>;
  private readonly healthCheckConcurrency: number;
  private readonly healthCheckInterval = 300000;
  private readonly healthCheckProducerTimeout = 120000;
  private readonly enabled: boolean;
  private readonly fetchMode: 'direct' | 'fallback';
  private lastHealthCheck: Date | null = null;
  private discoveredMirrorsBySource = new Map<string, string[]>();
  private healthFlight: HealthFlight | null = null;
  private healthFlightSequence = 0;
  private lastSuccessfulMirror?: string;
  /** Bounded domain-result cache for same-operation search→download reuse. */
  private readonly operationPdfCache = new WeakMap<object, Map<string, string>>();
  private lastLookupStatus: SciHubLookupStatus = 'not_checked';
  private complianceNoticeEmitted = false;

  constructor(options: SciHubSearcherOptions = {}) {
    super('scihub', SCIHUB_MIRROR_DIRECTORY_URLS[0]);
    this.enabled = options.enabled ?? isTruthy(process.env.SCIHUB_ENABLED);
    this.fetchMode = options.fetchMode || (process.env.SCIHUB_FETCH_MODE === 'direct' ? 'direct' : 'fallback');
    this.healthCheckConcurrency = options.healthCheckConcurrency ?? readPositiveInteger(process.env.SCIHUB_HEALTHCHECK_CONCURRENCY, 3);
    this.publicHttpClient = options.publicHttpClient || new ControlledPublicHttpClient({ purpose: 'scihub_lookup' });
    this.healthHttpClient = options.healthHttpClient || this.publicHttpClient;
    this.mirrorDiscoveryHttpClient = options.mirrorDiscoveryHttpClient || this.publicHttpClient;
    this.downloadHttpClient = options.downloadHttpClient || this.publicHttpClient;
    this.validateUrl = options.validateUrl || ((url: string) => validatePublicHttpUrl(url));
    this.securityPolicy = options.securityPolicy || new OutboundSecurityPolicy({
      validatePublicUrl: this.validateUrl
    });
    const legacyFallbackProvider = options.scrapingAntFetcher
      ? new LegacySciHubFallbackProvider(options.scrapingAntFetcher)
      : undefined;
    this.retrievalService = options.retrievalService || createRetrievalService({
      directClient: this.publicHttpClient,
      directProvider: options.directProvider,
      scrapingAntProvider: options.scrapingAntProvider || legacyFallbackProvider,
      securityPolicy: this.securityPolicy
    });

    const configuredMirrorValues = options.mirrors
      ?? (process.env.SCIHUB_MIRRORS || '').split(',');
    this.configuredMirrorUrls = [...new Set(configuredMirrorValues
      .flatMap(value => value.split(','))
      .map(value => normalizeMirror(value))
      .filter((value): value is string => Boolean(value)))];
    this.mirrorSites = this.configuredMirrorUrls.map(url => ({
      url,
      status: this.enabled ? 'not_checked' : 'disabled',
      failureCount: 0
    }));
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: this.enabled,
      download: this.enabled,
      fullText: false,
      citations: false,
      requiresApiKey: false,
      supportedOptions: ['maxResults']
    };
  }

  async search(query: string, options?: SearchOptions): Promise<Paper[]> {
    this.requireEnabled();
    const doi = normalizeSciHubInput(query);
    const paper = await this.fetchPaperInfo(doi, options?.operationContext);
    return paper ? [paper] : [];
  }

  async getPaperByDoi(doi: string, options?: SearchOptions): Promise<Paper | null> {
    this.requireEnabled();
    return this.fetchPaperInfo(normalizeSciHubInput(doi), options?.operationContext);
  }

  async downloadPdf(paperId: string, options?: DownloadOptions): Promise<string> {
    this.requireEnabled();
    const suppliedOperation = options?.operationContext;
    const ownedOperation = suppliedOperation ? undefined : this.retrievalService.createOperation({ purpose: 'scihub_lookup' });
    const operation = suppliedOperation || ownedOperation!;
    try {
      return await this.downloadPdfWithOperation(paperId, options, operation);
    } finally {
      ownedOperation?.dispose?.();
    }
  }

  private async downloadPdfWithOperation(
    paperId: string,
    options: DownloadOptions | undefined,
    operation: RetrievalOperationContext
  ): Promise<string> {
    throwIfOperationUnavailable(operation);
    const doi = normalizeSciHubInput(paperId);
    const pathResult = sanitizeDownloadPath(options?.savePath, './downloads');
    if (!pathResult.valid) throw new Error(pathResult.error || 'Invalid save path');

    const saveDirectory = pathResult.sanitized;
    await fs.promises.mkdir(saveDirectory, { recursive: true });
    throwIfOperationUnavailable(operation);
    const filePath = path.join(saveDirectory, `${sanitizeFilename(doi)}.pdf`);
    const existingBeforeDownload = await lstatIfPresent(filePath);
    if (existingBeforeDownload) {
      if (existingBeforeDownload.isSymbolicLink()) throw new Error('Refusing to overwrite a symbolic-link target');
      if (!existingBeforeDownload.isFile()) throw new Error('Refusing to overwrite a non-file destination');
      if (!options?.overwrite) {
        throwIfOperationUnavailable(operation);
        return filePath;
      }
    }

    const cachedPdf = this.operationPdfCache.get(operation as object)?.get(doi);
    const paper = cachedPdf ? { pdfUrl: cachedPdf } as Paper : await this.fetchPaperInfo(doi, operation);
    if (operation.signal.aborted || operation.remainingMs() <= 0) throwIfOperationUnavailable(operation);
    if (!paper?.pdfUrl) {
      throw new Error(`Cannot find a PDF for DOI (lookup status: ${this.lastLookupStatus})`);
    }
    throwIfOperationUnavailable(operation);

    try {
      await this.validateCandidateUrl(paper.pdfUrl, 'scihub_download', operation.signal);
    } catch (error) {
      if (operation.signal.aborted || isAbortError(error)) {
        throwIfOperationUnavailable(operation);
      }
      throw error;
    }
    throwIfOperationUnavailable(operation);
    let response: PublicHttpResponse;
    try {
      response = await awaitWithAbort(
        this.downloadHttpClient.request(paper.pdfUrl, {
          method: 'GET',
          responseType: 'stream',
          timeout: Math.min(TIMEOUTS.DOWNLOAD, operation.remainingMs()),
          signal: operation.signal
        }),
        operation.signal,
        lateResponse => disposeResponseBody(lateResponse.response.data)
      );
    } catch (error) {
      if (operation.signal.aborted || isAbortError(error)) {
        throwIfOperationUnavailable(operation);
      }
      throw error;
    }
    try {
      throwIfOperationUnavailable(operation);
    } catch (error) {
      disposeResponseBody(response.response.data);
      throw error;
    }
    if (response.response.status < 200 || response.response.status >= 300) {
      disposeResponseBody(response.response.data);
      throw new Error(`PDF download was blocked or failed with status ${response.response.status}`);
    }

    const contentType = getHeaderValue(response.response.headers, 'content-type');
    if (contentType && !/^application\/(pdf|octet-stream)(?:\s*;|$)/i.test(contentType)) {
      disposeResponseBody(response.response.data);
      throw new Error('PDF response has an unexpected MIME type');
    }
    const contentLength = Number(getHeaderValue(response.response.headers, 'content-length'));
    const maxBytes = readMaxFileSize();
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      disposeResponseBody(response.response.data);
      throw new Error('PDF exceeds the configured maximum file size');
    }

    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
      await writeValidatedPdf(response.response.data, temporaryPath, maxBytes, operation);
      throwIfOperationUnavailable(operation);
      const existingBeforePublication = await lstatIfPresent(filePath);
      if (existingBeforePublication) {
        if (existingBeforePublication.isSymbolicLink()) throw new Error('Refusing to overwrite a symbolic-link target');
        if (!existingBeforePublication.isFile()) throw new Error('Refusing to overwrite a non-file destination');
        throwIfOperationUnavailable(operation);
        if (!options?.overwrite) return filePath;
      }
      throwIfOperationUnavailable(operation);
      if (options?.overwrite) {
        // Replacement is only allowed when the caller explicitly opted in.
        // Cancellation after this atomic syscall begins cannot roll it back.
        await fs.promises.rename(temporaryPath, filePath);
      } else {
        try {
          // A hard link is atomic and fails with EEXIST instead of replacing a
          // destination that appeared after the existence check.
          await fs.promises.link(temporaryPath, filePath);
          await fs.promises.unlink(temporaryPath);
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error;
          const existing = await fs.promises.lstat(filePath);
          throwIfOperationUnavailable(operation);
          if (existing.isSymbolicLink()) throw new Error('Refusing to overwrite a symbolic-link target');
          if (!existing.isFile()) throw new Error('Refusing to overwrite a non-file destination');
          return filePath;
        }
      }
      return filePath;
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async readPaper(paperId: string, options?: DownloadOptions): Promise<string> {
    const filePath = await this.downloadPdf(paperId, options);
    return `PDF downloaded to: ${filePath}. Please use a PDF reader to view the content.`;
  }

  getMirrorStatus(): Array<{
    url: string;
    status: SciHubLookupStatus;
    responseTime?: number;
    failureCount: number;
    lastChecked?: string;
  }> {
    return this.mirrorSites.map(mirror => ({
      url: mirror.url,
      status: mirror.status,
      responseTime: mirror.responseTime,
      failureCount: mirror.failureCount,
      lastChecked: mirror.lastChecked?.toISOString()
    }));
  }

  async forceHealthCheck(signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return;
    await this.checkMirrorHealth(true, signal);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      fetchMode: this.fetchMode,
      lastLookupStatus: this.lastLookupStatus,
      lastSuccessfulMirror: this.lastSuccessfulMirror,
      healthCheckedAt: this.lastHealthCheck?.toISOString(),
      mirrors: this.getMirrorStatus(),
      scrapingAnt: this.retrievalService.getProcessStatus()
    };
  }

  consumeComplianceNotice(): string | undefined {
    if (!this.enabled || this.complianceNoticeEmitted) return undefined;
    this.complianceNoticeEmitted = true;
    return 'Compliance notice: use Sci-Hub only for public content or material you are legally authorized to access; this adapter does not grant access rights.';
  }

  private async fetchPaperInfo(doi: string, operationContext?: RetrievalOperationContext): Promise<Paper | null> {
    const suppliedOperation = operationContext;
    const ownedOperation = suppliedOperation ? undefined : this.retrievalService.createOperation({ purpose: 'scihub_lookup' });
    const operation = suppliedOperation || ownedOperation!;
    try {
      return await this.fetchPaperInfoWithRetrieval(doi, operation);
    } finally {
      ownedOperation?.dispose?.();
    }
  }

  private async fetchPaperInfoWithRetrieval(doi: string, operation: RetrievalOperationContext): Promise<Paper | null> {
    const mirrors = await this.getCandidateMirrors(operation.signal);
    for (const mirror of mirrors) {
      if (operation.signal.aborted) return null;
      const outcome = await this.lookupWithRetrieval(mirror.url, doi, operation);
      this.lastLookupStatus = outcome.status;
      if (operation.signal.aborted || operation.remainingMs() <= 0 || outcome.terminal) return null;
      if (outcome.paper) {
        if (outcome.paper.pdfUrl) {
          let cached = this.operationPdfCache.get(operation as object);
          if (!cached) {
            cached = new Map<string, string>();
            this.operationPdfCache.set(operation as object, cached);
          }
          cached.set(doi, outcome.paper.pdfUrl);
        }
        this.lastSuccessfulMirror = mirror.url;
        mirror.status = 'working';
        return outcome.paper;
      }
      if (outcome.status === 'not_found' || outcome.status === 'blocked') return null;
      if (outcome.mirrorFailure !== false) this.updateMirrorFailure(mirror, outcome.status);
    }
    return null;
  }

  private async lookupWithRetrieval(
    mirrorUrl: string,
    doi: string,
    operation: RetrievalOperationContext
  ): Promise<LookupOutcome> {
    const landingUrl = buildMirrorLandingUrl(mirrorUrl, doi);
    const request = (strategy: 'direct' | 'static' | 'browser') => ({
      url: landingUrl,
      purpose: 'scihub_lookup' as const,
      strategy,
      documentFormat: 'html_with_iframes' as const,
      signal: operation.signal
    });
    const steps: RetrievalStrategyStep[] = this.fetchMode === 'direct'
      ? [{ request: request('direct'), retryResponse: response => this.shouldRetryDirectResponse(response) }]
      : [
        {
          request: request('direct'),
          retryResponse: response => this.shouldRetryDirectResponse(response),
          isTerminalResponse: async response => !(await this.needsSciHubFallback(response, operation.signal)),
          continueOnError: error => isSciHubFallbackError(error)
        },
        {
          request: request('static'),
          shouldAttempt: async state => await this.needsSciHubFallback(state.previousResponse, operation.signal)
            || isSciHubFallbackError(state.previousError),
          isTerminalResponse: async response => !(await this.needsSciHubBrowser(response, operation.signal))
        },
        {
          request: request('browser'),
          shouldAttempt: async state => await this.needsSciHubBrowser(state.previousResponse, operation.signal)
        }
      ];

    try {
      const response = await this.retrievalService.retrieveWithStrategies(steps, operation, {
        maxPaidStrategySelections: 3,
        maxBrowserDispatches: 1
      });
      return await this.classifyRetrievalLookup(response, doi, landingUrl, mirrorUrl, operation);
    } catch (error) {
      const terminal = isTerminalSciHubRetrievalError(error);
      const mirrorFailure = !operation.signal.aborted && !terminal && isMirrorHealthRelevantError(error);
      return {
        status: terminal && error instanceof RetrievalError && error.code === 'security' ? 'blocked' : 'transport_error',
        landingUrl,
        dynamic: false,
        mirrorFailure,
        terminal
      };
    }
  }

  private async classifyRetrievalLookup(
    response: RetrievalResponse,
    doi: string,
    landingUrl: string,
    mirrorUrl: string,
    operation: RetrievalOperationContext
  ): Promise<LookupOutcome> {
    const targetStatus = response.targetStatus ?? response.document?.targetStatus;
    if (targetStatus === 401 || targetStatus === 403 || targetStatus === 407 || targetStatus === 429 || targetStatus === 423) return { status: 'blocked', landingUrl, dynamic: true };
    const document = response.document;
    if (!document) {
      if (targetStatus === 404 || targetStatus === 410) return { status: 'not_found', landingUrl, dynamic: false };
      if (targetStatus !== undefined && targetStatus >= 500) return { status: 'mirror_unhealthy', landingUrl, dynamic: false };
      return { status: 'transport_error', landingUrl, dynamic: false };
    }
    const documentHtml = [document.html, ...document.iframes.map(frame => frame.html)].join('\n');
    if (looksRestricted(documentHtml)) {
      return { status: 'blocked', landingUrl, dynamic: true };
    }
    if (targetStatus === 404 || targetStatus === 410) return { status: 'not_found', landingUrl, dynamic: false };
    if (targetStatus !== undefined && targetStatus >= 500) return { status: 'mirror_unhealthy', landingUrl, dynamic: false };
    if (targetStatus !== undefined && (targetStatus < 200 || targetStatus >= 300)) {
      return { status: 'mirror_unhealthy', landingUrl, dynamic: false };
    }
    if (targetStatus !== undefined && targetStatus >= 200 && targetStatus < 300 && looksNotFound(documentHtml)) {
      return { status: 'not_found', landingUrl, dynamic: false };
    }
    const documents = [
      { html: document.html, baseUrl: document.source.provenance === 'trusted_direct' ? document.source.finalUrl : '' },
      ...document.iframes.map(frame => ({
        html: frame.html,
        baseUrl: ''
      }))
    ];
    const candidates = await findPdfCandidates(
      documents,
      url => this.validateCandidateUrl(url, 'scihub_lookup', operation.signal),
      document.iframes.map(frame => frame.src),
      operation.signal
    );
    throwIfOperationUnavailable(operation);
    if (candidates.length) {
      return {
        status: 'working',
        paper: makePaper(doi, landingUrl, candidates[0], document.html, mirrorUrl, response.strategy),
        landingUrl,
        dynamic: false
      };
    }
    const dynamic = await this.hasApprovedDynamicShape(document, operation.signal);
    return { status: dynamic ? 'blocked' : 'markup_changed', landingUrl, dynamic };
  }

  private shouldRetryDirectResponse(response: RetrievalResponse): boolean {
    const targetStatus = response.targetStatus ?? response.document?.targetStatus;
    if (targetStatus === undefined || targetStatus < 500) return false;
    const document = response.document;
    if (!document) return true;
    const documentHtml = [document.html, ...document.iframes.map(frame => frame.html)].join('\n');
    return !looksRestricted(documentHtml);
  }

  private async needsSciHubFallback(response: RetrievalResponse | undefined, signal: AbortSignal): Promise<boolean> {
    if (!response || signal.aborted) return false;
    const status = response.targetStatus ?? response.document?.targetStatus;
    const documentHtml = response.document
      ? [response.document.html, ...response.document.iframes.map(frame => frame.html)].join('\n')
      : '';
    if (status === 401 || status === 403 || status === 407 || status === 429 || status === 404 || status === 410 || status === 423) return false;
    if (looksRestricted(documentHtml)) return false;
    if (status === undefined) return false;
    if (status < 200 || status >= 300) return status >= 500;
    if (looksNotFound(documentHtml)) return false;
    let approvedDynamic = false;
    if (response.document && this.hasPotentialDynamicShape(response.document)) {
      approvedDynamic = await this.hasApprovedDynamicShape(response.document, signal);
      if (!approvedDynamic) return false;
    }
    return !hasPdfEvidence(response)
      && !looksBlocked(documentHtml)
      && (hasDynamicContainer(documentHtml) || approvedDynamic);
  }

  private async needsSciHubBrowser(response: RetrievalResponse | undefined, signal: AbortSignal): Promise<boolean> {
    if (!response) return false;
    const status = response.targetStatus ?? response.document?.targetStatus;
    if (status === undefined || status < 200 || status >= 300 || !response.document) return false;
    const documentHtml = [response.document.html, ...response.document.iframes.map(frame => frame.html)].join('\n');
    if (looksNotFound(documentHtml) || hasPdfEvidence(response) || looksBlocked(documentHtml)) return false;
    return this.hasApprovedDynamicShape(response.document, signal);
  }

  private hasPotentialDynamicShape(document: NonNullable<RetrievalResponse['document']>): boolean {
    return [document.html, ...document.iframes.map(frame => frame.html)].some(html =>
      hasEmptyPdfShape(html) || dynamicDataSources(html).length > 0
    );
  }

  private async hasApprovedDynamicShape(document: NonNullable<RetrievalResponse['document']>, signal: AbortSignal): Promise<boolean> {
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
          await this.validateCandidateUrl(dataSrc, 'scihub_lookup', signal);
          return true;
        } catch (error) {
          if (signal.aborted || isAbortError(error)) throw error;
        }
      }
    }
    return false;
  }

  private async validateCandidateUrl(
    url: string,
    purpose: 'scihub_lookup' | 'scihub_download' = 'scihub_lookup',
    signal?: AbortSignal
  ): Promise<PublicUrlValidation> {
    if (hasSensitiveCandidateCredentials(url)) throw new SensitiveOutboundTargetError();
    const validation = this.securityPolicy.validate(url, purpose);
    return signal ? awaitWithAbort(validation, signal) : validation;
  }

  private async getCandidateMirrors(signal?: AbortSignal): Promise<MirrorSite[]> {
    if (!this.lastHealthCheck || Date.now() - this.lastHealthCheck.getTime() > this.healthCheckInterval) {
      await this.checkMirrorHealth(false, signal);
    }
    const available = this.mirrorSites.filter(mirror => mirror.status !== 'disabled');
    if (!available.length) {
      throw new Error('No Sci-Hub mirrors were discovered or configured');
    }
    // A direct health failure is not proof that the mirror has no content:
    // retain the bounded mirror list so the controlled ScrapingAnt fallback
    // can handle a blocked or dynamically-rendered landing page. Health
    // checks remain cached and are never repeated implicitly here.
    return [...available].sort((left, right) => {
      if (left.url === this.lastSuccessfulMirror) return -1;
      if (right.url === this.lastSuccessfulMirror) return 1;
      return (left.responseTime || Infinity) - (right.responseTime || Infinity);
    });
  }

  private async checkMirrorHealth(force: boolean, signal?: AbortSignal): Promise<void> {
    if (!this.enabled) return;
    if (signal?.aborted) throw createAbortError();
    if (!force && this.lastHealthCheck && Date.now() - this.lastHealthCheck.getTime() <= this.healthCheckInterval) return;

    let flight = this.healthFlight;
    if (!flight || flight.detached || flight.controller.signal.aborted) {
      flight = this.startHealthFlight();
    }

    flight.waiters++;
    try {
      await waitForHealthFlight(flight.promise, signal);
    } finally {
      flight.waiters--;
      if (flight.waiters === 0 && this.healthFlight === flight) {
        this.detachHealthFlight(flight);
      }
    }
  }

  private startHealthFlight(): HealthFlight {
    const controller = new AbortController();
    let rejectDeadline!: (error: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const producer = this.performHealthCheck(controller.signal);
    const flight = {
      id: ++this.healthFlightSequence,
      controller,
      promise: Promise.race([producer, deadline]),
      rejectDeadline,
      waiters: 0,
      detached: false,
      timedOut: false
    } as HealthFlight;
    this.healthFlight = flight;
    flight.timer = setTimeout(() => {
      if (flight.timedOut) return;
      flight.timedOut = true;
      flight.detached = true;
      flight.controller.abort();
      if (this.healthFlight === flight) this.healthFlight = null;
      flight.rejectDeadline(new RetrievalError({
        code: 'timeout',
        message: 'Sci-Hub health check timed out',
        provider: 'scihub'
      }));
    }, this.healthCheckProducerTimeout);
    void flight.promise.then(
      () => this.finishHealthFlight(flight),
      () => this.finishHealthFlight(flight)
    );
    return flight;
  }

  private finishHealthFlight(flight: HealthFlight): void {
    if (flight.timer !== undefined) clearTimeout(flight.timer);
    if (this.healthFlight === flight && flight.waiters === 0) this.detachHealthFlight(flight);
  }

  private detachHealthFlight(flight: HealthFlight): void {
    if (flight.detached) return;
    flight.detached = true;
    flight.controller.abort();
    if (this.healthFlight === flight) this.healthFlight = null;
  }

  private async performHealthCheck(signal: AbortSignal): Promise<void> {
    const discoveries = await Promise.all(
      SCIHUB_MIRROR_DIRECTORY_URLS.map(sourceUrl => this.discoverMirrorSource(sourceUrl, signal))
    );
    if (signal.aborted) return;

    const discoveredMirrorsBySource = new Map(this.discoveredMirrorsBySource);
    discoveries.forEach(result => {
      if (result.succeeded) discoveredMirrorsBySource.set(result.sourceUrl, result.mirrors);
    });
    const mirrorUrls = [...new Set([
      ...this.configuredMirrorUrls,
      ...[...discoveredMirrorsBySource.values()].flat()
    ])];
    const existingMirrors = new Map(this.mirrorSites.map(mirror => [mirror.url, mirror]));
    const mirrors = mirrorUrls.map(url => existingMirrors.get(url) || {
      url,
      status: 'not_checked' as const,
      failureCount: 0
    });

    const limit = createConcurrencyLimiter(this.healthCheckConcurrency);
    const snapshots: Array<MirrorSite | undefined> = [];
    await Promise.all(mirrors.map((mirror, index) => limit(async () => {
      const startedAt = Date.now();
      let response: PublicHttpResponse | undefined;
      try {
        if (signal.aborted) throw new Error('health check cancelled');
        response = await this.healthHttpClient.request(mirror.url, {
          method: 'GET',
          timeout: TIMEOUTS.HEALTH_CHECK,
          signal
        });
        const html = toHtml(response.response.data);
        const responseTime = Date.now() - startedAt;
        const valid = response.response.status >= 200 && response.response.status < 300 && isSciHubPage(html);
        snapshots[index] = {
          ...mirror,
          lastChecked: new Date(),
          responseTime,
          status: valid ? 'working' : response.response.status >= 200 && response.response.status < 300 ? 'markup_changed' : 'mirror_unhealthy',
          failureCount: valid ? 0 : mirror.failureCount + 1
        };
      } catch {
        snapshots[index] = {
          ...mirror,
          lastChecked: new Date(),
          status: 'transport_error',
          failureCount: mirror.failureCount + 1
        };
      } finally {
        disposeResponseBody(response?.response.data);
      }
    }, signal)));

    if (signal.aborted) return;
    const publishedMirrors = mirrors.map((mirror, index) => snapshots[index] || mirror);
    this.discoveredMirrorsBySource = discoveredMirrorsBySource;
    this.mirrorSites.splice(0, this.mirrorSites.length, ...publishedMirrors);
    this.lastHealthCheck = new Date();
    if (!this.mirrorSites.some(mirror => mirror.status === 'working')) {
      logWarn('No Sci-Hub mirrors are currently accessible');
    }
    logDebug(`Sci-Hub health check completed for ${this.mirrorSites.length} mirrors`);
  }

  private async discoverMirrorSource(sourceUrl: string, signal: AbortSignal): Promise<MirrorDiscoveryResult> {
    let response: PublicHttpResponse<string> | undefined;
    try {
      response = await this.mirrorDiscoveryHttpClient.request<string>(sourceUrl, {
        method: 'GET',
        responseType: 'text',
        timeout: TIMEOUTS.HEALTH_CHECK,
        maxContentLength: MIRROR_DIRECTORY_MAX_BYTES,
        maxBodyLength: MIRROR_DIRECTORY_MAX_BYTES,
        signal
      });
      if (signal.aborted) return { sourceUrl, mirrors: [], succeeded: false };
      if (response.response.status < 200 || response.response.status >= 300) {
        throw new Error(`mirror directory returned status ${response.response.status}`);
      }

      const mirrors: string[] = [];
      for (const mirror of extractMirrorUrls(toHtml(response.response.data), sourceUrl)) {
        try {
          await this.validateCandidateUrl(mirror, 'scihub_lookup', signal);
          mirrors.push(mirror);
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            return { sourceUrl, mirrors: [], succeeded: false };
          }
        }
      }
      if (!mirrors.length) throw new Error('no validated mirrors found');
      return { sourceUrl, mirrors, succeeded: true };
    } catch {
      if (!signal.aborted) {
        logWarn(`Sci-Hub mirror discovery failed for ${new URL(sourceUrl).hostname}; using cached/configured mirrors`);
      }
      return { sourceUrl, mirrors: [], succeeded: false };
    } finally {
      disposeResponseBody(response?.response.data);
    }
  }

  private updateMirrorFailure(mirror: MirrorSite, status: SciHubLookupStatus): void {
    if (status === 'not_found' || status === 'markup_changed') return;
    mirror.failureCount++;
    mirror.status = status === 'blocked' ? 'blocked' : status === 'mirror_unhealthy' ? 'mirror_unhealthy' : 'transport_error';
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new CapabilityUnavailableError('scihub', 'search', 'Sci-Hub integration is disabled; set SCIHUB_ENABLED=true only for authorized use');
    }
  }
}

export function normalizeSciHubInput(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Sci-Hub requires a DOI or doi.org URL');
  const trimmed = input.trim();
  const direct = sanitizeDoi(trimmed);
  if (direct.valid && !/^https?:\/\//i.test(trimmed)) return direct.sanitized;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Sci-Hub accepts only a DOI, doi: prefix, or doi.org URL');
  }
  const host = parsed.hostname.toLowerCase();
  if ((host !== 'doi.org' && host !== 'dx.doi.org') || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Sci-Hub accepts only a DOI, doi: prefix, or doi.org URL');
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('Invalid DOI URL encoding');
  }
  const result = sanitizeDoi(decodedPath);
  if (!result.valid) throw new Error('Invalid DOI format');
  return result.sanitized;
}

export function extractPdfCandidates(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html || '');
  const values: string[] = [];
  const seenValues = new Set<string>();
  const add = (raw: string | undefined): boolean => {
    if (!raw || seenValues.has(raw)) return true;
    if (values.length >= MAX_CANDIDATES) return false;
    seenValues.add(raw);
    values.push(raw);
    return values.length < MAX_CANDIDATES;
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
  if (!each('#pdf, embed[type="application/pdf"]', element => add($(element).attr('src')))) return resolvePdfCandidates(values, baseUrl);
  if (!each('iframe[src]', element => {
    const src = $(element).attr('src');
    return !src || !isLikelyPdfUrl(src) || add(src);
  })) return resolvePdfCandidates(values, baseUrl);
  each('button[onclick], a[href]', element => {
    const href = $(element).attr('href');
    const onclick = $(element).attr('onclick') || '';
    if (href && /\.pdf(?:[?#].*)?$/i.test(href) && !add(href)) return false;
    const match = onclick.match(/(?:location\.href|window\.open)\s*\(\s*["']([^"']+)["']/i);
    return !match?.[1] || add(match[1]);
  });
  return resolvePdfCandidates(values, baseUrl);
}

function resolvePdfCandidates(values: string[], baseUrl: string): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    try {
      if (!baseUrl && !/^https?:\/\//i.test(value)) continue;
      const parsed = new URL(value, baseUrl || undefined);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (parsed.username || parsed.password) continue;
      const candidate = parsed.toString();
      if (hasSensitiveCandidateCredentials(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      resolved.push(candidate);
    } catch {
      // Ignore malformed candidates while retaining their bounded position.
    }
  }
  return [
    ...resolved.filter(isLikelyPdfUrl),
    ...resolved.filter(candidate => !isLikelyPdfUrl(candidate))
  ];
}

async function findPdfCandidates(
  documents: Array<{ html: string; baseUrl: string }>,
  validateUrl: (url: string) => Promise<PublicUrlValidation>,
  directCandidates: string[] = [],
  signal?: AbortSignal
): Promise<string[]> {
  const extractedCandidates = documents.flatMap(document => extractPdfCandidates(document.html, document.baseUrl));
  const orderedCandidates = [
    ...extractedCandidates.filter(isLikelyPdfUrl),
    ...directCandidates.filter(isLikelyPdfUrl),
    ...extractedCandidates.filter(candidate => !isLikelyPdfUrl(candidate))
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of orderedCandidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (signal?.aborted) throw createAbortError();
    try {
      await validateUrl(candidate);
      if (signal?.aborted) throw createAbortError();
      return [candidate];
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      // Reject private, malformed, credential-bearing, or non-HTTP(S) targets.
    }
  }
  return [];
}

// ScrapingAnt compatibility errors are normalized by the shared transport adapter.
function isLikelyPdfUrl(value: string): boolean {
  return /\.pdf(?:[?#].*)?$/i.test(value);
}

function makePaper(doi: string, landingUrl: string, pdfUrl: string, html: string, mirror: string, method: string): Paper {
  const $ = cheerio.load(html || '');
  const title = ($('#citation').text() || $('title').text())
    .replace(/\s*\|\s*Sci-Hub.*$/i, '')
    .replace(/Sci-Hub\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return PaperFactory.create({
    paperId: doi,
    title: title || `Paper: ${doi}`,
    source: 'scihub',
    authors: [],
    abstract: '',
    doi,
    publishedDate: null,
    pdfUrl,
    url: landingUrl,
    extra: {
      mirror,
      method,
      status: 'working',
      fetchedAt: new Date().toISOString()
    }
  });
}

function hasPdfEvidence(response: RetrievalResponse): boolean {
  const document = response.document;
  if (!document) return false;
  const directBase = document.source.provenance === 'trusted_direct' ? document.source.finalUrl : '';
  if (extractPdfCandidates(document.html, directBase).length > 0) return true;
  return document.iframes.some(frame =>
    isLikelyPdfUrl(frame.src) || extractPdfCandidates(frame.html, '').length > 0
  );
}

function isSciHubFallbackError(error: RetrievalError | undefined): boolean {
  return Boolean(error && ['network', 'server_error', 'timeout'].includes(error.code));
}

function isTerminalSciHubRetrievalError(error: unknown): boolean {
  return error instanceof RetrievalError && ['security', 'response_too_large', 'document_limit'].includes(error.code);
}

function isMirrorHealthRelevantError(error: unknown): boolean {
  if (!(error instanceof RetrievalError)) return false;
  if (error.provider && error.provider !== 'direct') return false;
  return ['network', 'server_error', 'timeout'].includes(error.code);
}

function buildMirrorLandingUrl(mirror: string, doi: string): string {
  const url = new URL(mirror);
  const encodedDoi = doi.split('/').map(part => encodeURIComponent(part)).join('/');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodedDoi}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function waitForHealthFlight(flight: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return flight;
  if (signal.aborted) throw createAbortError();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    flight.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export function extractMirrorUrls(html: string, sourceUrl: string): string[] {
  const $ = cheerio.load(html || '');
  const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  const selector = sourceHost === 'www.ooopn.com'
    ? 'table.scholar-table tbody td.url-cell a[href]'
    : 'main a[href]';
  const mirrors: string[] = [];
  const seen = new Set<string>();

  $(selector).each((_index, element) => {
    if (mirrors.length >= MAX_DISCOVERED_MIRRORS) return false;
    const link = $(element);
    const href = link.attr('href')?.trim();
    if (!href) return;
    if (sourceHost !== 'www.ooopn.com') {
      const label = [link.text(), link.attr('title'), link.attr('aria-label')]
        .filter(Boolean)
        .join(' ');
      const external = /^https?:\/\//i.test(href) || link.attr('target') === '_blank';
      if (!external || !MIRROR_DIRECTORY_PATTERN.test(label)) return;
    }

    try {
      const mirror = normalizeMirror(new URL(href, sourceUrl).toString());
      if (mirror && !seen.has(mirror)) {
        seen.add(mirror);
        mirrors.push(mirror);
      }
    } catch {
      // Ignore malformed or unsupported links from the external directory.
    }
    return;
  });

  return mirrors;
}

export function normalizeMirror(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').toLowerCase());
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readMaxFileSize(): number {
  const configured = Number(process.env.MAX_FILE_SIZE_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : 100;
  return megabytes * 1024 * 1024;
}

async function lstatIfPresent(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function toHtml(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return '';
}

function isSciHubPage(html: string): boolean {
  return /sci[- ]hub|alexandra\s+elbakyan/i.test(html);
}

function looksNotFound(html: string): boolean {
  return /not\s+found|does\s+not\s+contain|article\s+(?:is\s+)?unavailable|no\s+(?:such\s+)?paper/i.test(html);
}

function looksRestricted(html: string): boolean {
  return /captcha|cloudflare|just\s+a\s+moment|access\s+denied|checking\s+your\s+browser|verify\s+you\s+are\s+human|sign\s*in|log\s*in|login|paywall|subscription\s+required|institutional\s+access|full\s*text\s+(?:is\s+)?(?:unavailable|restricted)/i.test(html);
}

function looksBlocked(html: string): boolean {
  return looksRestricted(html) || /enable\s+javascript|javascript\s+required/i.test(html);
}

function hasDynamicContainer(html: string): boolean {
  return /<iframe\b/i.test(html);
}

/**
 * Return the data sources represented by the approved iframe DOM shape.
 * The caller must resolve and validate each source in the document context.
 */
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
    if (isIP(hostname) && !isPublicAddress(hostname)) return false;
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && Boolean(hostname)
      && !hasSensitiveCandidateCredentials(value)
      && hostname !== 'localhost'
      && hostname !== 'localhost.localdomain'
      && hostname !== 'ip6-localhost'
      && hostname !== 'metadata.google.internal'
      && hostname !== 'metadata.google.com'
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

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void
): Promise<T> {
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
        if (settled) {
          try {
            onLateValue?.(value);
          } catch {
            // Late response disposal must not create an unhandled rejection.
          }
          return;
        }
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
    if (signal.aborted) onAbort();
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function writeValidatedPdf(
  data: unknown,
  temporaryPath: string,
  maxBytes: number,
  operation: RetrievalOperationContext
): Promise<void> {
  let bytes = 0;
  let header = Buffer.alloc(0);
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        callback(new Error('PDF exceeds the configured maximum file size'));
        return;
      }
      if (header.length < 5) header = Buffer.concat([header, buffer]).subarray(0, 5);
      callback(null, buffer);
    }
  });
  const source = isAsyncIterable(data)
    ? data as NodeJS.ReadableStream
    : Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : '')]);
  const destination = fs.createWriteStream(temporaryPath, { flags: 'wx' });

  try {
    throwIfOperationUnavailable(operation);
    await pipeline(source as any, validator, destination, { signal: operation.signal });
    if (!header.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('Downloaded content is not a PDF');
    }
  } catch (error) {
    (source as any).destroy?.();
    destination.destroy();
    if (isOperationTimedOut(operation)) {
      throw new RetrievalError({ code: 'timeout', message: 'Retrieval operation timed out', provider: 'scihub' });
    }
    if (operation.signal.aborted) {
      throw new RetrievalError({ code: 'cancelled', message: 'Retrieval operation was cancelled', provider: 'scihub' });
    }
    throw error;
  }
}

function throwIfOperationUnavailable(operation: RetrievalOperationContext): void {
  if (isOperationTimedOut(operation)) {
    throw new RetrievalError({ code: 'timeout', message: 'Retrieval operation timed out', provider: 'scihub' });
  }
  if (operation.signal.aborted) {
    throw new RetrievalError({ code: 'cancelled', message: 'Retrieval operation was cancelled', provider: 'scihub' });
  }
}

function isOperationTimedOut(operation: RetrievalOperationContext): boolean {
  const timedOut = (operation as RetrievalOperationContext & { timedOut?: () => boolean }).timedOut;
  return Boolean(timedOut?.()) || operation.remainingMs() <= 0;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function');
}

export default SciHubSearcher;
