import {
  validatePublicHttpUrl,
  type PublicUrlValidation,
  type PublicUrlValidationOptions
} from '../utils/PublicNetwork.js';

export type OutboundPurpose =
  | 'retrieval'
  | 'doi_resolution'
  | 'publisher_discovery'
  | 'scholar_search'
  | 'scihub_lookup'
  | 'scihub_download'
  | 'pdf_download'
  | 'pdf_probe';

export interface OutboundSecurityPolicyOptions extends PublicUrlValidationOptions {
  /** Test seam for the already-existing public-network validator. */
  validatePublicUrl?: (url: string) => Promise<PublicUrlValidation>;
}

export class OutboundSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundSecurityError';
  }
}

export class SensitiveOutboundTargetError extends OutboundSecurityError {
  constructor() {
    super('Sensitive or authorized targets are not allowed for public retrieval');
    this.name = 'SensitiveOutboundTargetError';
  }
}

/**
 * Composes public-network validation with the retrieval-purpose target rules.
 * The public validator is intentionally called only after the purpose check.
 */
export class OutboundSecurityPolicy {
  private readonly options: OutboundSecurityPolicyOptions;

  constructor(options: OutboundSecurityPolicyOptions = {}) {
    this.options = options;
  }

  async validate(url: string, _purpose: OutboundPurpose = 'retrieval'): Promise<PublicUrlValidation> {
    try {
      assertHttpUrl(url);
      if (isSensitiveOutboundTarget(url)) {
        throw new SensitiveOutboundTargetError();
      }

      if (this.options.validatePublicUrl) {
        return await this.options.validatePublicUrl(url);
      }
      return await validatePublicHttpUrl(url, this.options);
    } catch (error) {
      if (error instanceof OutboundSecurityError) throw error;
      throw new OutboundSecurityError(error instanceof Error ? error.message : 'Outbound target validation failed');
    }
  }
}

export function hasSensitiveCandidateCredentials(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  if (url.username || url.password) return true;
  const sensitiveKey = /^(?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt|bearer|auth(?:orization)?|api[_-]?key|client[_-]?secret|private[_-]?key|credential|password|secret|session(?:id)?|signature|sig|x-(?:amz|goog)-(?:credential|signature|security-token|expires)|policy|key-pair-id|code|oauth)$/i;
  return [...url.searchParams.keys()].some(key => sensitiveKey.test(key))
    || /(?:^|[&#?])(?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt|bearer|auth(?:orization)?|api[_-]?key|client[_-]?secret|credential|password|secret|session(?:id)?|signature|sig|oauth)(?:=|&|$)/i.test(url.hash);
}

export function isSensitiveOutboundTarget(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  const sensitiveHost =
    labels.some(label => /^(?:login|signin|sign-in|auth|sso|mfa|idp|account|institution|institutional)$/.test(label)) ||
    hostname === 'clarivate.com' || hostname.endsWith('.clarivate.com') ||
    hostname === 'webofscience.com' || hostname.endsWith('.webofscience.com');
  if (sensitiveHost) return true;

  const sensitivePath = url.pathname.split('/').some(segment =>
    /^(?:login|signin|sign-in|auth|sso|saml|oauth|authorize|authorization|mfa|account|institution|institutional-access)$/i.test(segment)
  );
  if (sensitivePath) return true;

  return [...url.searchParams.keys()].some(key =>
    /^(?:login|signin|sign-in|auth|sso|saml|oauth|authorize|authorization|mfa|account|institutional-access)$/i.test(key)
  );
}

function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundSecurityError('Only valid HTTP(S) URLs are allowed');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundSecurityError('Only HTTP(S) URLs are allowed');
  }
  if (url.username || url.password) {
    throw new OutboundSecurityError('URLs containing userinfo are not allowed');
  }
}

export default OutboundSecurityPolicy;
