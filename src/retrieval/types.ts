/**
 * Provider-neutral contracts for bounded webpage retrieval.
 *
 * The request deliberately has no arbitrary headers, cookies, provider names,
 * or MCP controls. Provider-specific transport details stay behind the
 * provider boundary; only finite documents and safe observations cross it.
 */

export type RetrievalPurpose =
  | 'publisher_discovery'
  | 'scholar_search'
  | 'scihub_lookup'
  | 'other'
  | 'unknown';

export type RetrievalStrategy = 'direct' | 'static' | 'browser';
export type RetrievalProxyType = 'datacenter' | 'residential';
export type RetrievalDocumentFormat = 'html' | 'html_with_iframes';
export type RetrievalProviderName = string;

export type RetrievalCombinationId =
  | 'direct:datacenter'
  | 'static:datacenter'
  | 'browser:datacenter'
  | 'static:residential'
  | 'browser:residential';

/**
 * Immutable identity used for pricing, capability checks, dispatch and
 * diagnostics. Direct transport is intentionally only meaningful with the
 * datacenter proxy category.
 */
export interface RetrievalCombination {
  readonly id: RetrievalCombinationId;
  readonly strategy: RetrievalStrategy;
  readonly proxyType: RetrievalProxyType;
}

export interface RetrievalRequest {
  readonly url: string;
  readonly purpose: RetrievalPurpose;
  readonly strategy: RetrievalStrategy;
  /** Omitted legacy requests normalize to the datacenter category. */
  readonly proxyType?: RetrievalProxyType;
  readonly documentFormat: RetrievalDocumentFormat;
  /** Internal query values for a business retrieval, never transport headers. */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly signal?: AbortSignal;
  /** Internal, finite observation seam; never serialized to a transport. */
  readonly dispatchObserver?: RetrievalDispatchObserver;
}

export interface NormalizedRetrievalRequest extends Omit<RetrievalRequest, 'proxyType'> {
  readonly proxyType: RetrievalProxyType;
  readonly combination: RetrievalCombination;
}

export interface RetrievalCapabilities {
  readonly html: boolean;
  readonly iframeDocuments: boolean;
  readonly pdfCandidates: boolean;
  readonly browser: boolean;
  readonly paid: boolean;
  /**
   * Optional capability declaration for new providers. Missing means the
   * legacy provider supports datacenter only; it never implies residential.
   */
  readonly proxyTypes?: readonly RetrievalProxyType[];
  /** Optional finite purpose boundary for providers with narrower adapters. */
  readonly purposes?: readonly RetrievalPurpose[];
  /** Optional exact combination declaration; absent uses the fields above. */
  readonly combinations?: readonly RetrievalCombinationId[];
  /** True when the provider invokes dispatchObserver at its actual transport boundary. */
  readonly dispatchObservation?: boolean;
  /** True only when the provider uses context.withDispatchSlot for transport calls. */
  readonly transportSlotManagement?: boolean;
}

export function isRetrievalProxyType(value: unknown): value is RetrievalProxyType {
  return value === 'datacenter' || value === 'residential';
}

export function normalizeRetrievalCombination(
  strategy: unknown,
  proxyType: unknown = 'datacenter'
): RetrievalCombination | undefined {
  if (strategy !== 'direct' && strategy !== 'static' && strategy !== 'browser') return undefined;
  if (!isRetrievalProxyType(proxyType)) return undefined;
  if (strategy === 'direct' && proxyType !== 'datacenter') return undefined;
  const id = `${strategy}:${proxyType}` as RetrievalCombinationId;
  return { id, strategy, proxyType };
}

export function normalizeRetrievalRequest(request: RetrievalRequest): NormalizedRetrievalRequest | undefined {
  const combination = normalizeRetrievalCombination(request.strategy, request.proxyType);
  if (!combination) return undefined;
  return { ...request, proxyType: combination.proxyType, combination };
}

export type DocumentProvenance =
  | TrustedDirectDocumentSource
  | UnknownRemoteDocumentSource;

/** Only a PublicHttpClient final URL may authorize relative-link resolution. */
export interface TrustedDirectDocumentSource {
  readonly provenance: 'trusted_direct';
  readonly finalUrl: string;
}

/** Remote provider final provenance is intentionally not represented as a base. */
export interface UnknownRemoteDocumentSource {
  readonly provenance: 'unknown_remote';
  readonly submittedUrl: string;
}

export interface FiniteIframeDocument {
  readonly src: string;
  readonly html: string;
  readonly source: UnknownRemoteDocumentSource;
}

export interface FiniteDocument {
  readonly kind: 'html';
  readonly html: string;
  readonly iframes: readonly FiniteIframeDocument[];
  readonly source: DocumentProvenance;
  readonly targetStatus?: number;
}

export type RetrievalCostObservation =
  | { readonly known: true; readonly credits: number }
  | { readonly known: false; readonly credits: null; readonly reason?: string };

export interface RetrievalResponse {
  readonly provider: RetrievalProviderName;
  readonly strategy: RetrievalStrategy;
  /** Normalized for responses produced through RetrievalService. */
  readonly proxyType?: RetrievalProxyType;
  readonly combination?: RetrievalCombinationId;
  readonly apiStatus?: number;
  readonly targetStatus?: number;
  readonly document?: FiniteDocument;
  readonly contentType?: string;
  readonly cost: RetrievalCostObservation;
}

/** A finite, redacted observation at a local transport submission boundary. */
export type RetrievalDispatchResource = 'doi' | 'init' | 'page' | 'redirect' | 'pdf';

export interface RetrievalDispatchObservation {
  /** Stable process-local ID shared by dispatch and response observations. */
  readonly dispatchId: string;
  readonly role: 'target' | 'provider_api';
  readonly origin: string;
  readonly submittedAt: number;
  /** Finite resource classification for internal benchmark diagnostics. */
  readonly resource?: RetrievalDispatchResource;
  /** True when a caller still owns bounded response-body consumption. */
  readonly bodyPending?: boolean;
  /** Normalized strategy identity; never a URL or provider credential. */
  readonly combination?: RetrievalCombinationId;
  readonly status?: number;
  /** Safe transport-phase category for a failed dispatch. */
  readonly failureKind?: RetrievalFailureKind;
  /** Monotonic deadline derived from a validated Retry-After value. */
  readonly cooldownUntil?: number;
  /** True means this source is blocked until process restart. */
  readonly blocked?: boolean;
}

export interface RetrievalDispatchObserver {
  /** Must be synchronous so admission and dispatch cannot be separated by an await. */
  readonly onDispatch?: (observation: RetrievalDispatchObservation) => void;
  /** Receives only normalized status/cooldown data; raw headers never cross this boundary. */
  readonly onResponse?: (observation: RetrievalDispatchObservation) => void;
  /** Receives safe phase/status facts when a submitted transport fails. */
  readonly onError?: (observation: RetrievalDispatchObservation) => void;
}

export type RetrievalFailureKind =
  | 'transport_timeout'
  | 'scope_deadline'
  | 'operation_deadline'
  | 'cancelled'
  | 'response_body';

export type RetrievalErrorCode =
  | 'invalid_request'
  | 'auth_or_credits_unknown'
  | 'target_unavailable'
  | 'concurrency_limited'
  | 'detected'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'security'
  | 'configuration'
  | 'budget'
  | 'response_too_large'
  | 'document_limit'
  | 'provider_error';

export interface RetrievalErrorOptions {
  readonly code: RetrievalErrorCode;
  readonly message: string;
  readonly provider?: RetrievalProviderName;
  readonly status?: number;
  readonly apiStatus?: number;
  readonly targetStatus?: number;
  readonly retryable?: boolean;
  /** Safe transport-phase category; never contains provider text or config. */
  readonly failureKind?: RetrievalFailureKind;
  readonly cost?: RetrievalCostObservation;
  /** Internal late settlement for a transport that outlives cancellation. */
  readonly lateCost?: Promise<RetrievalCostObservation>;
}

/** Safe, structured provider error; raw response details are never retained. */
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  readonly provider?: RetrievalProviderName;
  readonly status?: number;
  readonly apiStatus?: number;
  readonly targetStatus?: number;
  readonly retryable: boolean;
  readonly failureKind?: RetrievalFailureKind;
  readonly cost?: RetrievalCostObservation;
  readonly lateCost?: Promise<RetrievalCostObservation>;

  constructor(options: RetrievalErrorOptions) {
    super(options.message);
    this.name = 'RetrievalError';
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.apiStatus = options.apiStatus;
    this.targetStatus = options.targetStatus;
    this.retryable = options.retryable ?? false;
    this.failureKind = options.failureKind;
    this.cost = options.cost;
    this.lateCost = options.lateCost;
  }
}

export interface AccessArtifact {
  readonly url: string;
  readonly method:
    | 'citation_pdf_url'
    | 'alternate_pdf'
    | 'pdf_anchor'
    | 'iframe_pdf';
  readonly source: DocumentProvenance;
}

export interface RetrievalCostReservation {
  readonly attemptId: string;
  readonly estimate: number;
  markDispatched(): boolean;
  /**
   * Undo only a local dispatch marker when a second admission boundary rejects
   * the request before transport submission. It must not be used after bytes
   * have been handed to a provider.
   */
  cancelBeforeTransport?(): boolean;
  release(): void;
}

export interface RetrievalCostSnapshot {
  readonly budget: number;
  readonly admissionUsed: number;
  readonly reservedCredits: number;
  readonly reportedCredits: number;
  readonly reportedCreditsKnown: boolean;
  readonly unknownCostAttempts: number;
  readonly paidClosed: boolean;
  readonly paidClosedReason?: string;
}

export interface RetrievalCostController {
  readonly budget: number;
  reserve(estimate: number): RetrievalCostReservation | null;
  settle(reservation: RetrievalCostReservation, observation: RetrievalCostObservation): void;
  reconcile?(reservation: RetrievalCostReservation, observation: RetrievalCostObservation): void;
  close(reason: string): void;
  snapshot(): RetrievalCostSnapshot;
}

export type RetrievalDispatchSlot = <T>(
  task: () => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

export interface RetrievalOperationContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly cost: RetrievalCostController;
  /** Optional process-local observation seam owned by the orchestration layer. */
  readonly dispatchObserver?: RetrievalDispatchObserver;
  /** Optional slot around one actual transport call, not source-queue waits. */
  readonly withDispatchSlot?: RetrievalDispatchSlot;
  remainingMs(): number;
}

export interface RetrievalProvider {
  readonly name: RetrievalProviderName;
  readonly capabilities: RetrievalCapabilities;
  retrieve(
    request: RetrievalRequest,
    context: RetrievalOperationContext
  ): Promise<RetrievalResponse>;
}

export interface RetrievalOperationDiagnostics extends RetrievalCostSnapshot {
  readonly operationId: string;
  /** Provider-attempt count retained for compatibility. */
  readonly requestCount: number;
  /** Count of locally observable underlying HTTP submissions, including redirects. */
  readonly httpDispatchCount?: number;
  readonly strategyCounts: Readonly<Record<RetrievalStrategy, number>>;
  readonly lastStrategy?: RetrievalStrategy;
  readonly lastApiStatus?: number;
  readonly lastTargetStatus?: number;
}
