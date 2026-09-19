export const PUBLIC_PAPER_PLATFORMS = ['publisher', 'googlescholar', 'scihub'] as const;
export type PublicPaperPlatform = typeof PUBLIC_PAPER_PLATFORMS[number];

export const PUBLIC_DOWNLOAD_STATUSES = [
  'downloaded',
  'reference_unavailable',
  'restricted',
  'not_found',
  'provider_unavailable',
  'cancelled',
  'deadline_exceeded',
  'destination_exists',
  'failed'
] as const;
export type PublicDownloadStatus = typeof PUBLIC_DOWNLOAD_STATUSES[number];

export const MARKDOWN_STATUSES = [
  'ok',
  'reference_unavailable',
  'restricted',
  'target_error',
  'provider_unavailable',
  'cancelled',
  'deadline_exceeded',
  'failed'
] as const;
export type MarkdownStatus = typeof MARKDOWN_STATUSES[number];

export const DIAGNOSTIC_PHASES = ['reference', 'discovery', 'provider', 'markdown', 'download'] as const;
export type PublicDiagnosticPhase = typeof DIAGNOSTIC_PHASES[number];

export const DIAGNOSTIC_REASONS = [
  'ok',
  'downloaded',
  'reference_missing',
  'reference_expired',
  'reference_ambiguous',
  'restricted_target',
  'target_status_missing',
  'target_http_error',
  'target_rate_limited',
  'provider_api_error',
  'provider_unavailable',
  'budget_closed',
  'candidate_not_found',
  'pdf_mime_mismatch',
  'pdf_magic_mismatch',
  'pdf_resource_limit',
  'download_failed',
  'destination_exists',
  'no_clobber_unsupported',
  'sensitive_content',
  'empty_content',
  'invalid_content',
  'cancelled',
  'deadline_exceeded'
] as const;
export type PublicDiagnosticReason = typeof DIAGNOSTIC_REASONS[number];

export interface PublicPaperCost {
  readonly attempted: boolean;
  readonly known: boolean;
  readonly credits: number | null;
}

export interface PublicPaperDiagnostics {
  readonly phase: PublicDiagnosticPhase;
  readonly reason: PublicDiagnosticReason;
  readonly apiStatus: number | null;
  readonly targetStatus: number | null;
  readonly strategy: 'direct' | 'static' | 'browser' | null;
  readonly candidateCount: number;
}

export interface PublicDownloadResult {
  readonly platform: PublicPaperPlatform;
  readonly normalizedPaperId: string;
  readonly status: PublicDownloadStatus;
  readonly diagnostics: PublicPaperDiagnostics;
  readonly cost: PublicPaperCost;
  readonly filePath?: string;
}

export interface PaperMarkdownResult {
  readonly platform: PublicPaperPlatform;
  readonly normalizedPaperId: string;
  readonly status: MarkdownStatus;
  readonly diagnostics: PublicPaperDiagnostics;
  readonly cost: PublicPaperCost;
  readonly markdown?: string;
  readonly untrusted?: true;
}

export function noProviderCost(): PublicPaperCost {
  return { attempted: false, known: true, credits: 0 };
}

export function knownProviderCost(credits: number): PublicPaperCost {
  return { attempted: true, known: true, credits };
}

export function unknownProviderCost(): PublicPaperCost {
  return { attempted: true, known: false, credits: null };
}

export function diagnostics(
  phase: PublicDiagnosticPhase,
  reason: PublicDiagnosticReason,
  values: Partial<Omit<PublicPaperDiagnostics, 'phase' | 'reason'>> = {}
): PublicPaperDiagnostics {
  return {
    phase,
    reason,
    apiStatus: values.apiStatus ?? null,
    targetStatus: values.targetStatus ?? null,
    strategy: values.strategy ?? null,
    candidateCount: Number.isSafeInteger(values.candidateCount) && (values.candidateCount as number) >= 0
      ? values.candidateCount as number
      : 0
  };
}
