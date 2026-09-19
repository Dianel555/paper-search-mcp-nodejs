import {
  extractPublicAccessCandidates,
  isPermissionRestrictedPage
} from './PublicAccessDiscovery.js';
import {
  hasSensitiveCandidateCredentials,
  isSensitiveOutboundTarget
} from '../retrieval/OutboundSecurityPolicy.js';
import { isIP } from 'node:net';
import { isPublicAddress } from '../utils/PublicNetwork.js';
import type {
  FiniteDocument,
  RetrievalOperationContext,
  RetrievalPurpose,
  RetrievalResponse,
  RetrievalStrategy,
  RetrievalTransportProfile,
  RetrievalEntrypointProfile,
  AccessArtifact
} from '../retrieval/types.js';
import type { RetrievalStrategyStep } from '../retrieval/RetrievalService.js';
import { retrievalFailureKindForAbort } from '../retrieval/abortDiagnostics.js';

export type PublicPageFallbackState =
  | 'candidate'
  | 'restricted'
  | 'not_found'
  | 'target_error'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'failed';

export interface PublicPageFallbackResult {
  readonly state: PublicPageFallbackState;
  readonly candidates: readonly AccessArtifact[];
  readonly candidateCount: number;
  readonly response?: RetrievalResponse;
  readonly error?: unknown;
}

export interface PublicPageFallbackService {
  retrieveWithStrategies?(
    steps: readonly RetrievalStrategyStep[],
    context?: RetrievalOperationContext,
    options?: {
      readonly maxPaidStrategySelections?: number;
      readonly maxBrowserDispatches?: number;
      readonly scopeId?: string;
    }
  ): Promise<RetrievalResponse>;
  getProcessStatus(): {
    readonly enabled: boolean;
    readonly browserAllowed: boolean;
    readonly residentialAllowed?: boolean;
    readonly availableProxyTypes?: readonly ('datacenter' | 'residential')[];
    readonly authorizedCorpusAllowed?: boolean;
    readonly authorizedCorpusPlatforms?: readonly string[];
  };
}

export interface PublicPageFallbackOptions {
  readonly service: PublicPageFallbackService;
  readonly url: string;
  readonly purpose: Extract<RetrievalPurpose, 'publisher_discovery' | 'scholar_search' | 'scihub_lookup'>;
  readonly platform: 'publisher' | 'googlescholar' | 'scihub';
  readonly operation: RetrievalOperationContext;
  readonly transportProfile?: RetrievalTransportProfile;
  readonly entrypointProfile?: RetrievalEntrypointProfile;
  readonly authorizedCorpus?: boolean;
  readonly validateCandidate?: (url: string) => Promise<unknown>;
}

/**
 * One bounded direct-first page/candidate reducer shared by the three public
 * platform entrypoints. It never downloads or writes a PDF.
 */
export async function discoverPublicPage(
  options: PublicPageFallbackOptions
): Promise<PublicPageFallbackResult> {
  const plans = paidPlans(options.service.getProcessStatus(), options.platform);
  if (!options.service.retrieveWithStrategies) {
    return { state: 'provider_unavailable', candidates: [], candidateCount: 0 };
  }

  const request = (strategy: RetrievalStrategy, proxyType: 'datacenter' | 'residential' = 'datacenter') => ({
    url: options.url,
    purpose: options.purpose,
    strategy,
    proxyType,
    documentFormat: 'html_with_iframes' as const,
    ...(options.transportProfile ? { transportProfile: options.transportProfile } : {}),
    ...(options.entrypointProfile ? { entrypointProfile: options.entrypointProfile } : {}),
    signal: options.operation.signal
  });
  const directStep: RetrievalStrategyStep = {
    request: request('direct'),
    isTerminalResponse: response => isTerminalPage(response, options.authorizedCorpus === true, true),
    continueOnError: error => isRecoverableError(error, options.operation)
  };
  const paidSteps: RetrievalStrategyStep[] = plans.map(plan => ({
    request: request(plan.strategy, plan.proxyType),
    isTerminalResponse: response => isTerminalPage(response, false, false),
    continueOnError: error => isRecoverableError(error, options.operation),
    shouldAttempt: state => {
      if (state.previousResponse) {
        const status = state.previousResponse.targetStatus ?? state.previousResponse.document?.targetStatus;
        if (status === 429 || isRestrictedResponse(state.previousResponse)) return options.authorizedCorpus === true;
      }
      return true;
    }
  }));

  const steps = [directStep, ...paidSteps];
  try {
    const response = await options.service.retrieveWithStrategies(steps, options.operation, {
      maxPaidStrategySelections: options.platform === 'scihub' ? 3 : 4,
      maxBrowserDispatches: options.platform === 'scihub' ? 1 : 2,
      scopeId: `${options.platform}\u0000${options.url}`
    });
    return await classifyResponse(response, options);
  } catch (error) {
    return {
      state: errorState(error, options.operation),
      candidates: [],
      candidateCount: 0,
      error
    };
  }
}

async function classifyResponse(
  response: RetrievalResponse,
  options: PublicPageFallbackOptions
): Promise<PublicPageFallbackResult> {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  if (targetStatus === 429) return { state: 'rate_limited', candidates: [], candidateCount: 0, response };
  if (targetStatus === 401 || targetStatus === 407 || targetStatus === 423 || isRestrictedResponse(response)) {
    return { state: 'restricted', candidates: [], candidateCount: 0, response };
  }
  if (targetStatus !== undefined && targetStatus >= 400 && targetStatus !== 404 && targetStatus !== 410) {
    return { state: 'target_error', candidates: [], candidateCount: 0, response };
  }
  const document = response.document;
  const rawCandidates = document ? extractPublicAccessCandidates(document) : [];
  const candidates = rawCandidates.filter(candidate => isSafeCandidate(candidate.url));
  const validated: AccessArtifact[] = [];
  for (const candidate of candidates) {
    // Candidate validation is deliberately best-effort and never turns an
    // untrusted observation into a network request. The downloader repeats it
    // at the selected-candidate boundary with the full PublicHttpClient policy.
    if (!options.validateCandidate) {
      validated.push(candidate);
      continue;
    }
    // This loop is synchronous in intent but validation is asynchronous; the
    // caller-facing result is assembled by validateCandidates below.
  }
  return finalizeCandidateResult(response, options, rawCandidates, candidates, validated);
}

async function finalizeCandidateResult(
  response: RetrievalResponse,
  options: PublicPageFallbackOptions,
  rawCandidates: readonly AccessArtifact[],
  candidates: readonly AccessArtifact[],
  initial: readonly AccessArtifact[]
): Promise<PublicPageFallbackResult> {
  let validated = [...initial];
  if (options.validateCandidate) {
    validated = [];
    for (const candidate of candidates.slice(0, 20)) {
      try {
        await options.validateCandidate(candidate.url);
        validated.push(candidate);
      } catch {
        // Invalid/private/credential-bearing candidates are observations only.
      }
    }
  }
  if (validated.length) {
    return {
      state: 'candidate',
      candidates: validated,
      candidateCount: rawCandidates.length,
      response
    };
  }
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  if (targetStatus === 404 || targetStatus === 410) {
    return { state: 'not_found', candidates: [], candidateCount: rawCandidates.length, response };
  }
  if (targetStatus !== undefined && targetStatus >= 400) {
    return { state: 'target_error', candidates: [], candidateCount: rawCandidates.length, response };
  }
  const pageText = response.document ? documentText(response.document) : '';
  if (pageText && /(?:not\s+found|no\s+such\s+(?:article|paper|record)|content\s+unavailable)/i.test(pageText)) {
    return { state: 'not_found', candidates: [], candidateCount: rawCandidates.length, response };
  }
  return { state: 'not_found', candidates: [], candidateCount: rawCandidates.length, response };
}

function isTerminalPage(response: RetrievalResponse, authorized: boolean, direct: boolean): boolean {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  if (targetStatus === 429) return true;
  if (targetStatus === 401 || targetStatus === 407 || targetStatus === 423) return direct ? !authorized : true;
  if (isRestrictedResponse(response)) return direct ? !authorized : true;
  if (response.document && extractPublicAccessCandidates(response.document).length > 0) return true;
  return false;
}

function isRestrictedResponse(response: RetrievalResponse): boolean {
  const document = response.document;
  if (!document || document.kind !== 'html') return false;
  const markup = [document.html, ...document.iframes.map(frame => frame.html)].join(' ');
  return isPermissionRestrictedPage(documentText(document), markup);
}

function documentText(document: FiniteDocument): string {
  return [document.html, ...document.iframes.map(frame => frame.html)].join(' ');
}

function isSafeCandidate(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && !hasSensitiveCandidateCredentials(value)
      && !isSensitiveOutboundTarget(value)
      && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isPrivateHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (value === 'localhost'
    || value === 'localhost.localdomain'
    || value === 'ip6-localhost'
    || value === 'metadata.google.internal'
    || value === 'metadata.google.com'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value.endsWith('.internal')) return true;
  return isIP(value) !== 0 && !isPublicAddress(value);
}

function errorState(error: unknown, operation: RetrievalOperationContext): PublicPageFallbackState {
  const candidate = error as { code?: string; targetStatus?: number } | undefined;
  if (isHardPermissionStatus(candidate?.targetStatus)) return 'restricted';
  if (candidate?.targetStatus === 429) return 'rate_limited';
  if (candidate?.code === 'security') return 'restricted';
  if (candidate?.code === 'configuration' || candidate?.code === 'budget' || candidate?.code === 'auth_or_credits_unknown') return 'provider_unavailable';
  if (candidate?.code === 'cancelled'
    || (operation.signal.aborted && retrievalFailureKindForAbort(operation.signal, operation) === 'cancelled')) return 'cancelled';
  if (candidate?.code === 'timeout'
    || operation.remainingMs() <= 0
    || retrievalFailureKindForAbort(operation.signal, operation) === 'operation_deadline') return 'deadline_exceeded';
  return 'provider_unavailable';
}

function isRecoverableError(error: unknown, operation: RetrievalOperationContext): boolean {
  if (operation.signal.aborted || operation.remainingMs() <= 0) return false;
  const candidate = error as { code?: string; targetStatus?: number } | undefined;
  if (isHardPermissionStatus(candidate?.targetStatus)) return false;
  return candidate?.code === 'network' || candidate?.code === 'server_error' || candidate?.code === 'detected' || candidate?.code === 'concurrency_limited' || candidate?.code === 'target_unavailable';
}

function isHardPermissionStatus(status: number | undefined): boolean {
  return status === 401 || status === 407 || status === 423;
}

type PaidPlan = { readonly strategy: 'static' | 'browser'; readonly proxyType: 'datacenter' | 'residential' };

function paidPlans(
  status: ReturnType<PublicPageFallbackService['getProcessStatus']>,
  platform: PublicPageFallbackOptions['platform']
): readonly PaidPlan[] {
  if (!status.enabled) return [];
  const proxyTypes = status.availableProxyTypes || ['datacenter'];
  const plans: PaidPlan[] = [];
  for (const proxyType of ['datacenter', 'residential'] as const) {
    if (platform === 'scihub' && proxyType === 'residential') continue;
    if (!proxyTypes.includes(proxyType)) continue;
    if (proxyType === 'residential' && status.residentialAllowed !== true) continue;
    plans.push({ strategy: 'static', proxyType });
    if (status.browserAllowed) plans.push({ strategy: 'browser', proxyType });
  }
  return plans;
}
