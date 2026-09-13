/**
 * Web of Science integration.
 *
 * Starter and Expanded use separate internal clients because their URLs,
 * parameters, quotas, and response documents are not interchangeable. The
 * historical PaperSource facade remains the only platform module; response
 * parsing lives in services/WebOfScienceParser.ts and throttling/quotas use the
 * shared utils implementations.
 */

import { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, type SearchOptions, type DownloadOptions, type PlatformCapabilities } from './PaperSource.js';
import { CapabilityUnavailableError } from '../utils/CapabilityErrors.js';
import { ApiError } from '../utils/ErrorHandler.js';
import { QuotaManager, type QuotaReservation } from '../utils/QuotaManager.js';
import { type RateLimiter } from '../utils/RateLimiter.js';
import { PublicAccessDiscovery } from '../services/PublicAccessDiscovery.js';
import { type RetrievalProcessStatus, type RetrievalService } from '../retrieval/RetrievalService.js';
import { createRetrievalService } from '../retrieval/createRetrievalService.js';
import { isValidAccessDiscoveryMaxItems, parseRetrievalConfiguration } from '../retrieval/Configuration.js';
import { WebOfScienceRequestService, type WosHttpRequester } from '../services/WebOfScienceRequestService.js';
import { API_ENDPOINTS } from '../config/constants.js';
import {
  parseExpandedRecord,
  parseExpandedRecords,
  parseQueryResult,
  parseReferences,
  parseStarterRecord,
  type StarterRecord,
  type StarterResponse,
  type WosQueryResult,
  type WosRecordView,
  type WosReference,
  type WosRelation,
  type WosRelationResult
} from '../services/WebOfScienceParser.js';
import { escapeQueryValue, sanitizeDoi, validateQueryComplexity } from '../utils/SecurityUtils.js';

export type { WosRecordView, WosReference, WosRelation, WosRelationResult, WosQueryResult } from '../services/WebOfScienceParser.js';
export { CapabilityUnavailableError } from '../utils/CapabilityErrors.js';

export interface WoSSearchOptions extends SearchOptions {
  apiProduct?: 'starter' | 'expanded';
  recordView?: WosRecordView;
  discoverAccess?: boolean;
  discoverAccessMaxItems?: number;
  databaseId?: string;
  edition?: string;
  issn?: string;
  volume?: string;
  page?: string;
  issue?: string;
  documentTypes?: string[];
  languages?: string[];
  pmid?: string;
  doi?: string;
}

export interface WebOfScienceSearcherOptions {
  starterApiKey?: string;
  expandedApiKey?: string;
  httpClient?: WosHttpRequester;
  rateLimiter?: Pick<RateLimiter, 'waitForPermission' | 'getStatus'>;
  starterRateLimiter?: Pick<RateLimiter, 'waitForPermission' | 'getStatus'>;
  expandedRateLimiter?: Pick<RateLimiter, 'waitForPermission' | 'getStatus'>;
  quotaManager?: QuotaManager;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  retrievalService?: RetrievalService;
  publicAccessDiscovery?: PublicAccessDiscovery;
  expandedBaseUrl?: string;
}

export type ApiKeyValidationStatus = 'valid' | 'invalid' | 'unknown' | 'missing' | 'configured';

export interface WebOfScienceStatus {
  starter: ReturnType<StarterClient['getStatus']> & { apiKeyStatus: ApiKeyValidationStatus };
  expanded: ReturnType<ExpandedClient['getStatus']> & { apiKeyStatus: ApiKeyValidationStatus };
  scrapingAnt: RetrievalProcessStatus;
}

interface WosClientOptions {
  httpClient?: WosHttpRequester;
  rateLimiter?: Pick<RateLimiter, 'waitForPermission' | 'getStatus'>;
  quotaManager?: QuotaManager;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
}

/** Product-specific clients retain only endpoint and response-contract logic. */
abstract class WosClient {
  protected readonly requestService: WebOfScienceRequestService;
  protected readonly quotaManager: QuotaManager;

  protected constructor(
    apiKey: string | undefined,
    options: WosClientOptions,
    rateLimitEnv: string,
    defaultRps: number,
    quotaPlatform: string,
    quotaConfig: { dailyLimit: number; envPrefix?: string; envVar?: string }
  ) {
    this.quotaManager = options.quotaManager || QuotaManager.getInstance();
    this.requestService = new WebOfScienceRequestService({
      apiKey,
      httpClient: options.httpClient,
      rateLimiter: options.rateLimiter,
      requestsPerSecondEnv: rateLimitEnv,
      defaultRequestsPerSecond: defaultRps,
      quotaManager: this.quotaManager,
      quotaPlatform,
      quotaConfig,
      sleep: options.sleep,
      random: options.random,
      maxRetries: options.maxRetries
    });
  }

  isConfigured(): boolean {
    return this.requestService.isConfigured();
  }

  protected request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.requestService.request<T>(config);
  }

  protected getClientStatus(baseUrl: string) {
    return this.requestService.getStatus(baseUrl);
  }

  protected keyStatusFromError(error: any): ApiKeyValidationStatus {
    return this.requestService.getApiKeyStatus(error);
  }
}
interface StarterClientSearchOptions {
  maxResults?: number;
  databaseId?: string;
  edition?: string;
  year?: string;
  author?: string;
  journal?: string;
  issn?: string;
  volume?: string;
  page?: string;
  issue?: string;
  documentTypes?: string[];
  pmid?: string;
  doi?: string;
  sortBy?: 'relevance' | 'date' | 'citations';
  sortOrder?: 'asc' | 'desc';
}

class StarterClient extends WosClient {
  private readonly version: 'v1' | 'v2';
  private readonly baseUrl: string;

  constructor(apiKey: string | undefined, version: string, options: WosClientOptions) {
    const normalizedVersion = version.toLowerCase();
    if (normalizedVersion !== 'v1' && normalizedVersion !== 'v2') {
      throw new Error(`Unsupported Web of Science Starter API version: ${version}`);
    }
    super(apiKey, options, 'WOS_STARTER_RPS', 1, 'wos-starter', {
      dailyLimit: 50,
      envPrefix: 'WOS_STARTER'
    });
    this.version = normalizedVersion;
    this.baseUrl = `${API_ENDPOINTS.WOS_STARTER}/${this.version}`;
  }

  getVersion(): 'v1' | 'v2' {
    return this.version;
  }

  getStatus() {
    return { ...this.getClientStatus(this.baseUrl), version: this.version };
  }

  async search(query: string, options: StarterClientSearchOptions = {}): Promise<Paper[]> {
    this.requireKey();
    const maxResults = normalizeResultCount(options.maxResults, 100, 'Starter');
    const databaseId = options.databaseId || 'WOS';
    const pageSize = Math.min(maxResults, 50);
    const sortField = mapWosSortField(options.sortBy, options.sortOrder);
    const params: Record<string, string | number> = {
      q: buildWosQuery(query, options),
      db: databaseId,
      limit: pageSize,
      page: 1
    };
    if (options.edition) params.edition = options.edition;
    if (sortField) params.sortField = sortField;

    const papers: Paper[] = [];
    const seen = new Set<string>();
    let page = 1;
    while (papers.length < maxResults) {
      const papersBeforePage = papers.length;
      const response = await this.request<StarterResponse>({
        method: 'GET',
        url: `${this.baseUrl}/documents`,
        params: { ...params, page }
      });
      const data = response.data || {};
      const hits = Array.isArray(data.hits) ? data.hits : [];
      for (const record of hits) {
        if (!record?.uid || seen.has(record.uid)) continue;
        seen.add(record.uid);
        const paper = parseStarterRecord(record, databaseId, this.version);
        if (paper) papers.push(paper);
        if (papers.length >= maxResults) break;
      }

      const total = numberValue(data.metadata?.total);
      if (hits.length === 0 || papers.length >= maxResults || papers.length === papersBeforePage ||
          (total !== undefined && page * pageSize >= total) ||
          (total === undefined && hits.length < pageSize)) break;
      page++;
    }
    return papers.slice(0, maxResults);
  }

  async getByUid(uid: string): Promise<Paper | null> {
    this.requireKey();
    const response = await this.request<StarterRecord>({
      method: 'GET',
      url: `${this.baseUrl}/documents/${encodeURIComponent(uid)}`
    });
    return response.data?.uid ? parseStarterRecord(response.data, 'WOS', this.version) : null;
  }

  async getCitationCount(uid: string): Promise<number | undefined> {
    return (await this.getByUid(uid))?.citationCount;
  }

  async validateApiKeyStatus(): Promise<ApiKeyValidationStatus> {
    if (!this.isConfigured()) return 'missing';
    try {
      await this.search('TS=(test)', { maxResults: 1 });
      return 'valid';
    } catch (error) {
      return this.keyStatusFromError(error);
    }
  }

  private requireKey(): void {
    if (!this.isConfigured()) throw new Error('Web of Science Starter API key is required');
  }
}

interface ExpandedClientSearchOptions {
  maxResults?: number;
  firstRecord?: number;
  databaseId?: string;
  edition?: string;
  recordView?: WosRecordView;
  year?: string;
  author?: string;
  journal?: string;
  issn?: string;
  volume?: string;
  page?: string;
  issue?: string;
  documentTypes?: string[];
  pmid?: string;
  doi?: string;
  sortBy?: 'relevance' | 'date' | 'citations';
  sortOrder?: 'asc' | 'desc';
}

interface ExpandedRelationOptions {
  maxResults?: number;
  firstRecord?: number;
  recordView?: WosRecordView;
  databaseId?: string;
  edition?: string;
  sortBy?: 'relevance' | 'date' | 'citations';
  sortOrder?: 'asc' | 'desc';
}

class ExpandedClient extends WosClient {
  private readonly baseUrl: string;
  private readonly fullRecordQuota: QuotaManager;

  constructor(apiKey: string | undefined, options: WosClientOptions & { baseUrl?: string }) {
    super(apiKey, options, 'WOS_EXPANDED_RPS', 2, 'wos-expanded-requests', { dailyLimit: 0 });
    this.baseUrl = (options.baseUrl || process.env.WOS_EXPANDED_BASE_URL || API_ENDPOINTS.WOS_EXPANDED).replace(/\/$/, '');
    this.fullRecordQuota = options.quotaManager || QuotaManager.getInstance();
    this.fullRecordQuota.registerPlatform('wos-expanded-full-record', {
      dailyLimit: 0,
      envVar: 'WOS_EXPANDED_FULL_RECORD_BUDGET'
    });
  }

  getStatus() {
    return {
      ...this.getClientStatus(this.baseUrl),
      fullRecordBudget: this.fullRecordQuota.getStatus('wos-expanded-full-record')
    };
  }

  async search(query: string, options: ExpandedClientSearchOptions = {}): Promise<Paper[]> {
    this.requireKey();
    const count = normalizeResultCount(options.maxResults, 100, 'Expanded');
    const recordView = options.recordView || 'short';
    const databaseId = options.databaseId || 'WOS';
    const response = await this.requestExpanded('/', {
      databaseId,
      usrQuery: buildWosQuery(query, options),
      count,
      firstRecord: normalizeFirstRecord(options.firstRecord),
      optionView: recordView === 'full' ? 'FR' : 'SR',
      ...(options.edition ? { edition: options.edition } : {}),
      ...(mapWosSortField(options.sortBy, options.sortOrder) ? { sortField: mapWosSortField(options.sortBy, options.sortOrder) } : {})
    }, recordView, count);
    const queryResult = parseQueryResult(response.data);
    return parseExpandedRecords(response.data)
      .map(record => parseExpandedRecord(record, recordView, databaseId, queryResult))
      .filter((paper): paper is Paper => paper !== null);
  }

  async getByUid(uid: string, recordView: WosRecordView = 'short', databaseId = 'WOS'): Promise<Paper | null> {
    this.requireKey();
    const response = await this.requestExpanded(`/id/${encodeURIComponent(uid)}`, {
      databaseId,
      optionView: recordView === 'full' ? 'FR' : 'SR'
    }, recordView, 1);
    const queryResult = parseQueryResult(response.data);
    const record = parseExpandedRecords(response.data)[0];
    return record ? parseExpandedRecord(record, recordView, databaseId, queryResult) : null;
  }

  async getQueryRecords(queryId: string | number, options: ExpandedClientSearchOptions = {}): Promise<Paper[]> {
    this.requireKey();
    const count = normalizeResultCount(options.maxResults, 100, 'Expanded');
    const recordView = options.recordView || 'short';
    const databaseId = options.databaseId || 'WOS';
    const response = await this.requestExpanded(`/query/${encodeURIComponent(String(queryId))}`, {
      count,
      firstRecord: normalizeFirstRecord(options.firstRecord),
      optionView: recordView === 'full' ? 'FR' : 'SR',
      ...(mapWosSortField(options.sortBy, options.sortOrder) ? { sortField: mapWosSortField(options.sortBy, options.sortOrder) } : {})
    }, recordView, count);
    const queryResult = parseQueryResult(response.data);
    return parseExpandedRecords(response.data)
      .map(record => parseExpandedRecord(record, recordView, databaseId, queryResult))
      .filter((paper): paper is Paper => paper !== null);
  }

  async getReferences(uid: string, options: Omit<ExpandedRelationOptions, 'recordView'> = {}): Promise<WosRelationResult<WosReference>> {
    this.requireKey();
    const count = normalizeRelationCount(options.maxResults);
    const response = await this.requestExpanded('/references', {
      databaseId: options.databaseId || 'WOS',
      uniqueId: uid,
      count,
      firstRecord: normalizeFirstRecord(options.firstRecord),
      ...(mapWosSortField(options.sortBy, options.sortOrder) ? { sortField: mapWosSortField(options.sortBy, options.sortOrder) } : {})
    }, 'short', 0);
    return { queryResult: parseQueryResult(response.data), items: parseReferences(response.data) };
  }

  async getCiting(uid: string, options: ExpandedRelationOptions = {}): Promise<WosRelationResult<Paper>> {
    return this.getRelation('/citing', uid, options);
  }

  async getRelated(uid: string, options: ExpandedRelationOptions = {}): Promise<WosRelationResult<Paper>> {
    return this.getRelation('/related', uid, options);
  }

  async validateApiKeyStatus(): Promise<ApiKeyValidationStatus> {
    if (!this.isConfigured()) return 'missing';
    try {
      await this.search('TS=(test)', { maxResults: 1, recordView: 'short' });
      return 'valid';
    } catch (error) {
      return this.keyStatusFromError(error);
    }
  }

  private async getRelation(endpoint: '/citing' | '/related', uid: string, options: ExpandedRelationOptions): Promise<WosRelationResult<Paper>> {
    this.requireKey();
    const count = normalizeRelationCount(options.maxResults);
    const recordView = options.recordView || 'short';
    const databaseId = options.databaseId || 'WOS';
    const response = await this.requestExpanded(endpoint, {
      databaseId,
      uniqueId: uid,
      count,
      firstRecord: normalizeFirstRecord(options.firstRecord),
      optionView: recordView === 'full' ? 'FR' : 'SR',
      ...(options.edition ? { edition: options.edition } : {}),
      ...(mapWosSortField(options.sortBy, options.sortOrder) ? { sortField: mapWosSortField(options.sortBy, options.sortOrder) } : {})
    }, recordView, count);
    const queryResult = parseQueryResult(response.data);
    return {
      queryResult,
      items: parseExpandedRecords(response.data)
        .map(record => parseExpandedRecord(record, recordView, databaseId, queryResult))
        .filter((paper): paper is Paper => paper !== null)
    };
  }

  private async requestExpanded(
    endpoint: string,
    params: Record<string, string | number>,
    recordView: WosRecordView,
    requestedRecords: number
  ): Promise<AxiosResponse<any>> {
    let reservation: QuotaReservation | undefined;
    if (recordView === 'full' && requestedRecords > 0) {
      // Reserve synchronously before the first await so concurrent Full Record
      // calls cannot all pass the same local budget check.
      reservation = this.fullRecordQuota.reserve('wos-expanded-full-record', requestedRecords);
    }

    try {
      const response = await this.request({
        method: 'GET',
        url: `${this.baseUrl}${endpoint}`,
        params
      });
      if (reservation) {
        this.fullRecordQuota.commit(reservation, parseExpandedRecords(response.data).length);
        reservation = undefined;
      }
      return response;
    } catch (error) {
      if (reservation) this.fullRecordQuota.release(reservation);
      throw error;
    }
  }

  private requireKey(): void {
    if (!this.isConfigured()) throw new Error('Web of Science Expanded API key is required');
  }
}

export class WebOfScienceSearcher extends PaperSource {
  private readonly starterClient: StarterClient;
  private readonly expandedClient: ExpandedClient;
  private readonly retrievalService: RetrievalService;
  private readonly accessDiscovery: PublicAccessDiscovery;
  private readonly accessDiscoveryMaxItems: number;

  constructor(apiKey?: string, apiVersion?: string, options: WebOfScienceSearcherOptions = {}) {
    const starterApiKey = firstConfigured(options.starterApiKey, apiKey, process.env.WOS_API_KEY);
    const expandedApiKey = firstConfigured(options.expandedApiKey, process.env.WOS_EXPANDED_API_KEY);
    super('webofscience', 'https://api.clarivate.com/apis', starterApiKey || expandedApiKey);

    const version = apiVersion || process.env.WOS_STARTER_VERSION || process.env.WOS_API_VERSION || 'v2';
    const commonClientOptions: WosClientOptions = {
      httpClient: options.httpClient,
      quotaManager: options.quotaManager,
      sleep: options.sleep,
      random: options.random,
      maxRetries: options.maxRetries
    };
    this.starterClient = new StarterClient(starterApiKey, version, {
      ...commonClientOptions,
      rateLimiter: options.starterRateLimiter || options.rateLimiter
    });
    this.expandedClient = new ExpandedClient(expandedApiKey, {
      ...commonClientOptions,
      rateLimiter: options.expandedRateLimiter || options.rateLimiter,
      baseUrl: options.expandedBaseUrl
    });
    const retrievalConfiguration = parseRetrievalConfiguration();
    this.accessDiscoveryMaxItems = retrievalConfiguration.accessDiscoveryMaxItems;
    this.retrievalService = options.retrievalService || createRetrievalService({
      configuration: retrievalConfiguration
    });
    this.accessDiscovery = options.publicAccessDiscovery || new PublicAccessDiscovery(this.retrievalService);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: false,
      fullText: false,
      citations: true,
      requiresApiKey: true,
      supportedOptions: [
        'maxResults', 'year', 'author', 'journal', 'sortBy', 'sortOrder',
        'apiProduct', 'recordView', 'discoverAccess', 'discoverAccessMaxItems'
      ] as any
    };
  }

  hasApiKey(): boolean {
    return this.starterClient.isConfigured() || this.expandedClient.isConfigured();
  }

  async search(query: string, options: WoSSearchOptions = {}): Promise<Paper[]> {
    const product = options.apiProduct || 'starter';
    if (product === 'starter' && options.recordView !== undefined) {
      throw new Error('recordView is only supported when apiProduct is expanded');
    }
    if (options.discoverAccess && options.discoverAccessMaxItems !== undefined && !isValidAccessDiscoveryMaxItems(options.discoverAccessMaxItems)) {
      throw new Error('discoverAccessMaxItems must be an integer between 1 and 100');
    }
    this.requireProduct(product);

    try {
      const results = product === 'expanded'
        ? await this.expandedClient.search(query, toExpandedOptions(options))
        : await this.starterClient.search(query, toStarterOptions(options));
      if (!options.discoverAccess) return results;
      try {
        return await this.accessDiscovery.enrich(results, {
          maxItems: options.discoverAccessMaxItems ?? this.accessDiscoveryMaxItems,
          operation: options.operationContext
        });
      } catch {
        // Access discovery is best-effort enrichment; a batch-level rejection
        // must never discard a successful official WoS result set.
        return results;
      }
    } catch (error) {
      if (error instanceof ApiError || error instanceof CapabilityUnavailableError) throw error;
      this.handleHttpError(error, `search (${product})`);
    }
  }

  async getPaperByDoi(doi: string): Promise<Paper | null> {
    const result = sanitizeDoi(doi);
    if (!result.valid) return null;
    try {
      const papers = await this.starterClient.search(`DO="${result.sanitized}"`, { maxResults: 1 });
      return papers[0] || null;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.handleHttpError(error, 'get document by DOI');
    }
  }

  async getReferenceIds(uid: string): Promise<string[]> {
    this.requireExpanded('references');
    try {
      const result = await this.expandedClient.getReferences(uid, { maxResults: 50 });
      return result.items
        .map(reference => reference.uid)
        .filter((uid): uid is string => Boolean(uid));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.handleHttpError(error, 'get reference IDs');
    }
  }

  async getCitationIds(uid: string): Promise<string[]> {
    this.requireExpanded('citing');
    if (!/^WOS:/i.test(uid)) throw new Error('Expanded citing records require a Web of Science Core Collection UID');
    try {
      const result = await this.expandedClient.getCiting(uid, { maxResults: 100, recordView: 'short' });
      return result.items.map(paper => paper.paperId).filter(Boolean);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.handleHttpError(error, 'get citation IDs');
    }
  }

  async getRelatedRecords(uid: string, relation: WosRelation, options: ExpandedRelationOptions = {}): Promise<WosRelationResult<Paper | WosReference>> {
    this.requireExpanded(relation);
    try {
      if (relation === 'references') {
        if (options.recordView !== undefined) {
          throw new Error('references does not accept recordView');
        }
        return this.expandedClient.getReferences(uid, options);
      }
      if (relation === 'citing' && !/^WOS:/i.test(uid)) {
        throw new Error('Expanded citing records require a Web of Science Core Collection UID');
      }
      return relation === 'citing'
        ? this.expandedClient.getCiting(uid, options)
        : this.expandedClient.getRelated(uid, options);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.handleHttpError(error, `get ${relation} records`);
    }
  }

  async getPaperWithCitations(uid: string): Promise<Paper | null> {
    this.requireExpanded('citation relationships');
    const paper = await this.expandedClient.getByUid(uid, 'short');
    if (!paper) return null;
    const [references, citations] = await Promise.all([
      this.expandedClient.getReferences(uid, { maxResults: 100 }),
      /^WOS:/i.test(uid) ? this.expandedClient.getCiting(uid, { maxResults: 100 }) : Promise.resolve({ queryResult: {}, items: [] as Paper[] })
    ]);
    paper.references = references.items
      .map(reference => reference.uid)
      .filter((referenceId): referenceId is string => Boolean(referenceId));
    paper.extra = { ...(paper.extra || {}), citationIds: citations.items.map(item => item.paperId) };
    return paper;
  }

  async getCitationCount(paperId: string, apiProduct: 'starter' | 'expanded' = 'starter'): Promise<number | undefined> {
    this.requireProduct(apiProduct);
    try {
      return apiProduct === 'expanded'
        ? (await this.expandedClient.getByUid(paperId, 'short'))?.citationCount
        : await this.starterClient.getCitationCount(paperId);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      this.handleHttpError(error, `get ${apiProduct} citation count`);
    }
  }

  async validateApiKey(): Promise<boolean> {
    return (await this.starterClient.validateApiKeyStatus()) === 'valid';
  }

  async getStatus(validate = false): Promise<WebOfScienceStatus> {
    const starter = this.starterClient.getStatus();
    const expanded = this.expandedClient.getStatus();
    const starterApiKeyStatus = validate ? await this.starterClient.validateApiKeyStatus() : configuredStatus(starter.configured);
    const expandedApiKeyStatus = validate ? await this.expandedClient.validateApiKeyStatus() : configuredStatus(expanded.configured);
    return {
      starter: { ...starter, apiKeyStatus: starterApiKeyStatus },
      expanded: { ...expanded, apiKeyStatus: expandedApiKeyStatus },
      scrapingAnt: this.retrievalService.getProcessStatus()
    };
  }

  getScrapingAntStatus(): RetrievalProcessStatus {
    return this.retrievalService.getProcessStatus();
  }

  getPublicAccessDiscovery(): PublicAccessDiscovery {
    return this.accessDiscovery;
  }

  getApiVersion(): 'v1' | 'v2' {
    return this.starterClient.getVersion();
  }

  async downloadPdf(_paperId: string, _options?: DownloadOptions): Promise<string> {
    throw new Error('Web of Science does not support direct PDF download. Use a DOI or publisher access link.');
  }

  async readPaper(_paperId: string, _options?: DownloadOptions): Promise<string> {
    throw new Error('Web of Science does not provide full-text content.');
  }

  private requireProduct(product: 'starter' | 'expanded'): void {
    const configured = product === 'starter' ? this.starterClient.isConfigured() : this.expandedClient.isConfigured();
    if (!configured) {
      throw new CapabilityUnavailableError(
        `webofscience-${product}`,
        'api',
        `Web of Science ${product} API key is required`
      );
    }
  }

  private requireExpanded(capability: string): void {
    if (!this.expandedClient.isConfigured()) {
      throw new CapabilityUnavailableError('webofscience-expanded', capability, 'Web of Science Expanded API is not configured');
    }
  }
}

function toStarterOptions(options: WoSSearchOptions): StarterClientSearchOptions {
  return { ...options };
}

function toExpandedOptions(options: WoSSearchOptions): ExpandedClientSearchOptions {
  return { ...options, recordView: options.recordView || 'short' };
}

function configuredStatus(configured: boolean): ApiKeyValidationStatus {
  return configured ? 'configured' : 'missing';
}

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim() !== '')?.trim();
}

function normalizeResultCount(value: number | undefined, maximum: number, product: string): number {
  const count = value ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > maximum) {
    throw new Error(`Web of Science ${product} maxResults must be an integer between 1 and ${maximum}`);
  }
  return count;
}

function normalizeRelationCount(value: number | undefined): number {
  const count = value ?? 50;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error('Web of Science relation maxResults must be an integer between 1 and 100');
  }
  return count;
}

function normalizeFirstRecord(value: number | undefined): number {
  const firstRecord = value ?? 1;
  if (!Number.isInteger(firstRecord) || firstRecord < 1 || firstRecord > 100000) {
    throw new Error('Web of Science firstRecord must be an integer between 1 and 100000');
  }
  return firstRecord;
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function mapWosSortField(sortBy?: string, sortOrder: 'asc' | 'desc' = 'desc'): string | undefined {
  if (!sortBy) return undefined;
  const field = ({ relevance: 'RS', date: 'PY', citations: 'TC' } as Record<string, string>)[sortBy.toLowerCase()];
  if (!field) throw new Error(`Unsupported Web of Science sort field: ${sortBy}`);
  return `${field}+${sortOrder.toLowerCase() === 'asc' ? 'A' : 'D'}`;
}

interface WosQueryOptions {
  year?: string;
  author?: string;
  journal?: string;
  issn?: string;
  volume?: string;
  page?: string;
  issue?: string;
  documentTypes?: string[];
  pmid?: string;
  doi?: string;
}

function buildWosQuery(query: string, options: WosQueryOptions = {}): string {
  const complexity = validateQueryComplexity(query, { maxLength: 1000, maxBooleanOperators: 10 });
  if (!complexity.valid) throw new Error(complexity.error);

  const parts: string[] = [];
  const trimmed = query.trim();
  if (trimmed) {
    const upper = trimmed.toUpperCase();
    const tags = ['TS=', 'TI=', 'AU=', 'SO=', 'PY=', 'DO=', 'IS=', 'VL=', 'PG=', 'CS=', 'DT=', 'PMID=', 'FPY=', 'DOP=', 'AI=', 'UT=', 'OG=', 'SUR='];
    parts.push(tags.some(tag => upper.includes(tag)) ? trimmed : `TS=(${escapeQueryValue(trimmed, 'wos')})`);
  }
  if (options.year) {
    const year = options.year.replace(/\s+/g, '');
    if (!/^\d{4}(?:-\d{4})?$/.test(year)) throw new Error('Web of Science year must be YYYY or YYYY-YYYY');
    parts.push(year.includes('-') ? `PY=(${year})` : `PY=${year}`);
  }
  if (options.author) parts.push(`AU=${wosLiteral(options.author)}`);
  if (options.journal) parts.push(`SO=${wosLiteral(options.journal)}`);
  if (options.issn) parts.push(`IS=${safeWosToken(options.issn, 'ISSN')}`);
  if (options.volume) parts.push(`VL=${safeWosToken(options.volume, 'volume')}`);
  if (options.page) parts.push(`PG=${safeWosToken(options.page, 'page')}`);
  if (options.issue) parts.push(`CS=${safeWosToken(options.issue, 'issue')}`);
  if (options.documentTypes?.length) {
    const types = options.documentTypes.map(type => wosLiteral(type));
    parts.push(`DT=(${types.join(' OR ')})`);
  }
  if (options.pmid) {
    if (!/^\d{1,20}$/.test(options.pmid.trim())) throw new Error('Web of Science PMID must be numeric');
    parts.push(`PMID=${options.pmid.trim()}`);
  }
  if (options.doi) {
    const doi = sanitizeDoi(options.doi);
    if (!doi.valid) throw new Error(doi.error || 'Invalid DOI format');
    parts.push(`DO="${doi.sanitized}"`);
  }
  return parts.join(' AND ');
}

function wosLiteral(value: string): string {
  const sanitized = escapeQueryValue(value, 'general').replace(/[()]/g, '').trim();
  if (!sanitized) throw new Error('Web of Science field filter must not be empty');
  return `"${sanitized}"`;
}

function safeWosToken(value: string, field: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/.test(token)) {
    throw new Error(`Web of Science ${field} contains unsupported characters`);
  }
  return token;
}
