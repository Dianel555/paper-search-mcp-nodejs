import { PaperFactory, type Paper } from '../models/Paper.js';
import { sanitizeSensitiveText } from '../utils/SecurityUtils.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalResponse } from '../retrieval/types.js';
import type { PublicAccessDiscovery } from './PublicAccessDiscovery.js';
import type { SciHubSearcher } from '../platforms/SciHubSearcher.js';
import {
  ControlledPdfDownloadError,
  ControlledPdfDownloader,
  publicPaperDestinationPath
} from './ControlledPdfDownloader.js';
import { discoverPublicPage, type PublicPageFallbackService } from './PublicPageFallback.js';
import {
  diagnostics,
  knownProviderCost,
  noProviderCost,
  type MarkdownStatus,
  type PaperMarkdownResult,
  type PublicDownloadResult,
  type PublicPaperCost,
  type PublicPaperDiagnostics,
  type PublicPaperPlatform,
  type PublicDiagnosticPhase,
  type PublicDiagnosticReason,
  unknownProviderCost
} from '../mcp/publicPaperContracts.js';
import type { ScholarReferenceCache, ScholarReferenceLookup } from '../mcp/ScholarReferenceCache.js';

export interface PublicPaperServiceOptions {
  readonly retrievalService: PublicPageFallbackService & {
    retrieve?: (request: any, operation?: RetrievalOperationContext) => Promise<RetrievalResponse>;
  };
  readonly publicAccess: Pick<PublicAccessDiscovery, 'enrich' | 'resolvePublisherTarget'>;
  readonly scihub: Pick<SciHubSearcher, 'search' | 'resolvePublicTarget'>;
  readonly downloader?: ControlledPdfDownloader;
}

export interface PublicPaperDownloadInput {
  readonly platform: PublicPaperPlatform;
  readonly paperId: string;
  readonly saveDirectory: string;
  readonly operation: RetrievalOperationContext;
  readonly scholarReferenceCache?: ScholarReferenceCache;
}

export interface PublicPaperMarkdownInput {
  readonly platform: PublicPaperPlatform;
  readonly paperId: string;
  readonly operation: RetrievalOperationContext;
  readonly scholarReferenceCache?: ScholarReferenceCache;
}

export class PublicPaperService {
  private readonly retrievalService: PublicPaperServiceOptions['retrievalService'];
  private readonly publicAccess: PublicPaperServiceOptions['publicAccess'];
  private readonly scihub: PublicPaperServiceOptions['scihub'];
  private readonly downloader: ControlledPdfDownloader;

  constructor(options: PublicPaperServiceOptions) {
    this.retrievalService = options.retrievalService;
    this.publicAccess = options.publicAccess;
    this.scihub = options.scihub;
    this.downloader = options.downloader || new ControlledPdfDownloader();
  }

  async download(input: PublicPaperDownloadInput): Promise<PublicDownloadResult> {
    const base = {
      platform: input.platform,
      normalizedPaperId: input.paperId,
      phase: 'reference' as const,
      operation: input.operation
    };
    const reference = this.resolveScholarReference(input.platform, input.paperId, input.scholarReferenceCache);
    if (reference.status !== 'hit') {
      return {
        platform: input.platform,
        normalizedPaperId: input.paperId,
        status: 'reference_unavailable',
        diagnostics: diagnostics('reference', referenceReason(reference.status)),
        cost: noProviderCost()
      };
    }

    try {
      const candidates = await this.findDownloadCandidates(input, reference.reference?.url);
      if (!candidates.urls.length) {
        return {
          platform: input.platform,
          normalizedPaperId: input.paperId,
          status: candidates.reason === 'restricted' ? 'restricted' : candidates.reason === 'provider'
            ? 'provider_unavailable' : candidates.reason === 'not_found' ? 'not_found'
              : candidates.reason === 'cancelled' ? 'cancelled'
                : candidates.reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'failed',
          diagnostics: diagnostics('discovery', candidates.reason === 'restricted'
            ? 'restricted_target'
            : candidates.reason === 'provider' ? 'provider_unavailable' : candidates.reason === 'not_found'
              ? 'candidate_not_found' : candidates.reason === 'cancelled' ? 'cancelled'
                : candidates.reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'candidate_not_found', {
                targetStatus: candidates.targetStatus,
                apiStatus: candidates.apiStatus,
                strategy: candidates.strategy,
                candidateCount: candidates.candidateCount
              }),
          cost: candidates.cost
        };
      }

      const filePath = await this.downloader.download({
        platform: input.platform,
        normalizedPaperId: input.paperId,
        candidates: candidates.urls,
        saveDirectory: input.saveDirectory,
        operation: input.operation,
        mode: 'new_public'
      });
      return {
        platform: input.platform,
        normalizedPaperId: input.paperId,
        status: 'downloaded',
        diagnostics: diagnostics('download', 'downloaded', {
          apiStatus: candidates.apiStatus,
          targetStatus: candidates.targetStatus,
          strategy: candidates.strategy,
          candidateCount: candidates.candidateCount
        }),
        cost: candidates.cost,
        filePath
      };
    } catch (error) {
      return this.downloadFailure(input.platform, input.paperId, error, input.operation);
    }
  }

  async markdown(input: PublicPaperMarkdownInput): Promise<PaperMarkdownResult> {
    const reference = this.resolveScholarReference(input.platform, input.paperId, input.scholarReferenceCache);
    if (reference.status !== 'hit') {
      return {
        platform: input.platform,
        normalizedPaperId: input.paperId,
        status: 'reference_unavailable',
        diagnostics: diagnostics('reference', referenceReason(reference.status)),
        cost: noProviderCost()
      };
    }

    let target: string;
    try {
      if (input.platform === 'publisher') {
        const resolved = await this.publicAccess.resolvePublisherTarget(input.paperId, input.operation);
        if (isHardRestrictedTargetStatus(resolved.status) && !this.authorizedFor('publisher')) {
          return {
            platform: input.platform,
            normalizedPaperId: input.paperId,
            status: 'restricted',
            diagnostics: diagnostics('reference', 'restricted_target', { targetStatus: resolved.status }),
            cost: operationCost(input.operation)
          };
        }
        if (resolved.status === 429) {
          return {
            platform: input.platform,
            normalizedPaperId: input.paperId,
            status: 'target_error',
            diagnostics: diagnostics('reference', 'target_rate_limited', { targetStatus: resolved.status }),
            cost: operationCost(input.operation)
          };
        }
        target = resolved.url;
      } else if (input.platform === 'googlescholar') {
        target = reference.reference!.url;
      } else {
        target = await this.scihub.resolvePublicTarget(input.paperId, input.operation);
      }
    } catch (error) {
      return this.markdownFailure(input.platform, input.paperId, error, input.operation, 'reference');
    }

    if (!this.retrievalService.retrieve) {
      return {
        platform: input.platform,
        normalizedPaperId: input.paperId,
        status: 'provider_unavailable',
        diagnostics: diagnostics('provider', 'provider_unavailable'),
        cost: noProviderCost()
      };
    }

    try {
      const response = await this.retrievalService.retrieve({
        url: target,
        purpose: input.platform === 'publisher' ? 'publisher_discovery' : input.platform === 'googlescholar' ? 'scholar_search' : 'scihub_lookup',
        strategy: 'static',
        proxyType: 'datacenter',
        documentFormat: 'markdown',
        transportProfile: 'public_landing',
        entrypointProfile: 'markdown',
        signal: input.operation.signal
      }, input.operation);
      return this.markdownResponse(input.platform, input.paperId, response, input.operation);
    } catch (error) {
      return this.markdownFailure(input.platform, input.paperId, error, input.operation, 'markdown');
    }
  }

  private async findDownloadCandidates(
    input: PublicPaperDownloadInput,
    scholarUrl?: string
  ): Promise<CandidateResult> {
    if (input.platform === 'publisher') {
      const seed = PaperFactory.create({
        paperId: input.paperId,
        title: `Publisher paper ${input.paperId}`,
        doi: input.paperId,
        source: 'publisher'
      });
      const [paper] = await this.publicAccess.enrich([seed], {
        verifyPdf: false,
        operation: input.operation
      });
      if (input.operation.signal.aborted || input.operation.remainingMs() <= 0) {
        return { urls: [], reason: input.operation.remainingMs() <= 0 ? 'deadline_exceeded' : 'cancelled', candidateCount: 0, cost: operationCost(input.operation) };
      }
      const access = paper?.extra?.accessDiscovery as {
        status?: string;
        candidateUrl?: string;
        candidateUrls?: readonly string[];
        apiStatus?: number;
        targetStatus?: number;
        strategy?: 'direct' | 'static' | 'browser';
        fallback?: { attempted?: boolean };
        creditsCost?: number;
      } | undefined;
      const urls = uniqueUrls(access?.candidateUrls || (paper?.pdfUrl ? [paper.pdfUrl] : []));
      return {
        urls,
        reason: access?.status === 'restricted' ? 'restricted' : access?.status === 'not_found' ? 'not_found' : urls.length ? 'candidate' : access?.fallback?.attempted ? 'provider' : 'not_found',
        apiStatus: access?.apiStatus,
        targetStatus: access?.targetStatus,
        strategy: access?.strategy,
        candidateCount: urls.length,
        cost: operationCost(input.operation)
      };
    }

    if (input.platform === 'scihub') {
      const paper = await this.scihub.search(input.paperId, {
        operationContext: input.operation,
        entrypointProfile: 'public_download'
      });
      if (input.operation.signal.aborted || input.operation.remainingMs() <= 0) {
        return { urls: [], reason: input.operation.remainingMs() <= 0 ? 'deadline_exceeded' : 'cancelled', candidateCount: 0, cost: operationCost(input.operation) };
      }
      const urls = uniqueUrls(paper.flatMap(value => value.pdfUrl ? [value.pdfUrl] : []));
      if (urls.length) return { urls, reason: 'candidate', candidateCount: urls.length, cost: operationCost(input.operation) };
      return { urls: [], reason: 'not_found', candidateCount: 0, cost: operationCost(input.operation) };
    }

    if (!scholarUrl) return { urls: [], reason: 'not_found', candidateCount: 0, cost: noProviderCost() };
    const page = await discoverPublicPage({
      service: this.retrievalService,
      url: scholarUrl,
      purpose: 'scholar_search',
      platform: 'googlescholar',
      operation: input.operation,
      transportProfile: 'public_landing',
      entrypointProfile: 'public_download',
      authorizedCorpus: this.authorizedFor('googlescholar')
    });
    return {
      urls: page.candidates.map(candidate => candidate.url),
      reason: page.state === 'restricted' ? 'restricted' : page.state === 'provider_unavailable' ? 'provider' : page.state === 'not_found' ? 'not_found'
        : page.state === 'cancelled' ? 'cancelled' : page.state === 'deadline_exceeded' ? 'deadline_exceeded' : 'failed',
      apiStatus: page.response?.apiStatus,
      targetStatus: page.response?.targetStatus,
      strategy: page.response?.strategy,
      candidateCount: page.candidateCount,
      cost: operationCost(input.operation, page.response ? responseCost(page.response) : undefined)
    };
  }

  private authorizedFor(platform: PublicPaperPlatform): boolean {
    const status = this.retrievalService.getProcessStatus();
    return status.authorizedCorpusAllowed === true
      && status.authorizedCorpusPlatforms?.includes(platform) === true;
  }

  private resolveScholarReference(
    platform: PublicPaperPlatform,
    paperId: string,
    cache?: ScholarReferenceCache
  ): ScholarReferenceLookup {
    if (platform !== 'googlescholar') return { status: 'hit' };
    return cache?.get(paperId) || { status: 'missing' };
  }

  private downloadFailure(
    platform: PublicPaperPlatform,
    paperId: string,
    error: unknown,
    operation: RetrievalOperationContext
  ): PublicDownloadResult {
    const typed = error instanceof ControlledPdfDownloadError ? error : undefined;
    const operationUnavailableReason = operation.signal.aborted
      ? operation.remainingMs() <= 0 ? 'deadline_exceeded' : 'cancelled'
      : operation.remainingMs() <= 0 ? 'deadline_exceeded' : undefined;
    const reason = typed?.reason || operationUnavailableReason || 'download_failed';
    const status = reason === 'destination_exists' ? 'destination_exists'
      : reason === 'restricted_target' ? 'restricted'
        : reason === 'cancelled' ? 'cancelled'
          : reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'failed';
    const diagnosticReason: PublicDiagnosticReason = reason === 'destination_exists' ? 'destination_exists'
      : reason === 'pdf_mime_mismatch' ? 'pdf_mime_mismatch'
        : reason === 'pdf_magic_mismatch' ? 'pdf_magic_mismatch'
          : reason === 'pdf_resource_limit' ? 'pdf_resource_limit'
            : reason === 'no_clobber_unsupported' ? 'no_clobber_unsupported'
              : reason === 'target_rate_limited' ? 'target_rate_limited'
                : reason === 'restricted_target' ? 'restricted_target'
                  : reason === 'cancelled' ? 'cancelled'
                    : reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'download_failed';
    return {
      platform,
      normalizedPaperId: paperId,
      status,
      diagnostics: diagnostics('download', diagnosticReason, { targetStatus: typed?.status }),
      cost: operationCost(operation)
    };
  }

  private markdownResponse(
    platform: PublicPaperPlatform,
    paperId: string,
    response: RetrievalResponse,
    operation: RetrievalOperationContext
  ): PaperMarkdownResult {
    const targetStatus = response.targetStatus ?? response.document?.targetStatus;
    const cost = operationCost(operation, responseCost(response));
    if (response.apiStatus === undefined || response.apiStatus < 200 || response.apiStatus >= 300) {
      return { platform, normalizedPaperId: paperId, status: 'provider_unavailable', diagnostics: diagnostics('provider', 'provider_api_error', { apiStatus: response.apiStatus, targetStatus, strategy: response.strategy }), cost };
    }
    if (targetStatus === undefined) {
      return { platform, normalizedPaperId: paperId, status: 'target_error', diagnostics: diagnostics('markdown', 'target_status_missing', { apiStatus: response.apiStatus, strategy: response.strategy }), cost };
    }
    if (targetStatus === 401 || targetStatus === 403 || targetStatus === 407 || targetStatus === 423 || /(?:sign\s*in|log\s*in|login|paywall|subscription\s+required|institutional\s+access|full\s*text\s+(?:is\s+)?(?:unavailable|restricted))/i.test(markdownText(response))) {
      return { platform, normalizedPaperId: paperId, status: 'restricted', diagnostics: diagnostics('markdown', 'restricted_target', { apiStatus: response.apiStatus, targetStatus, strategy: response.strategy }), cost };
    }
    if (targetStatus < 200 || targetStatus >= 300) {
      return { platform, normalizedPaperId: paperId, status: 'target_error', diagnostics: diagnostics('markdown', targetStatus === 429 ? 'target_rate_limited' : 'target_http_error', { apiStatus: response.apiStatus, targetStatus, strategy: response.strategy }), cost };
    }
    const markdown = response.document?.kind === 'markdown' ? response.document.markdown : undefined;
    if (!markdown || !markdown.trim()) {
      return { platform, normalizedPaperId: paperId, status: 'failed', diagnostics: diagnostics('markdown', 'empty_content', { apiStatus: response.apiStatus, targetStatus, strategy: response.strategy }), cost };
    }
    const sanitized = sanitizeMarkdown(markdown);
    if (!sanitized.safe) {
      return { platform, normalizedPaperId: paperId, status: 'failed', diagnostics: diagnostics('markdown', 'sensitive_content', { apiStatus: response.apiStatus, targetStatus, strategy: response.strategy }), cost };
    }
    return {
      platform,
      normalizedPaperId: paperId,
      status: 'ok',
      diagnostics: diagnostics('markdown', 'ok', { apiStatus: response.apiStatus, targetStatus, strategy: response.strategy }),
      cost,
      markdown: sanitized.value,
      untrusted: true
    };
  }

  private markdownFailure(
    platform: PublicPaperPlatform,
    paperId: string,
    error: unknown,
    operation: RetrievalOperationContext,
    phase: PublicDiagnosticPhase
  ): PaperMarkdownResult {
    const typed = error as { code?: string; apiStatus?: number; targetStatus?: number; cost?: { known: boolean; credits: number | null } } | undefined;
    const cancelled = typed?.code === 'cancelled'
      || (operation.signal.aborted && operation.remainingMs() > 0);
    const deadline = typed?.code === 'timeout'
      || operation.remainingMs() <= 0;
    const status: MarkdownStatus = typed?.code === 'security'
      || isHardRestrictedTargetStatus(typed?.targetStatus) ? 'restricted'
      : cancelled ? 'cancelled'
        : deadline ? 'deadline_exceeded'
          : typed?.code === 'target_unavailable' ? 'target_error' : 'provider_unavailable';
    const reason: PublicDiagnosticReason = status === 'restricted' ? 'restricted_target'
      : status === 'cancelled' ? 'cancelled'
        : status === 'deadline_exceeded' ? 'deadline_exceeded'
          : status === 'target_error' ? 'target_http_error' : 'provider_unavailable';
    return {
      platform,
      normalizedPaperId: paperId,
      status,
      diagnostics: diagnostics(phase, reason, { apiStatus: typed?.apiStatus, targetStatus: typed?.targetStatus }),
      cost: operationCost(operation, typed?.cost ? toPublicCost(typed.cost) : undefined)
    };
  }
}

interface CandidateResult {
  readonly urls: readonly string[];
  readonly reason: 'candidate' | 'not_found' | 'restricted' | 'provider' | 'cancelled' | 'deadline_exceeded' | 'failed';
  readonly apiStatus?: number;
  readonly targetStatus?: number;
  readonly strategy?: 'direct' | 'static' | 'browser';
  readonly candidateCount: number;
  readonly cost: PublicPaperCost;
}

function isHardRestrictedTargetStatus(status: number | undefined): boolean {
  return status === 401 || status === 407 || status === 423;
}

function referenceReason(status: ScholarReferenceLookup['status']): PublicDiagnosticReason {
  return status === 'expired' ? 'reference_expired' : status === 'ambiguous' ? 'reference_ambiguous' : 'reference_missing';
}

function uniqueUrls(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].slice(0, 20);
}

function responseCost(response: RetrievalResponse): PublicPaperCost {
  return response.cost.known ? knownProviderCost(response.cost.credits) : unknownProviderCost();
}

function operationCost(operation: RetrievalOperationContext, fallback?: PublicPaperCost): PublicPaperCost {
  const snapshot = operation.cost && typeof operation.cost.snapshot === 'function' ? operation.cost.snapshot() : undefined;
  if (!snapshot || !Number.isFinite(snapshot.admissionUsed)
    || !Number.isFinite(snapshot.reservedCredits)
    || !Number.isFinite(snapshot.unknownCostAttempts)) return fallback || noProviderCost();
  if (snapshot.admissionUsed === 0 && snapshot.reservedCredits === 0 && snapshot.unknownCostAttempts === 0) return noProviderCost();
  if (!snapshot.reportedCreditsKnown || snapshot.unknownCostAttempts > 0) return unknownProviderCost();
  return knownProviderCost(snapshot.reportedCredits);
}

function toPublicCost(value: { known: boolean; credits: number | null }): PublicPaperCost {
  return value.known && typeof value.credits === 'number' ? knownProviderCost(value.credits) : unknownProviderCost();
}

function markdownText(response: RetrievalResponse): string {
  return response.document?.kind === 'markdown' ? response.document.markdown || '' : '';
}

function sanitizeMarkdown(value: string): { safe: boolean; value: string } {
  const credentialPattern = /(?:cookie|set-cookie|authorization|proxy-authorization|bearer|basic|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passcode)\s*[:=]\s*[^\s\n]+/i;
  const sensitiveUrlPattern = /https?:\/\/[^\s)]+(?:token|password|signature|sig|auth|credential|session|secret|key)=[^\s)&]+/i;
  const privateKeyBlockPattern = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/i;
  const privateKeyStartPattern = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i;
  const digestAuthPattern = /\bDigest\s+[^\r\n]+/i;
  const authSchemePattern = /\b(?:bearer|basic)\s+[^\s\n]+/i;
  const userInfoPattern = /https?:\/\/[^/\s@]+@/i;
  if (!credentialPattern.test(value) && !sensitiveUrlPattern.test(value) && !privateKeyBlockPattern.test(value) && !privateKeyStartPattern.test(value) && !digestAuthPattern.test(value) && !authSchemePattern.test(value) && !userInfoPattern.test(value)) {
    return { safe: true, value };
  }
  if (privateKeyStartPattern.test(value) || digestAuthPattern.test(value)) return { safe: false, value: '' };
  const sanitized = sanitizeSensitiveText(value);
  const residualCredentialPattern = /(?:cookie|set-cookie|authorization|proxy-authorization|bearer|basic|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passcode)\s*[:=]\s*(?!(?:\*{3}|\*{3}REDACTED\*{3}))[^\s\n]+/i;
  const residualSensitiveUrlPattern = /https?:\/\/[^\s)]+(?:token|password|signature|sig|auth|credential|session|secret|key)=(?!\*{3}(?:[&#\s)"']|$))[^\s)&]+/i;
  const residualAuthSchemePattern = /\b(?:bearer|basic)\s+(?!\*{3})[^\s\n]+/i;
  const residualUserInfoPattern = /https?:\/\/[^/\s@]+@/i;
  if (residualCredentialPattern.test(sanitized)
    || residualSensitiveUrlPattern.test(sanitized)
    || residualAuthSchemePattern.test(sanitized)
    || residualUserInfoPattern.test(sanitized)) {
    return { safe: false, value: '' };
  }
  return { safe: true, value: sanitized };
}

export default PublicPaperService;
