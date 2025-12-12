/**
 * Application constants and configuration
 * Centralized configuration for timeouts, limits, and other settings
 */

/**
 * API Timeout Configuration (in milliseconds)
 */
export const TIMEOUTS = {
  /** Default timeout for API requests */
  DEFAULT: 30000,
  /** Extended timeout for slow APIs */
  EXTENDED: 60000,
  /** Short timeout for health checks */
  HEALTH_CHECK: 10000,
  /** Timeout for PDF downloads */
  DOWNLOAD: 120000,
  /** Timeout for batch operations */
  BATCH: 90000,
  /** Timeout buffer for withTimeout wrapper */
  BUFFER: 5000
} as const;

/**
 * Rate Limiting Configuration
 */
export const RATE_LIMITS = {
  /** Default requests per second */
  DEFAULT_RPS: 1,
  /** Conservative requests per second */
  CONSERVATIVE_RPS: 0.5,
  /** Aggressive requests per second (for high-limit APIs) */
  AGGRESSIVE_RPS: 5,
  /** Default burst capacity */
  DEFAULT_BURST: 5
} as const;

/**
 * Search Limits
 */
export const SEARCH_LIMITS = {
  /** Default number of results */
  DEFAULT_RESULTS: 10,
  /** Maximum results per request */
  MAX_RESULTS: 100,
  /** Maximum query length */
  MAX_QUERY_LENGTH: 1000,
  /** Maximum boolean operators in query */
  MAX_BOOLEAN_OPERATORS: 10
} as const;

/**
 * API Endpoints
 */
export const API_ENDPOINTS = {
  CROSSREF: 'https://api.crossref.org/works',
  OPENCITATIONS: 'https://opencitations.net/index/coci/api/v1',
  WOS_STARTER: 'https://api.clarivate.com/apis/wos-starter',
  SPRINGER_META: 'https://api.springernature.com/meta/v2',
  SPRINGER_OA: 'https://api.springernature.com/openaccess',
  ELSEVIER: 'https://api.elsevier.com',
  SEMANTIC_SCHOLAR: 'https://api.semanticscholar.org/graph/v1',
  ARXIV: 'http://export.arxiv.org/api',
  PUBMED: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
  BIORXIV: 'https://api.biorxiv.org',
  MEDRXIV: 'https://api.medrxiv.org',
  WILEY_TDM: 'https://api.wiley.com/onlinelibrary/tdm/v1'
} as const;

/**
 * Default User Agent
 */
export const USER_AGENT = 'Paper-Search-MCP/1.0 (Academic Research Tool)';

/**
 * Default mailto for Crossref polite pool
 */
export const DEFAULT_MAILTO = process.env.CROSSREF_MAILTO || 'paper-search-mcp@example.com';

/**
 * DOI validation pattern
 */
export const DOI_PATTERN = /^10\.\d{4,}(\.\d+)*\/\S+$/;

/**
 * Maximum DOI length
 */
export const MAX_DOI_LENGTH = 256;

export default {
  TIMEOUTS,
  RATE_LIMITS,
  SEARCH_LIMITS,
  API_ENDPOINTS,
  USER_AGENT,
  DEFAULT_MAILTO,
  DOI_PATTERN,
  MAX_DOI_LENGTH
};
