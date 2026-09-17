/**
 * Google Scholar搜索器 - 网页抓取实现
 * 基于HTML解析，包含反检测机制、会话管理和代理支持
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as cheerio from 'cheerio';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { TIMEOUTS } from '../config/constants.js';
import { disposeResponseBody, getHeaderValue } from '../utils/PublicNetwork.js';
import { logDebug } from '../utils/Logger.js';
import { PublicHttpClient, type PublicHttpResponseData, type PublicHttpRequester } from '../services/PublicHttpClient.js';
import { type RetrievalOperationOptions, type RetrievalStrategyStep } from '../retrieval/RetrievalService.js';
import { createRetrievalService } from '../retrieval/createRetrievalService.js';
import { OutboundSecurityError, type OutboundSecurityPolicy } from '../retrieval/OutboundSecurityPolicy.js';
import { toRetrievalError } from '../services/ScrapingAntFetcher.js';
import { SourceCooldownError, type PublicSourceDispatchScheduler } from '../services/PublicSourceDispatchScheduler.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalProvider, type RetrievalRequest, type RetrievalResponse } from '../retrieval/types.js';

const MAX_SCHOLAR_SESSION_RESPONSE_BYTES = 5 * 1024 * 1024;

interface GoogleScholarOptions extends SearchOptions {
  /** 语言设置 */
  language?: string;
  /** 时间范围（年份） */
  yearLow?: number;
  yearHigh?: number;
  /** Internal benchmark seam: parse exactly one retrieved page. */
  singlePage?: boolean;
  /** Internal benchmark seam: submit exactly one selected strategy. */
  singleStrategy?: GoogleScholarSingleStrategy;
}

export type GoogleScholarTransport = 'auto' | 'direct' | 'scrapingant';
export type GoogleScholarSingleStrategy = Pick<RetrievalRequest, 'strategy' | 'proxyType'>;

export interface GoogleScholarFallbackFetcher {
  isConfigured(): boolean;
  fetch(url: string, options?: Record<string, unknown>): Promise<{
    html: string;
    apiStatus?: number;
    pageStatus?: number;
    creditsCost?: number;
  }>;
}

/**
 * Compatibility adapter only: admission, cancellation and retry ownership
 * remain in RetrievalService; the legacy fetcher performs one transport call.
 */
class LegacyScholarFallbackProvider implements RetrievalProvider {
  readonly name = 'scrapingant';
  readonly capabilities = {
    html: true,
    iframeDocuments: false,
    pdfCandidates: false,
    browser: true,
    paid: true,
    proxyTypes: ['datacenter'],
    combinations: ['static:datacenter', 'browser:datacenter']
  } as const;

  constructor(private readonly fetcher: GoogleScholarFallbackFetcher) {}

  async retrieve(request: RetrievalRequest, context: RetrievalOperationContext): Promise<RetrievalResponse> {
    if (request.strategy !== 'static' && request.strategy !== 'browser') {
      throw new RetrievalError({
        code: 'invalid_request',
        message: 'The compatibility provider only supports paid Scholar retrieval',
        provider: this.name
      });
    }
    if ((request.proxyType ?? 'datacenter') !== 'datacenter') {
      throw new RetrievalError({
        code: 'configuration',
        message: 'The legacy Scholar provider does not support residential retrieval',
        provider: this.name
      });
    }

    let result: Awaited<ReturnType<GoogleScholarFallbackFetcher['fetch']>>;
    try {
      result = await this.fetcher.fetch(request.url, {
        endpoint: 'general',
        browser: request.strategy === 'browser',
        proxyType: 'datacenter',
        signal: context.signal,
        singleAttempt: true
      });
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      throw toRetrievalError(error);
    }
    // API success is not target success; preserve unknown target status so
    // callers cannot authorize browser escalation from provider status alone.
    const targetStatus = result.pageStatus;
    const credits = result.creditsCost;
    return {
      provider: this.name,
      strategy: request.strategy,
      apiStatus: result.apiStatus,
      targetStatus,
      document: {
        kind: 'html',
        html: result.html,
        iframes: [],
        source: { provenance: 'unknown_remote', submittedUrl: request.url },
        targetStatus
      },
      cost: Number.isFinite(credits) && (credits as number) >= 0
        ? { known: true, credits: credits as number }
        : { known: false, credits: null, reason: 'compatibility fetcher did not report credits' }
    };
  }
}

export interface GoogleScholarRetrievalService {
  createOperation(options?: RetrievalOperationOptions): RetrievalOperationContext & { dispose?: () => void };
  retrieveWithStrategies?(
    steps: readonly RetrievalStrategyStep[],
    context?: RetrievalOperationContext,
    options?: { maxPaidStrategySelections?: number; maxBrowserDispatches?: number }
  ): Promise<RetrievalResponse>;
  /** Optional one-attempt seam used by independent benchmark comparisons. */
  retrieveOnce?: (request: RetrievalRequest, context?: RetrievalOperationContext) => Promise<RetrievalResponse>;
  getProcessStatus(): {
    enabled: boolean;
    browserAllowed: boolean;
    residentialAllowed?: boolean;
    availableProxyTypes?: readonly ('datacenter' | 'residential')[];
  };
}

interface ScholarPageCacheEntry {
  readonly status?: number;
  readonly papers: readonly Paper[];
}

interface ScholarPageResponse {
  readonly status?: number;
  readonly data: string;
  readonly papers?: readonly Paper[];
  readonly cacheKey?: string;
}

export type ScholarPageClassification = 'empty' | 'unrecognized' | 'parsed' | 'challenge' | 'restricted' | 'target_error';

export interface ScholarParserDiagnostics {
  readonly bodyBytes: number;
  readonly resultContainers: number;
  readonly itemsExamined: number;
  readonly missingTitleItems: number;
  readonly bookFilteredItems: number;
  readonly constructionErrorItems: number;
  readonly parsedItems: number;
  readonly classification: ScholarPageClassification;
}

export type ScholarParserObserver = (diagnostics: ScholarParserDiagnostics) => void;

interface ScholarParserStats {
  bodyBytes: number;
  resultContainers: number;
  itemsExamined: number;
  missingTitleItems: number;
  bookFilteredItems: number;
  constructionErrorItems: number;
  parsedItems: number;
}

interface ParsedScholarPage {
  readonly papers: readonly Paper[];
  readonly stats: ScholarParserStats;
}

export interface GoogleScholarSearcherOptions {
  /** Request directly first, use ScrapingAnt only as a bounded backup, or force ScrapingAnt. */
  transport?: GoogleScholarTransport;
  retrievalService?: GoogleScholarRetrievalService;
  /** Build the shared service after the isolated Scholar transport exists. */
  retrievalServiceFactory?: (scholarHttpClient: PublicHttpClient) => GoogleScholarRetrievalService;
  directProvider?: RetrievalProvider;
  scrapingAntProvider?: RetrievalProvider;
  /** Internal composition seam for deterministic security-policy tests. */
  securityPolicy?: OutboundSecurityPolicy;
  /** Underlying seam used only below ScholarAxiosRequester; preserves UA/Cookie policy. */
  publicHttpRequester?: PublicHttpRequester;
  /** Shared source scheduler for the isolated Scholar transport. */
  sourceScheduler?: PublicSourceDispatchScheduler;
  /** Optional clock-aware delay seam; the default retains real pacing. */
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Internal opt-in parser telemetry; emits bounded counts only. */
  parserObserver?: ScholarParserObserver;
  /** Legacy seam: callers that provide a complete client retain full ownership. */
  publicHttpClient?: PublicHttpClient;
}

export class GoogleScholarSearcher extends PaperSource {
  private readonly scholarUrl = 'https://scholar.google.com/scholar';
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
  ];
  private sessionCookies: string = '';
  private lastRequestTime: number = 0;
  private consecutiveFailures: number = 0;
  private readonly maxRetries = 3;
  private readonly baseDelay = 3000;
  /**
   * An explicit SCHOLAR_PROXY is an opt-in transport override. Without it,
   * Scholar uses the standard local proxy aliases supplied by the runtime.
   */
  private readonly explicitScholarProxy = firstConfigured(process.env.SCHOLAR_PROXY);
  private readonly localProxy = firstConfigured(
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
    process.env.https_proxy,
    process.env.http_proxy,
    process.env.all_proxy
  );
  private readonly proxy: string | undefined = this.explicitScholarProxy || this.localProxy;
  private readonly transport: GoogleScholarTransport;
  private readonly retrievalService: GoogleScholarRetrievalService;
  private readonly scholarHttpClient: PublicHttpClient;
  private readonly delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly parserObserver?: ScholarParserObserver;
  /** Parsed, bounded domain results for same-operation strategy re-entry. */
  private readonly operationPageCache = new WeakMap<object, Map<string, ScholarPageCacheEntry>>();

  constructor(
    legacyFetcherOrService?: GoogleScholarFallbackFetcher | GoogleScholarRetrievalService,
    options: GoogleScholarSearcherOptions = {}
  ) {
    super('google_scholar', 'https://scholar.google.com');
    if (options.transport && !['auto', 'direct', 'scrapingant'].includes(options.transport)) {
      throw new Error('Google Scholar transport must be auto, direct, or scrapingant');
    }
    this.transport = options.transport || 'auto';
    this.delay = options.delay || delayWithSignal;
    this.parserObserver = options.parserObserver;
    this.scholarHttpClient = options.publicHttpClient || new PublicHttpClient({
      purpose: 'scholar_search',
      securityPolicy: options.securityPolicy,
      sourceScheduler: options.sourceScheduler,
      client: new ScholarAxiosRequester(
        () => this.proxy ? this.buildProxyAgent() : undefined,
        () => this.sessionCookies,
        () => this.getRandomUserAgent(),
        options.publicHttpRequester
      )
    });
    const legacyFallbackProvider = isFallbackFetcher(legacyFetcherOrService)
      ? new LegacyScholarFallbackProvider(legacyFetcherOrService)
      : undefined;
    this.retrievalService = options.retrievalService
      || (!isFallbackFetcher(legacyFetcherOrService) && legacyFetcherOrService)
      || options.retrievalServiceFactory?.(this.scholarHttpClient)
      || createRetrievalService({
        directClients: { scholar_search: this.scholarHttpClient },
        directProvider: options.directProvider,
        scrapingAntProvider: options.scrapingAntProvider || legacyFallbackProvider,
        securityPolicy: options.securityPolicy
      });
    if (this.proxy) {
      logDebug('Google Scholar proxy configured');
    }
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: false,
      fullText: false,
      citations: true,
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'year', 'author']
    };
  }

  /**
   * 搜索Google Scholar论文
   */
  async search(query: string, options: GoogleScholarOptions = {}): Promise<Paper[]> {
    return this.searchWithRetrieval(query, options);
  }

  /**
   * Internal benchmark adapter: retain session, transport and parser behavior,
   * but stop after the first page so a comparison cell has one query request.
   */
  async searchSinglePage(
    query: string,
    options: SearchOptions = {},
    strategy?: GoogleScholarSingleStrategy
  ): Promise<Paper[]> {
    return this.searchWithRetrieval(query, {
      ...options,
      singlePage: true,
      ...(strategy ? { singleStrategy: strategy } : {})
    });
  }

  private async searchWithRetrieval(query: string, options: GoogleScholarOptions = {}): Promise<Paper[]> {
    if (this.proxy) this.buildProxyAgent();
    const suppliedOperation = options.operationContext;
    const ownedOperation = suppliedOperation ? undefined : this.retrievalService.createOperation({ purpose: 'scholar_search' });
    const operation = suppliedOperation || ownedOperation!;
    const papers: Paper[] = [];
    const seen = new Set<string>();
    const maxResults = Math.min(options.maxResults || 10, 20);
    const resultsPerPage = 10;
    let start = 0;
    let pageCount = 0;
    let pagesWithoutNewResults = 0;

    try {
      if (this.transport !== 'scrapingant') {
        await this.initializeSession(operation);
      }

      while (papers.length < maxResults && pageCount < (options.singlePage ? 1 : 10)) {
        await this.adaptiveDelay(operation.signal);
        const params = this.buildSearchParams(query, start, options);
        const response = await this.makeRetrievalScholarRequest(params, operation, options.singleStrategy);
        const status = response.status;
        const parsedPage = response.papers || !this.parserObserver
          ? undefined
          : this.parseScholarPage(response.data);
        this.reportParserDiagnostics(response.data, status, parsedPage?.stats);
        if (isScholarTerminalResponse(status, response.data)) {
          this.cacheScholarPage(operation, response.cacheKey, status, []);
          logDebug(`Google Scholar access blocked (HTTP ${status || 'challenge'}); stopping without paid escalation`);
          break;
        }
        if (isScholarChallengeHtml(response.data)) {
          this.cacheScholarPage(operation, response.cacheKey, status, []);
          break;
        }
        if (status !== undefined && status !== 200) {
          // A target error exhausted the finite page chain; preserve any
          // earlier papers instead of turning best-effort discovery into a
          // search failure.
          this.cacheScholarPage(operation, response.cacheKey, status, []);
          break;
        }

        const parsedPapers = response.papers
          ? [...response.papers]
          : parsedPage?.papers || this.parseScholarResults(response.data);
        this.cacheScholarPage(operation, response.cacheKey, status, parsedPapers);
        if (parsedPapers.length === 0) break;

        let newResults = 0;
        for (const paper of parsedPapers) {
          if (papers.length >= maxResults) break;
          const key = `${paper.paperId}\u0000${paper.url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          papers.push(paper);
          newResults++;
        }

        pageCount++;
        pagesWithoutNewResults = newResults === 0 ? pagesWithoutNewResults + 1 : 0;
        if (pagesWithoutNewResults >= 2) break;
        start += resultsPerPage;
      }

      logDebug(`Google Scholar Results: Found ${papers.length} papers`);
      return papers;
    } catch (error) {
      if (isScholarOperationCancelled(error, operation)) return papers;
      if (error instanceof RetrievalError && error.targetStatus === 429) return papers;
      if (papers.length > 0) return papers;
      // Preserve structured paid-provider diagnostics (for example unknown
      // billing or transport timeout) while keeping the platform-level error
      // contract for session/direct failures.
      if (error instanceof RetrievalError && error.provider === 'scrapingant') throw error;
      return this.handleHttpError(error, 'search');
    } finally {
      ownedOperation?.dispose?.();
    }
  }

  private async makeRetrievalScholarRequest(
    params: Record<string, any>,
    operation: RetrievalOperationContext,
    singleStrategy?: GoogleScholarSingleStrategy
  ): Promise<ScholarPageResponse> {
    const target = new URL(this.scholarUrl);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    const request = (strategy: 'direct' | 'static' | 'browser', proxyType: 'datacenter' | 'residential' = 'datacenter') => ({
      url: target.toString(),
      purpose: 'scholar_search' as const,
      strategy,
      proxyType,
      documentFormat: 'html' as const,
      signal: operation.signal
    });
    const process = this.retrievalService.getProcessStatus();
    const paidPlans = scholarPaidFallbackPlans(process, singleStrategy === undefined);
    const directStep: RetrievalStrategyStep = {
      request: request('direct'),
      retryResponse: response => shouldRetryScholarResponse(response),
      isTerminalResponse: response => isScholarRestrictedResponse(response) || isScholarTerminalResponse(
        response.targetStatus ?? response.document?.targetStatus,
        response.document?.html || ''
      ) || this.hasUsableScholarResults(response),
      continueOnError: error => isScholarFallbackError(error, operation)
    };
    const paidSteps: RetrievalStrategyStep[] = paidPlans.map(plan => ({
      request: request(plan.strategy, plan.proxyType),
      isTerminalResponse: response => isScholarRestrictedResponse(response) || isScholarTerminalResponse(
        response.targetStatus ?? response.document?.targetStatus,
        response.document?.html || ''
      ) || this.hasUsableScholarResults(response),
      continueOnError: error => isScholarFallbackError(error, operation)
    }));
    const steps: RetrievalStrategyStep[] = this.transport === 'scrapingant'
      ? paidSteps
      : this.transport === 'direct'
        ? [directStep]
        : [directStep, ...paidSteps];

    if (operation.signal.aborted) throw new RetrievalError({ code: 'cancelled', message: 'Retrieval operation was cancelled' });
    if (operation.remainingMs() <= 0) throw new RetrievalError({ code: 'timeout', message: 'Google Scholar operation timed out' });
    const cachedPages = this.operationPageCache.get(operation as object);
    const scopeKey = `${target.toString()}\u0000${singleStrategy ? `${singleStrategy.strategy}:${singleStrategy.proxyType || 'datacenter'}` : 'production'}`;
    const cached = cachedPages?.get(scopeKey);
    if (cached) return { status: cached.status, data: '', papers: cached.papers.map(cloneScholarPaper), cacheKey: scopeKey };

    let response: RetrievalResponse;
    if (singleStrategy) {
      const selected = steps.find(step => step.request.strategy === singleStrategy.strategy
        && (step.request.proxyType || 'datacenter') === (singleStrategy.proxyType || 'datacenter'));
      if (!selected || !this.retrievalService.retrieveOnce) {
        throw new RetrievalError({
          code: 'configuration',
          message: 'A single-strategy Scholar comparison requires a one-attempt retrieval service'
        });
      }
      response = await this.retrievalService.retrieveOnce(selected.request, operation);
    } else {
      if (!this.retrievalService.retrieveWithStrategies) {
        throw new RetrievalError({
          code: 'configuration',
          message: 'Scholar strategy retrieval is unavailable'
        });
      }
      response = await this.retrievalService.retrieveWithStrategies(steps, operation, {
        maxPaidStrategySelections: 4,
        maxBrowserDispatches: 2
      });
    }
    const status = response.targetStatus ?? response.document?.targetStatus;
    if (!response.document) return { status, data: '', cacheKey: scopeKey };
    return { status, data: response.document.html || '', cacheKey: scopeKey };
  }

  /**
   * 初始化会话 - 先访问主页获取cookie
   */
  private async initializeSession(operation: RetrievalOperationContext): Promise<void> {
    if (operation.signal.aborted || operation.remainingMs() <= 0) throw new RetrievalError({ code: 'timeout', message: 'Google Scholar operation timed out' });
    let response: Awaited<ReturnType<PublicHttpClient['request']>> | undefined;
    try {
      const userAgent = this.getRandomUserAgent();
      response = await this.scholarHttpClient.request('https://scholar.google.com', {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        responseType: 'stream',
        consumeStreamBodyWithinDispatchSlot: true,
        maxBodyBytes: MAX_SCHOLAR_SESSION_RESPONSE_BYTES,
        streamBodyConsumer: body => readBoundedScholarBody(body, operation),
        timeout: Math.min(TIMEOUTS.DEFAULT, operation.remainingMs()),
        ...(operation.dispatchObserver ? { dispatchObserver: operation.dispatchObserver } : {}),
        deadlineAt: operation.deadlineAt,
        ...(operation.withDispatchSlot ? { dispatchSlot: operation.withDispatchSlot } : {}),
        holdSourceLease: true,
        signal: operation.signal
      });
      const body = await readBoundedScholarBody(response!.response.data, operation);
      const status = Number(response.response.status);
      if (status === 401 || status === 407 || status === 423 || (status === 403 && isScholarPermissionHtml(body)) || isScholarPermissionHtml(body)) {
        this.sessionCookies = '';
        throw new RetrievalError({
          code: 'target_unavailable',
          message: 'Google Scholar session initialization was restricted',
          targetStatus: Number.isInteger(status) ? status : undefined
        });
      }
      const setCookie = getSetCookieValues(response.response.headers);
      if (setCookie.length) {
        this.sessionCookies = setCookie
          .map(cookie => cookie.split(';')[0])
          .join('; ');
        logDebug('Google Scholar session initialized');
      }
    } catch (error) {
      if (error instanceof GoogleScholarProxyConfigurationError || error instanceof GoogleScholarOriginError || error instanceof OutboundSecurityError) throw error;
      if (error instanceof SourceCooldownError) throw error;
      if (operation.signal.aborted || operation.remainingMs() <= 0) throw error;
      if (error instanceof RetrievalError && [
        'security', 'cancelled', 'timeout', 'response_too_large', 'document_limit', 'target_unavailable',
        'auth_or_credits_unknown', 'configuration', 'invalid_request'
      ].includes(error.code)) throw error;
      // Only an ordinary network failure is best-effort. It never starts a
      // paid HOME request and the query still runs through the normal chain.
      logDebug('Failed to initialize Google Scholar session, continuing without cookies');
    } finally {
      const body = (response as { response?: { data?: unknown } } | undefined)?.response?.data;
      disposeResponseBody(body);
      response?.release?.();
    }
  }

  /**
   * 重置会话
   */
  private async resetSession(operation: RetrievalOperationContext): Promise<void> {
    this.sessionCookies = '';
    if (this.transport === 'scrapingant') return;
    await this.randomDelay(5000, 10000, operation.signal);
    await this.initializeSession(operation);
  }

  /**
   * Google Scholar不支持直接PDF下载
   */
  async downloadPdf(paperId: string, options?: DownloadOptions): Promise<string> {
    throw new Error('Google Scholar does not support direct PDF download. Please use the paper URL to access the publisher.');
  }

  /**
   * Google Scholar不提供全文内容
   */
  async readPaper(paperId: string, options?: DownloadOptions): Promise<string> {
    throw new Error('Google Scholar does not provide full-text content. Please use the paper URL to access the full text.');
  }

  /**
   * 构建搜索参数
   */
  private buildSearchParams(query: string, start: number, options: GoogleScholarOptions): Record<string, any> {
    const params: Record<string, any> = {
      q: query,
      start: start,
      hl: options.language || 'en',
      as_sdt: '0,5',
      as_vis: '1'
    };

    if (options.yearLow || options.yearHigh) {
      params.as_ylo = options.yearLow || '';
      params.as_yhi = options.yearHigh || '';
    }

    if (options.author) {
      params.as_sauthors = options.author;
    }

    return params;
  }

  /**
   * 构建代理Agent（支持http/https/socks代理）
   */
  private buildProxyAgent(): any {
    if (!this.proxy) {
      throw new GoogleScholarProxyConfigurationError();
    }

    try {
      const proxyUrl = new URL(this.proxy);
      const protocol = proxyUrl.protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:') {
        return new HttpsProxyAgent(this.proxy);
      }
      if (protocol === 'socks:' || protocol === 'socks4:' || protocol === 'socks4a:' ||
          protocol === 'socks5:' || protocol === 'socks5h:') {
        return new SocksProxyAgent(this.proxy);
      }
    } catch {
      // Convert malformed or unsupported proxy URLs into a stable, sanitized error.
    }

    throw new GoogleScholarProxyConfigurationError();
  }

  private parseScholarResults(html: string): Paper[] {
    return this.parseScholarPage(html).papers as Paper[];
  }

  private parseScholarPage(html: string): ParsedScholarPage {
    const source = html || '';
    const stats: ScholarParserStats = {
      bodyBytes: Math.min(Buffer.byteLength(source, 'utf8'), MAX_SCHOLAR_SESSION_RESPONSE_BYTES),
      resultContainers: 0,
      itemsExamined: 0,
      missingTitleItems: 0,
      bookFilteredItems: 0,
      constructionErrorItems: 0,
      parsedItems: 0
    };
    const $ = cheerio.load(source);
    const containers = $('.gs_ri');
    stats.resultContainers = containers.length;
    const papers: Paper[] = [];
    containers.each((_index, element) => {
      stats.itemsExamined++;
      const paper = this.parseScholarResult($, $(element), stats);
      if (paper) {
        stats.parsedItems++;
        papers.push(paper);
      }
    });
    return { papers, stats };
  }

  private reportParserDiagnostics(html: string, status: number | undefined, stats?: ScholarParserStats): void {
    if (!this.parserObserver || !stats) return;
    try {
      this.parserObserver({
        ...stats,
        classification: classifyScholarPage(status, html, stats)
      });
    } catch {
      // Diagnostic observers are opt-in and must never alter retrieval behavior.
      logDebug('Google Scholar parser observer failed');
    }
  }

  private cacheScholarPage(
    operation: RetrievalOperationContext,
    cacheKey: string | undefined,
    status: number | undefined,
    papers: readonly Paper[]
  ): void {
    if (!cacheKey) return;
    let pages = this.operationPageCache.get(operation as object);
    if (!pages) {
      pages = new Map<string, ScholarPageCacheEntry>();
      this.operationPageCache.set(operation as object, pages);
    }
    pages.set(cacheKey, { status, papers: papers.map(cloneScholarPaper) });
  }

  private hasUsableScholarResults(response: RetrievalResponse): boolean {
    const status = response.targetStatus ?? response.document?.targetStatus;
    if (status !== undefined && (status < 200 || status >= 300)) return false;
    if (isScholarRestrictedResponse(response) || isScholarChallengeHtml(response.document?.html || '')) return false;
    return this.parseScholarResults(response.document?.html || '').length > 0;
  }

  /**
   * 解析单个Scholar搜索结果
   */
  private parseScholarResult(
    $: cheerio.CheerioAPI,
    element: cheerio.Cheerio<any>,
    stats: ScholarParserStats
  ): Paper | null {
    try {
      const titleElement = element.find('h3.gs_rt');
      const titleLink = titleElement.find('a');
      const title = titleElement.text().replace(/^\[PDF\]|\[HTML\]|\[BOOK\]|\[B\]/, '').trim();
      const url = titleLink.attr('href') || '';

      if (!title) {
        stats.missingTitleItems++;
        return null;
      }

      const titleText = titleElement.text();
      if (titleText.includes('[BOOK]') || titleText.includes('[B]') ||
          url.includes('books.google.com')) {
        stats.bookFilteredItems++;
        return null;
      }

      const infoElement = element.find('div.gs_a');
      const infoText = infoElement.text();
      const authors = this.extractAuthors(infoText);
      const year = this.extractYear(infoText);

      const abstractElement = element.find('div.gs_rs');
      const abstract = abstractElement.text() || '';

      const citationElement = element.find('div.gs_fl a').filter((i, el) => {
        return $(el).text().includes('Cited by');
      });
      const citationText = citationElement.text();
      const citationCount = this.extractCitationCount(citationText);

      const paperId = this.generatePaperId(title, authors);

      return PaperFactory.create({
        paperId,
        title: this.cleanText(title),
        authors,
        abstract: this.cleanText(abstract),
        doi: '',
        publishedDate: year ? new Date(year, 0, 1) : null,
        pdfUrl: '',
        url,
        source: 'googlescholar',
        categories: [],
        keywords: [],
        citationCount,
        journal: this.extractJournal(infoText),
        year,
        extra: {
          scholarId: paperId,
          infoText
        }
      });
    } catch {
      stats.constructionErrorItems++;
      logDebug('Error parsing Google Scholar result');
      return null;
    }
  }

  /**
   * 提取作者信息
   */
  private extractAuthors(infoText: string): string[] {
    const parts = infoText.split(' - ');
    if (parts.length > 0) {
      const authorPart = parts[0];
      return authorPart.split(',').map(author => author.trim()).filter(a => a.length > 0);
    }
    return [];
  }

  /**
   * 提取年份
   */
  private extractYear(text: string): number | undefined {
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);
    return yearMatch ? parseInt(yearMatch[0], 10) : undefined;
  }

  /**
   * 提取期刊信息
   */
  private extractJournal(infoText: string): string {
    const parts = infoText.split(' - ');
    if (parts.length > 1) {
      return parts[1].split(',')[0].trim();
    }
    return '';
  }

  /**
   * 提取引用次数
   */
  private extractCitationCount(citationText: string): number {
    const match = citationText.match(/Cited by (\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 生成论文ID
   */
  private generatePaperId(title: string, authors: string[]): string {
    const titleHash = this.simpleHash(title);
    const authorHash = this.simpleHash(authors.join(''));
    return `gs_${titleHash}_${authorHash}`;
  }

  /**
   * 简单哈希函数
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * 获取随机User-Agent
   */
  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  /**
   * 自适应延迟 - 根据请求间隔动态调整
   */
  private async adaptiveDelay(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = this.baseDelay + this.consecutiveFailures * 2000;
    const waitTime = timeSinceLastRequest < minDelay
      ? minDelay - timeSinceLastRequest + Math.random() * 2000
      : Math.random() * 1000;
    await this.delay(waitTime, signal);
    this.lastRequestTime = Date.now();
  }

  /**
   * 随机延迟
   */
  private async randomDelay(min: number = 1000, max: number = 3000, signal?: AbortSignal): Promise<void> {
    const delay = Math.random() * (max - min) + min;
    await this.delay(delay, signal);
  }
}

class GoogleScholarProxyConfigurationError extends Error {
  constructor() {
    super('Google Scholar proxy configuration is invalid or unavailable');
    this.name = 'GoogleScholarProxyConfigurationError';
  }
}

class GoogleScholarOriginError extends OutboundSecurityError {
  constructor() {
    super('Google Scholar request left the allowed HTTPS origin');
    this.name = 'GoogleScholarOriginError';
  }
}

export class ScholarAxiosRequester implements PublicHttpRequester {
  constructor(
    private readonly getAgent: () => any,
    private readonly getCookies: () => string,
    private readonly getUserAgent: () => string,
    private readonly transport?: PublicHttpRequester
  ) {}

  async request(config: any): Promise<PublicHttpResponseData> {
    const headers: Record<string, unknown> = {
      ...(config.headers && typeof config.headers === 'object' ? config.headers : {})
    };
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = this.getUserAgent();
    }
    if (typeof config.url !== 'string') throw new GoogleScholarOriginError();
    let target: URL;
    try {
      target = new URL(config.url);
    } catch {
      throw new GoogleScholarOriginError();
    }
    if (target.origin !== 'https://scholar.google.com') {
      throw new GoogleScholarOriginError();
    }
    if (this.getCookies() && !Object.keys(headers).some(name => name.toLowerCase() === 'cookie')) {
      headers.Cookie = this.getCookies();
    }
    const agent = this.getAgent();
    const request = {
      ...config,
      headers,
      ...(agent ? { proxy: false, httpsAgent: agent } : {})
    };
    if (this.transport) return await this.transport.request(request);
    return await axios.request(request) as PublicHttpResponseData;
  }
}

function getSetCookieValues(headers: unknown): string[] {
  if (!headers || typeof headers !== 'object') return [];
  const entry = Object.entries(headers as Record<string, unknown>)
    .find(([name]) => name.toLowerCase() === 'set-cookie')?.[1];
  if (Array.isArray(entry)) return entry.filter((value): value is string => typeof value === 'string');
  return typeof entry === 'string' ? [entry] : [];
}

function isFallbackFetcher(value: unknown): value is GoogleScholarFallbackFetcher {
  return Boolean(value && typeof (value as GoogleScholarFallbackFetcher).isConfigured === 'function' &&
    typeof (value as GoogleScholarFallbackFetcher).fetch === 'function');
}

type ScholarPaidPlan = {
  readonly strategy: 'static' | 'browser';
  readonly proxyType: 'datacenter' | 'residential';
};

function scholarPaidFallbackPlans(
  status: ReturnType<GoogleScholarRetrievalService['getProcessStatus']>,
  preferBrowserFirst = false
): readonly ScholarPaidPlan[] {
  if (!status.enabled) return [];
  const configuredProxyTypes = status.availableProxyTypes || ['datacenter'];
  const plans: ScholarPaidPlan[] = [];
  for (const proxyType of ['datacenter', 'residential'] as const) {
    if (!configuredProxyTypes.includes(proxyType)) continue;
    if (proxyType === 'residential' && status.residentialAllowed !== true) continue;
    plans.push({ strategy: 'static', proxyType });
    if (status.browserAllowed) plans.push({ strategy: 'browser', proxyType });
  }
  if (!preferBrowserFirst || !status.browserAllowed) return plans;
  const browserDatacenterIndex = plans.findIndex(plan => plan.strategy === 'browser' && plan.proxyType === 'datacenter');
  if (browserDatacenterIndex < 0) return plans;
  return [plans[browserDatacenterIndex], ...plans.slice(0, browserDatacenterIndex), ...plans.slice(browserDatacenterIndex + 1)];
}

// ScrapingAnt compatibility errors are normalized by the shared transport adapter.
function isScholarFallbackError(error: RetrievalError | undefined, operation: RetrievalOperationContext): boolean {
  if (!error) return false;
  if (error.targetStatus === 429) return false;
  if (operation.remainingMs() <= 0 || operation.signal.aborted) return false;
  return ['network', 'server_error', 'target_unavailable', 'detected', 'concurrency_limited', 'timeout'].includes(error.code);
}

function isScholarCaptcha(data: string): boolean {
  return /recaptcha|captcha|sorry, we can't verify that you're not a robot|cloudflare|checking\s+your\s+browser|verify\s+you\s+are\s+human/i.test(data || '');
}

function isScholarChallengeHtml(data: string): boolean {
  const pageLevel = scholarPageSignalText(data);
  return isScholarCaptcha(pageLevel) || /just\s+a\s+moment|access\s+denied/i.test(pageLevel);
}

function isScholarPermissionHtml(data: string): boolean {
  // Result abstracts can legitimately discuss paywalls, subscriptions, or
  // institutional access. Remove result entries and executable/style content
  // before applying softer page-level predicates, so a separate gate still wins.
  const pageLevel = scholarPageSignalText(data);
  return /subscription\s+required|institutional\s+(?:access|login)|full\s*text\s+(?:is\s+)?(?:unavailable|restricted)/i.test(pageLevel)
    || isScholarLoginPage(pageLevel)
    || /paywall/i.test(pageLevel);
}

function scholarPageSignalText(data: string): string {
  const $ = cheerio.load(data || '');
  $.root().find('.gs_ri, script, style').remove();
  return `${$.root().text()} ${$.root().html() || ''}`;
}

function classifyScholarPage(
  status: number | undefined,
  data: string,
  stats: ScholarParserStats
): ScholarPageClassification {
  if (isScholarPermissionHtml(data)) return 'restricted';
  if (isScholarChallengeHtml(data)) return 'challenge';
  if (status !== undefined && status !== 200) return 'target_error';
  if (stats.parsedItems > 0) return 'parsed';
  return stats.bodyBytes === 0 ? 'empty' : 'unrecognized';
}

function isScholarTerminalResponse(status: number | undefined, data: string): boolean {
  if (status === 401 || status === 407 || status === 423 || status === 429) return true;
  return isScholarPermissionHtml(data);
}

function isScholarLoginPage(data: string): boolean {
  return /(?:please|you\s+must|must)\s+(?:sign|log)\s*in\b|(?:sign|log)\s*in\s+(?:to\s+continue|is\s+required|required)|<(?:title|h1)\b[^>]*>\s*(?:sign\s*in|log\s*in|login)\b/i.test(data || '');
}

function isScholarRestrictedResponse(response: RetrievalResponse): boolean {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  if (targetStatus === 401 || targetStatus === 407 || targetStatus === 423 || targetStatus === 429) return true;
  const document = response.document;
  const html = document
    ? [document.html, ...document.iframes.map(frame => frame.html)].join(' ')
    : '';
  if (targetStatus === 403 && isScholarPermissionHtml(html)) return true;
  if (isScholarPermissionHtml(html)) return true;
  // An API-level rejection without a target response is not a target
  // permission claim, but it is terminal for the paid operation.
  return targetStatus === undefined && response.apiStatus !== undefined && response.apiStatus >= 400;
}

function shouldRetryScholarResponse(response: RetrievalResponse): boolean {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  const document = response.document;
  const html = document
    ? [document.html, ...document.iframes.map(frame => frame.html)].join(' ')
    : '';
  return targetStatus !== undefined
    && targetStatus >= 500
    && targetStatus <= 599
    && !isScholarRestrictedResponse(response)
    && !isScholarChallengeHtml(html);
}

function isScholarOperationCancelled(error: unknown, operation: RetrievalOperationContext): boolean {
  return operation.signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error && error.message.toLowerCase().includes('cancel'));
}

async function readBoundedScholarBody(body: unknown, operation: RetrievalOperationContext): Promise<string> {
  if (operation.signal.aborted) throw createScholarAbortError();
  if (operation.remainingMs() <= 0) throw new RetrievalError({ code: 'timeout', message: 'Google Scholar operation timed out' });
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    ensureScholarBodySize(Buffer.byteLength(body));
    return body;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    ensureScholarBodySize(body.byteLength);
    return Buffer.from(body).toString('utf8');
  }
  if (!isScholarAsyncIterable(body)) {
    throw new RetrievalError({ code: 'invalid_request', message: 'Google Scholar session returned an unsupported body' });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      if (operation.signal.aborted) throw createScholarAbortError();
      if (operation.remainingMs() <= 0) throw new RetrievalError({ code: 'timeout', message: 'Google Scholar operation timed out' });
      const next = await awaitScholarAbort(Promise.resolve(iterator.next()), operation.signal);
      if (next.done) break;
      const chunk = next.value;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
      total += buffer.byteLength;
      ensureScholarBodySize(total, body);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    disposeResponseBody(body);
    try {
      const closing = iterator.return?.();
      if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(closing).catch(() => undefined);
      }
    } catch {
      // Preserve the initialization result while releasing the stream.
    }
  }
}

function ensureScholarBodySize(size: number, body?: unknown): void {
  if (size <= MAX_SCHOLAR_SESSION_RESPONSE_BYTES) return;
  disposeResponseBody(body);
  throw new RetrievalError({ code: 'response_too_large', message: 'Google Scholar session response is too large' });
}

function isScholarAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function awaitScholarAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createScholarAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createScholarAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function createScholarAbortError(): Error {
  const error = new Error('Google Scholar operation aborted');
  error.name = 'AbortError';
  return error;
}

async function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Operation aborted');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const error = new Error('Operation aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cloneScholarPaper(paper: Paper): Paper {
  return {
    ...paper,
    publishedDate: paper.publishedDate ? new Date(paper.publishedDate.getTime()) : null,
    ...(paper.updatedDate ? { updatedDate: new Date(paper.updatedDate.getTime()) } : {}),
    authors: [...paper.authors],
    ...(paper.categories ? { categories: [...paper.categories] } : {}),
    ...(paper.keywords ? { keywords: [...paper.keywords] } : {}),
    ...(paper.references ? { references: [...paper.references] } : {}),
    ...(paper.extra ? { extra: { ...paper.extra } } : {})
  };
}

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim() !== '')?.trim();
}