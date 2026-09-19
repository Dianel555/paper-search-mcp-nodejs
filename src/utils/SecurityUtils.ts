/**
 * Security utilities for sanitizing and validating data
 * Provides comprehensive protection against security vulnerabilities
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Validate and sanitize a download path to prevent path traversal.
 *
 * Resolves the given path relative to `baseDir` (default: './downloads')
 * and rejects any resolved path that escapes the base directory.
 * MCP tool arguments are untrusted (LLM-controlled); this guard ensures
 * a malicious `savePath` like '../../etc' or an absolute system path
 * cannot be used to write outside the allowed download directory.
 *
 * After lexical resolve, also checks the real (on-disk) path via
 * `realpathSync` to defeat symlinks and Windows junctions that point
 * outside the base directory.
 *
 * @param input - User-supplied save path (may be undefined/empty)
 * @param baseDir - Allowed root directory (default: './downloads')
 * @returns { valid: boolean; sanitized: string; error?: string }
 *   `sanitized` is the resolved absolute path when valid.
 */
export function sanitizeDownloadPath(
  input?: string,
  baseDir: string = './downloads'
): { valid: boolean; sanitized: string; error?: string } {
  if (!input || typeof input !== 'string' || input.trim() === '') {
    return { valid: true, sanitized: path.resolve(baseDir) };
  }

  const trimmed = input.trim();

  // Reject null bytes / control characters outright.
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, sanitized: '', error: 'Path contains invalid control characters' };
  }

  const resolvedBase = path.resolve(baseDir);
  // Accept an already-resolved absolute path only when it remains inside the
  // configured base; this lets MCP validate once and pass the result inward.
  const resolvedTarget = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedBase, trimmed);

  // Lexical check: ensure the resolved target stays within the base directory.
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      valid: false,
      sanitized: '',
      error: `Path traversal detected: "${trimmed}" escapes the download directory`
    };
  }

  // Real-path check: resolve the nearest existing ancestor so a symlink or
  // junction in a not-yet-created target path cannot bypass containment.
  try {
    const realBase = fs.realpathSync.native(resolvedBase);
    let existingAncestor = resolvedTarget;
    while (!fs.existsSync(existingAncestor) && existingAncestor !== path.dirname(existingAncestor)) {
      existingAncestor = path.dirname(existingAncestor);
    }
    const realAncestor = fs.realpathSync.native(existingAncestor);
    const realRelative = path.relative(realBase, realAncestor);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      return {
        valid: false,
        sanitized: '',
        error: `Path traversal detected: "${trimmed}" resolves outside the download directory via symlink or junction`
      };
    }
  } catch {
    // If the base itself does not exist yet, the lexical containment check is
    // still enforced; callers create the already-validated directory later.
  }

  return { valid: true, sanitized: resolvedTarget };
}

/**
 * Sanitize a filename component derived from untrusted input (e.g. paperId).
 * Strips path separators and other filesystem-dangerous characters so the
 * result cannot escape the enclosing directory via '../' or absolute paths.
 */
export function sanitizeFilename(input: string): string {
  if (!input || typeof input !== 'string') return 'download';
  return input.replace(/[/\\]/g, '_').replace(/[<>:"|?*\x00-\x1F\x7F]/g, '_').trim() || 'download';
}

/**
 * Comprehensive request sanitization to remove sensitive data
 * @param config - Axios request configuration
 * @returns Sanitized configuration copy
 */
export function sanitizeRequest(config: any): any {
  if (!config) return config;

  // Deep clone to avoid mutating original
  let sanitized: any;
  try {
    sanitized = JSON.parse(JSON.stringify(config));
  } catch {
    // If JSON serialization fails, return redacted version
    return { __redacted: 'Failed to sanitize - potentially circular reference' };
  }

  // Sanitize headers
  if (sanitized.headers) {
    sanitized.headers = sanitizeHeaders(sanitized.headers);
  }

  // Sanitize URL parameters
  if (sanitized.params) {
    sanitized.params = sanitizeParams(sanitized.params);
  }

  // Sanitize request body
  if (sanitized.data) {
    sanitized.data = sanitizeBody(sanitized.data);
  }

  // Sanitize URL
  if (sanitized.url) {
    sanitized.url = sanitizeUrl(sanitized.url);
  }

  return sanitized;
}

/**
 * Sanitize headers to remove sensitive information
 */
export function sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
  if (!headers) return headers;

  const sanitized = { ...headers };

  // Patterns for sensitive headers (case-insensitive)
  const sensitivePatterns = [
    /^api[-_]?key$/i,
    /^x[-_]api[-_]key$/i,
    /^authorization$/i,
    /^auth$/i,
    /^secret$/i,
    /^password$/i,
    /^x[-_]apikey$/i,
    /^access[-_]token$/i,
    /^bearer$/i,
    /^x[-_]auth[-_]token$/i,
    /^cookie$/i,
    /^set[-_]cookie$/i,
    /^x[-_]csrf[-_]token$/i,
    /(?:^|[-_])(?:session|jwt|sso|saml)(?:[-_]|$)/i,
    /^x[-_]forwarded[-_]for$/i, // May contain IP
    /^referer$/i, // May contain sensitive URLs
    /^user[-_]agent$/i // May contain system info
  ];

  Object.keys(sanitized).forEach(key => {
    const lowerKey = key.toLowerCase();

    // Check against patterns
    if (sensitivePatterns.some(pattern => pattern.test(key))) {
      sanitized[key] = '***REDACTED***';
    }

    // Also check values that might contain tokens
    if (typeof sanitized[key] === 'string') {
      if (sanitized[key].match(/^(Bearer|Basic)\s+/i) ||
          sanitized[key].match(/^[a-zA-Z0-9_-]{20,}$/) || // Likely token
          sanitized[key].includes('session=') ||
          sanitized[key].includes('token=')) {
        sanitized[key] = '***REDACTED***';
      }
    }
  });

  return sanitized;
}

/**
 * Sanitize URL parameters
 */
export function sanitizeParams(params: Record<string, any>): Record<string, any> {
  if (!params) return params;

  const sanitized = { ...params };

  Object.keys(sanitized).forEach(key => {
    // Check for common sensitive parameter names without treating author as auth data.
    if (isSensitiveBodyKey(key)) {
      sanitized[key] = '***REDACTED***';
    }

    // Mask values that look like tokens
    if (typeof sanitized[key] === 'string' &&
        sanitized[key].match(/^[a-zA-Z0-9_-]{16,}$/)) {
      sanitized[key] = sanitized[key].substring(0, 4) + '***';
    }
  });

  return sanitized;
}

/**
 * Redact secrets from free-form text before it reaches logs or MCP output.
 * Keep this as the single text sanitizer used by all error/logging paths.
 */
export function sanitizeSensitiveText(value: unknown): string {
  return String(value)
    .replace(/([?&](?:x[-_]?api[-_]?key|api[-_]?key|apikey|token|secret|auth|key|session|jwt|sso|saml|signature|sig|credential|private|password|passcode)=)[^&#\s"'},;\]]*/gi, '$1***')
    .replace(/((?:["']?(?:cookie|set[-_]?cookie)["']?\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^,\r\n}]+)/gi, (match, prefix) => {
      const value = match.slice(prefix.length).trimStart();
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${prefix}${quote}***${quote}`;
    })
    .replace(/((?:["']?authorization["']?\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^,\r\n}]+)/gi, (match, prefix) => {
      const value = match.slice(prefix.length).trimStart();
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${prefix}${quote}***${quote}`;
    })
    .replace(/((?:["']?(?:x[-_]?api[-_]?key|api[-_]?key|apikey|auth|session|jwt|sso|saml|token|secret|signature|sig|credential|private|password|passcode|client[-_]?secret|refresh[-_]?token|access[-_]?token|proxy[-_]?authorization|private[-_]?key)["']?)\s*[:=]\s*["']?)[^\s,;}"']+/gi, '$1***')
    .replace(/((?:https?|socks\d?):\/\/)[^/\s@]+@/gi, '$1***@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;}"'\\]+/gi, '$1 ***');
}

function isSensitiveBodyKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
  // This is an explicit status value, not the API key itself.
  if (normalizedKey === 'apikeystatus') return false;
  if (/(?:password|passphrase|secret|token|apikey|private|cookie|session|jwt|sso|saml)/i.test(normalizedKey)) {
    return true;
  }
  return /^(?:auth|oauth|authorization|authentication|basicauth|basic|bearer)(?:header|key|token|secret|credential|credentials|value)?$/i.test(normalizedKey) ||
    /^(?:credential|credentials)$/i.test(normalizedKey);
}

/**
 * Sanitize request body
 */
export function sanitizeBody(body: any): any {
  if (!body) return body;

  // For objects, recursively sanitize
  if (typeof body === 'object' && body !== null) {
    // Handle arrays
    if (Array.isArray(body)) {
      return body.map(item => sanitizeBody(item));
    }

    // Handle objects
    const sanitized: any = {};
    for (const [key, value] of Object.entries(body)) {
      const lowerKey = key.toLowerCase();

      // PaperFactory keeps extra as a JSON string for compatibility. Parse it
      // as structured data here so text redaction cannot damage its escaping.
      if (lowerKey === 'extra' && typeof value === 'string') {
        try {
          sanitized[key] = JSON.stringify(sanitizeBody(JSON.parse(value)));
          continue;
        } catch {
          // Treat non-JSON extra values as ordinary strings below.
        }
      }

      // `requiresApiKey` is a typed capability flag, not a credential value.
      // Preserve it so status compatibility does not turn false into a string.
      const isTypedCapabilityFlag = lowerKey === 'requiresapikey' && typeof value === 'boolean';
      // Check for sensitive keys without treating bibliographic "authors" as auth data.
      if (isSensitiveBodyKey(lowerKey) && !isTypedCapabilityFlag) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = sanitizeBody(value);
      }
    }
    return sanitized;
  }

  // Structured values retain their type and exact contents unless their key
  // provides credential context; paper identifiers may be long hashes.
  if (typeof body === 'string') {
    return sanitizeSensitiveText(body);
  }

  return body;
}

/**
 * Sanitize URL to remove sensitive query parameters
 */
export function sanitizeUrl(url: string): string {
  if (!url) return url;

  try {
    const urlObj = new URL(url);
    let hasSensitiveParams = Boolean(urlObj.username || urlObj.password);
    urlObj.username = '';
    urlObj.password = '';

    // Remove sensitive query parameters
    for (const [key] of urlObj.searchParams) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
      if (isSensitiveBodyKey(key) || normalizedKey === 'key') {
        urlObj.searchParams.set(key, '***REDACTED***');
        hasSensitiveParams = true;
      }
    }

    // If we modified parameters, add indicator
    if (hasSensitiveParams) {
      return urlObj.toString() + '#sanitized';
    }

    return url;
  } catch {
    // If URL parsing fails, mask the entire URL
    return '***REDACTED_URL***';
  }
}

/**
 * Validate and sanitize a DOI string
 */
export function sanitizeDoi(doi: string): { valid: boolean; sanitized: string; error?: string } {
  if (!doi || typeof doi !== 'string') {
    return { valid: false, sanitized: '', error: 'DOI must be a non-empty string' };
  }

  // Remove whitespace and common prefixes
  let sanitized = doi.trim();

  // Remove common DOI URL prefixes
  const prefixes = [
    'https://doi.org/',
    'http://doi.org/',
    'https://dx.doi.org/',
    'http://dx.doi.org/',
    'doi:',
    'DOI:'
  ];

  for (const prefix of prefixes) {
    if (sanitized.toLowerCase().startsWith(prefix.toLowerCase())) {
      sanitized = sanitized.substring(prefix.length);
      break;
    }
  }

  // Reject control characters (including NUL, CR, LF) before regex matching.
  if (/[\x00-\x1F\x7F]/.test(sanitized)) {
    return { valid: false, sanitized: '', error: 'DOI contains control characters' };
  }

  // Basic DOI format validation
  // DOI should start with "10." followed by digits and then any characters
  const doiPattern = /^10\.\d{4,}(\.\d+)*\/\S+$/;

  if (!doiPattern.test(sanitized)) {
    return { valid: false, sanitized: '', error: 'Invalid DOI format' };
  }

  // Additional safety checks
  if (sanitized.length > 256) {
    return { valid: false, sanitized: '', error: 'DOI too long (max 256 characters)' };
  }

  // Check for suspicious patterns
  if (sanitized.includes('<') || sanitized.includes('>') ||
      sanitized.includes('"') || sanitized.includes("'")) {
    return { valid: false, sanitized: '', error: 'DOI contains invalid characters' };
  }

  return { valid: true, sanitized: sanitized };
}

/**
 * Escape query value for different contexts
 */
export function escapeQueryValue(
  value: string,
  context: 'springer' | 'wos' | 'general' = 'general'
): string {
  if (!value) return '';

  // Remove null bytes and control characters
  let escaped = value.replace(/[\x00-\x1F\x7F]/g, '');

  switch (context) {
    case 'springer':
      escaped = escaped
        .replace(/"/g, '\\"')  // Escape quotes
        .replace(/[()]/g, '')   // Remove parentheses
        .replace(/;/g, '')      // Remove semicolons
        .replace(/\/\*/g, '')   // Remove SQL comment start
        .replace(/\*\//g, '');  // Remove SQL comment end
      break;
    case 'wos':
      // For WoS, only remove quotes and parentheses if not user-provided field query
      if (!escaped.includes('TS=') && !escaped.includes('TI=') &&
          !escaped.includes('AU=') && !escaped.includes('SO=')) {
        escaped = escaped
          .replace(/"/g, '')     // Remove quotes
          .replace(/[()]/g, '')  // Remove parentheses
          .trim();
      }
      break;
    default:
      escaped = escaped
        .replace(/["<>]/g, '')  // Remove quotes and angle brackets
        .replace(/\/\/+/g, '')  // Remove multiple slashes
        .trim();
  }

  // Length limit to prevent DoS
  if (escaped.length > 200) {
    escaped = escaped.substring(0, 200);
  }

  return escaped.trim();
}

/**
 * Validate query complexity to prevent DoS
 */
export function validateQueryComplexity(
  query: string,
  options: { maxLength?: number; maxBooleanOperators?: number } = {}
): { valid: boolean; error?: string } {
  const maxLength = options.maxLength || 1000;
  const maxBooleanOperators = options.maxBooleanOperators || 10;

  if (!query) return { valid: true };

  // Check length
  if (query.length > maxLength) {
    return {
      valid: false,
      error: `Query too long (max ${maxLength} characters)`
    };
  }

  // Count boolean operators
  const booleanOperators = query.match(/\b(AND|OR|NOT)\b/gi) || [];
  if (booleanOperators.length > maxBooleanOperators) {
    return {
      valid: false,
      error: `Query too complex (max ${maxBooleanOperators} boolean operators)`
    };
  }

  // Check for potential injection patterns
  const injectionPatterns = [
    /;\s*(drop|delete|update|insert|exec|union)/i,
    /\/\*.*\*\//s,  // SQL comments
    /\/\/.*/,       // Line comments
    /\b(select|insert|update|delete|drop|create|alter|exec|execute|union)\b.*\b(from|where|and|or)\b/i,
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/  // Control characters
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(query)) {
      return {
        valid: false,
        error: 'Query contains potentially dangerous patterns'
      };
    }
  }

  return { valid: true };
}

/**
 * Create a timeout wrapper for promises
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message?: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message || `Operation timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Generate a correlation ID for request tracking
 */
export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Mask sensitive data in strings
 */
export function maskSensitiveData(str: string): string {
  if (!str || str.length < 8) return '***';

  const visibleChars = Math.min(4, Math.floor(str.length / 4));
  return str.substring(0, visibleChars) +
         '*'.repeat(str.length - visibleChars * 2) +
         str.substring(str.length - visibleChars);
}

/**
 * Check if a string looks like an API key or token
 */
export function looksLikeToken(str: string): boolean {
  if (!str || typeof str !== 'string') return false;

  // Common token patterns
  const tokenPatterns = [
    /^[a-zA-Z0-9_-]{20,}$/,           // Long alphanumeric
    /^Bearer\s+[a-zA-Z0-9_-]+$/,      // Bearer token
    /^Basic\s+[A-Za-z0-9+/=]+$/,      // Basic auth
    /^[0-9a-f]{32,}$/i,                // Hex token
    /^[A-Za-z0-9+/]{20,}={0,2}$/       // Base64-like
  ];

  return tokenPatterns.some(pattern => pattern.test(str));
}

export default {
  sanitizeDownloadPath,
  sanitizeFilename,
  sanitizeRequest,
  sanitizeHeaders,
  sanitizeParams,
  sanitizeBody,
  sanitizeSensitiveText,
  sanitizeUrl,
  sanitizeDoi,
  escapeQueryValue,
  validateQueryComplexity,
  withTimeout,
  generateCorrelationId,
  maskSensitiveData,
  looksLikeToken
};