export const DEFAULT_RETRIEVAL_BUDGET = 50;
export const DEFAULT_RETRIEVAL_REQUEST_LIMIT = 10;
export const DEFAULT_RETRIEVAL_CONCURRENCY = 1;
export const DEFAULT_ACCESS_DISCOVERY_MAX_ITEMS = 5;

export interface ScrapingAntRetrievalConfiguration {
  readonly apiKey?: string;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly paidEnabled: boolean;
  readonly browserAllowed: boolean;
  readonly maxCreditsPerOperation: number;
  readonly maxCreditsPerRequest: number;
  readonly maxConcurrency: number;
  readonly proxyType: 'datacenter';
  readonly configurationInvalid: boolean;
}

export interface RetrievalConfiguration {
  readonly scrapingAnt: ScrapingAntRetrievalConfiguration;
  readonly accessDiscoveryMaxItems: number;
  readonly warnings: readonly string[];
}

/** Parse retrieval controls without making configuration errors fatal to direct retrieval. */
export function parseRetrievalConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): RetrievalConfiguration {
  const warnings: string[] = [];
  const apiKey = normalizeSecret(environment.SCRAPINGANT_API_KEY);
  const enabled = isStrictTrue(environment.SCRAPINGANT_ENABLED);
  const browserAllowed = isStrictTrue(environment.SCRAPINGANT_ALLOW_BROWSER_ESCALATION);
  const invalidFields: string[] = [];

  const maxCreditsPerOperation = parsePositiveSafeInteger(
    environment.SCRAPINGANT_MAX_CREDITS_PER_OPERATION,
    DEFAULT_RETRIEVAL_BUDGET,
    'SCRAPINGANT_MAX_CREDITS_PER_OPERATION',
    invalidFields
  );
  const maxCreditsPerRequest = parsePositiveSafeInteger(
    environment.SCRAPINGANT_MAX_CREDITS_PER_REQUEST,
    DEFAULT_RETRIEVAL_REQUEST_LIMIT,
    'SCRAPINGANT_MAX_CREDITS_PER_REQUEST',
    invalidFields
  );
  const maxConcurrency = parseBoundedPositiveInteger(
    environment.SCRAPINGANT_MAX_CONCURRENCY,
    DEFAULT_RETRIEVAL_CONCURRENCY,
    1,
    16,
    'SCRAPINGANT_MAX_CONCURRENCY',
    invalidFields
  );

  const configuredProxy = environment.SCRAPINGANT_PROXY_TYPE?.trim().toLowerCase();
  if (configuredProxy && configuredProxy !== 'datacenter') {
    invalidFields.push('SCRAPINGANT_PROXY_TYPE');
    warnings.push('SCRAPINGANT_PROXY_TYPE must be datacenter; paid retrieval is disabled for unsupported proxy types');
  }

  for (const field of invalidFields) {
    if (field !== 'SCRAPINGANT_PROXY_TYPE') {
      warnings.push(`${field} is invalid; paid retrieval is disabled`);
    }
  }

  const configurationInvalid = invalidFields.length > 0;
  const paidEnabled = Boolean(apiKey && enabled && !configurationInvalid);
  const accessDiscoveryMaxItems = parseDiscoveryDefault(
    environment.ACCESS_DISCOVERY_MAX_ITEMS,
    warnings
  );

  return {
    scrapingAnt: {
      apiKey,
      configured: Boolean(apiKey),
      enabled,
      paidEnabled,
      browserAllowed: paidEnabled && browserAllowed,
      maxCreditsPerOperation,
      maxCreditsPerRequest,
      maxConcurrency,
      proxyType: 'datacenter',
      configurationInvalid
    },
    accessDiscoveryMaxItems,
    warnings
  };
}

export function isValidAccessDiscoveryMaxItems(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isStrictTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function parsePositiveSafeInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  invalidFields: string[]
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  invalidFields.push(field);
  return fallback;
}

function parseBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
  invalidFields: string[]
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value.trim());
  if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  invalidFields.push(field);
  return fallback;
}

function parseDiscoveryDefault(value: string | undefined, warnings: string[]): number {
  if (value === undefined || value.trim() === '') return DEFAULT_ACCESS_DISCOVERY_MAX_ITEMS;
  const parsed = Number(value.trim());
  if (isValidAccessDiscoveryMaxItems(parsed)) return parsed;
  warnings.push('ACCESS_DISCOVERY_MAX_ITEMS is invalid; using the safe default of 5');
  return DEFAULT_ACCESS_DISCOVERY_MAX_ITEMS;
}

export default parseRetrievalConfiguration;
