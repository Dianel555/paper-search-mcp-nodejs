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
  | 'scihub_lookup';

export type RetrievalStrategy = 'direct' | 'static' | 'browser';

export type RetrievalDocumentFormat = 'html' | 'html_with_iframes';

export type RetrievalProviderName = string;

export interface RetrievalRequest {
  readonly url: string;
  readonly purpose: RetrievalPurpose;
  readonly strategy: RetrievalStrategy;
  readonly documentFormat: RetrievalDocumentFormat;
  /** Internal query values for a business retrieval, never transport headers. */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly signal?: AbortSignal;
}

export interface RetrievalCapabilities {
  readonly html: boolean;
  readonly iframeDocuments: boolean;
  readonly pdfCandidates: boolean;
  readonly browser: boolean;
  readonly paid: boolean;
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
  readonly apiStatus?: number;
  readonly targetStatus?: number;
  readonly document?: FiniteDocument;
  readonly contentType?: string;
  readonly cost: RetrievalCostObservation;
}

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

export interface RetrievalOperationContext {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly cost: RetrievalCostController;
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
  readonly requestCount: number;
  readonly strategyCounts: Readonly<Record<RetrievalStrategy, number>>;
  readonly lastStrategy?: RetrievalStrategy;
  readonly lastApiStatus?: number;
  readonly lastTargetStatus?: number;
}
