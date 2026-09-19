import type { RetrievalPurpose } from './types.js';

export const DEFAULT_RETRIEVAL_BUDGET = 50;
export const DEFAULT_RETRIEVAL_REQUEST_LIMIT = 10;
export const DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET = 500;
export const DEFAULT_RESIDENTIAL_RETRIEVAL_REQUEST_LIMIT = 125;
export const DEFAULT_RETRIEVAL_CONCURRENCY = 1;
export const DEFAULT_ACCESS_DISCOVERY_MAX_ITEMS = 5;

export interface RetrievalBudgetDefaults {
  readonly maxCreditsPerOperation: number;
  readonly maxCreditsPerRequest: number;
}

export type AuthorizedCorpusPlatform = 'publisher' | 'googlescholar' | 'scihub';

export interface ScrapingAntRetrievalConfiguration {
  readonly apiKey?: string;
  readonly configured: boolean;
  readonly authorizedCorpusAllowed: boolean;
  readonly authorizedCorpusPlatforms: readonly AuthorizedCorpusPlatform[];
  readonly enabled: boolean;
  readonly paidEnabled: boolean;
  readonly browserAllowed: boolean;
  /** Explicit residential authorization is independent from the API key. */
  readonly residentialAllowed: boolean;
  readonly maxCreditsPerOperation: number;
  readonly maxCreditsPerRequest: number;
  readonly budgetDefaults: Readonly<Record<RetrievalPurpose, RetrievalBudgetDefaults>>;
  readonly maxConcurrency: number;
  /** Configured proxy ceiling, not the proxy used by every request. */
  readonly proxyType: 'datacenter' | 'residential';
  /** Combinations that can be generated before provider capability checks. */
  readonly availableProxyTypes: readonly ('datacenter' | 'residential')[];
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
  const residentialAllowed = isStrictTrue(environment.SCRAPINGANT_ALLOW_RESIDENTIAL);
  const authorizedCorpusAllowed = isStrictTrue(environment.SCRAPINGANT_ALLOW_AUTHORIZED_CORPUS);
  const authorizedCorpusPlatforms = parseAuthorizedCorpusPlatforms(
    environment.SCRAPINGANT_AUTHORIZED_CORPUS_PLATFORMS,
    warnings
  );
  const invalidFields: string[] = [];

  const explicitOperationBudget = parseOptionalPositiveSafeInteger(
    environment.SCRAPINGANT_MAX_CREDITS_PER_OPERATION,
    'SCRAPINGANT_MAX_CREDITS_PER_OPERATION',
    invalidFields
  );
  const explicitRequestLimit = parseOptionalPositiveSafeInteger(
    environment.SCRAPINGANT_MAX_CREDITS_PER_REQUEST,
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
  let proxyType: 'datacenter' | 'residential' = 'datacenter';
  if (configuredProxy) {
    if (configuredProxy === 'datacenter' || configuredProxy === 'residential') {
      proxyType = configuredProxy;
    } else {
      invalidFields.push('SCRAPINGANT_PROXY_TYPE');
      warnings.push('SCRAPINGANT_PROXY_TYPE must be datacenter or residential; paid retrieval is disabled for unsupported proxy types');
    }
  }
  if (proxyType === 'residential' && !residentialAllowed) {
    invalidFields.push('SCRAPINGANT_ALLOW_RESIDENTIAL');
    warnings.push('Residential proxy selection requires SCRAPINGANT_ALLOW_RESIDENTIAL=true; paid retrieval is disabled');
  }

  for (const field of invalidFields) {
    if (field !== 'SCRAPINGANT_PROXY_TYPE' && field !== 'SCRAPINGANT_ALLOW_RESIDENTIAL') {
      warnings.push(`${field} is invalid; paid retrieval is disabled`);
    }
  }

  const budgetDefaults = createBudgetDefaults(residentialAllowed, explicitOperationBudget, explicitRequestLimit);
  const configurationInvalid = invalidFields.length > 0;
  const paidEnabled = Boolean(apiKey && enabled && !configurationInvalid);
  const availableProxyTypes = proxyType === 'residential' && residentialAllowed
    ? ['datacenter', 'residential'] as const
    : ['datacenter'] as const;
  const accessDiscoveryMaxItems = parseDiscoveryDefault(
    environment.ACCESS_DISCOVERY_MAX_ITEMS,
    warnings
  );

  return {
    scrapingAnt: {
      apiKey,
      configured: Boolean(apiKey),
      authorizedCorpusAllowed,
      authorizedCorpusPlatforms,
      enabled,
      paidEnabled,
      browserAllowed: paidEnabled && browserAllowed,
      residentialAllowed,
      maxCreditsPerOperation: budgetDefaults.unknown.maxCreditsPerOperation,
      maxCreditsPerRequest: budgetDefaults.unknown.maxCreditsPerRequest,
      budgetDefaults,
      maxConcurrency,
      proxyType,
      availableProxyTypes,
      configurationInvalid
    },
    accessDiscoveryMaxItems,
    warnings
  };
}

export function getRetrievalBudgetDefaults(
  configuration: RetrievalConfiguration,
  purpose: RetrievalPurpose = 'unknown'
): RetrievalBudgetDefaults {
  return configuration.scrapingAnt.budgetDefaults[purpose]
    || configuration.scrapingAnt.budgetDefaults.unknown;
}

function createBudgetDefaults(
  residentialAllowed: boolean,
  explicitOperationBudget: number | undefined,
  explicitRequestLimit: number | undefined
): Readonly<Record<RetrievalPurpose, RetrievalBudgetDefaults>> {
  const publisherScholar: RetrievalBudgetDefaults = {
    maxCreditsPerOperation: explicitOperationBudget ?? (residentialAllowed ? DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET : DEFAULT_RETRIEVAL_BUDGET),
    maxCreditsPerRequest: explicitRequestLimit ?? (residentialAllowed ? DEFAULT_RESIDENTIAL_RETRIEVAL_REQUEST_LIMIT : DEFAULT_RETRIEVAL_REQUEST_LIMIT)
  };
  const conservative: RetrievalBudgetDefaults = {
    maxCreditsPerOperation: explicitOperationBudget ?? DEFAULT_RETRIEVAL_BUDGET,
    maxCreditsPerRequest: explicitRequestLimit ?? DEFAULT_RETRIEVAL_REQUEST_LIMIT
  };
  return {
    publisher_discovery: publisherScholar,
    scholar_search: publisherScholar,
    scihub_lookup: conservative,
    other: conservative,
    unknown: conservative
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

function parseOptionalPositiveSafeInteger(
  value: string | undefined,
  field: string,
  invalidFields: string[]
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.trim());
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  invalidFields.push(field);
  return undefined;
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

function parseAuthorizedCorpusPlatforms(
  value: string | undefined,
  warnings: string[]
): readonly AuthorizedCorpusPlatform[] {
  if (value === undefined || value.trim() === '') return [];
  const supported = new Set<AuthorizedCorpusPlatform>(['publisher', 'googlescholar', 'scihub']);
  const platforms: AuthorizedCorpusPlatform[] = [];
  let hadInvalid = false;
  for (const token of value.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)) {
    if (!supported.has(token as AuthorizedCorpusPlatform)) {
      hadInvalid = true;
      continue;
    }
    if (!platforms.includes(token as AuthorizedCorpusPlatform)) platforms.push(token as AuthorizedCorpusPlatform);
  }
  if (hadInvalid) warnings.push('SCRAPINGANT_AUTHORIZED_CORPUS_PLATFORMS contains unsupported platform tokens; they were ignored');
  return platforms;
}

export function isAuthorizedCorpusPlatform(
  configuration: RetrievalConfiguration,
  platform: string
): platform is AuthorizedCorpusPlatform {
  return configuration.scrapingAnt.authorizedCorpusAllowed
    && configuration.scrapingAnt.authorizedCorpusPlatforms.includes(platform as AuthorizedCorpusPlatform);
}

function parseDiscoveryDefault(value: string | undefined, warnings: string[]): number {
  if (value === undefined || value.trim() === '') return DEFAULT_ACCESS_DISCOVERY_MAX_ITEMS;
  const parsed = Number(value.trim());
  if (isValidAccessDiscoveryMaxItems(parsed)) return parsed;
  warnings.push('ACCESS_DISCOVERY_MAX_ITEMS is invalid; using the safe default of 5');
  return DEFAULT_ACCESS_DISCOVERY_MAX_ITEMS;
}

export default parseRetrievalConfiguration;
