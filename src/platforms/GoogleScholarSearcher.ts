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
import { getHeaderValue } from '../utils/PublicNetwork.js';
import { logDebug } from '../utils/Logger.js';
import { PublicHttpClient, type PublicHttpResponseData, type PublicHttpRequester } from '../services/PublicHttpClient.js';
import { type RetrievalOperationOptions, type RetrievalStrategyStep } from '../retrieval/RetrievalService.js';
import { createRetrievalService } from '../retrieval/createRetrievalService.js';
import { OutboundSecurityError, type OutboundSecurityPolicy } from '../retrieval/OutboundSecurityPolicy.js';
import { toRetrievalError } from '../services/ScrapingAntFetcher.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalProvider, type RetrievalRequest, type RetrievalResponse } from '../retrieval/types.js';

interface GoogleScholarOptions extends SearchOptions {
  /** 语言设置 */
  language?: string;
  /** 时间范围（年份） */
  yearLow?: number;
  yearHigh?: number;
}

export type GoogleScholarTransport = 'auto' | 'direct' | 'scrapingant';

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
    paid: true
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

    let result: Awaited<ReturnType<GoogleScholarFallbackFetcher['fetch']>>;
    try {
      result = await this.fetcher.fetch(request.url, {
        endpoint: 'general',
        browser: request.strategy === 'browser',
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
  retrieveWithStrategies(
    steps: readonly RetrievalStrategyStep[],
    context?: RetrievalOperationContext,
    options?: { maxPaidStrategySelections?: number; maxBrowserDispatches?: number }
  ): Promise<RetrievalResponse>;
  getProcessStatus(): { enabled: boolean; browserAllowed: boolean };
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
  // Optional proxy support: set SCHOLAR_PROXY=http://user:pass@host:port to bypass IP-based blocking.
  private readonly proxy: string | undefined = firstConfigured(
    process.env.SCHOLAR_PROXY,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
    process.env.https_proxy,
    process.env.http_proxy,
    process.env.all_proxy
  );
  private readonly transport: GoogleScholarTransport;
  private readonly retrievalService: GoogleScholarRetrievalService;
  private readonly scholarHttpClient: PublicHttpClient;

  constructor(
    legacyFetcherOrService?: GoogleScholarFallbackFetcher | GoogleScholarRetrievalService,
    options: GoogleScholarSearcherOptions = {}
  ) {
    super('google_scholar', 'https://scholar.google.com');
    if (options.transport && !['auto', 'direct', 'scrapingant'].includes(options.transport)) {
      throw new Error('Google Scholar transport must be auto, direct, or scrapingant');
    }
    this.transport = options.transport || 'auto';
    this.scholarHttpClient = options.publicHttpClient || new PublicHttpClient({
      purpose: 'scholar_search',
      client: new ScholarAxiosRequester(
        () => this.proxy ? this.buildProxyAgent() : undefined,
        () => this.sessionCookies,
        () => this.getRandomUserAgent()
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

  private async searchWithRetrieval(query: string, options: GoogleScholarOptions = {}): Promise<Paper[]> {
    if (this.proxy) this.buildProxyAgent();
    const suppliedOperation = options.operationContext;
    const ownedOperation = suppliedOperation ? undefined : this.retrievalService.createOperation();
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
        await this.initializeSession(operation.signal);
      }

      while (papers.length < maxResults && pageCount < 10) {
        await this.adaptiveDelay(operation.signal);
        const params = this.buildSearchParams(query, start, options);
        const response = await this.makeRetrievalScholarRequest(params, operation);
        const status = response.status;
        if (status === 401 || status === 403 || status === 407 || status === 429 || status === 423 || isScholarRestrictedHtml(response.data)) {
          logDebug(`Google Scholar access blocked (HTTP ${status || 'captcha'}); stopping without paid escalation`);
          break;
        }
        if (status !== 200) {
          if (papers.length > 0) break;
          throw new Error(`Google Scholar HTTP Error: ${status}`);
        }

        const $ = cheerio.load(response.data);
        const results = $('.gs_ri');
        if (results.length === 0) break;

        let newResults = 0;
        results.each((_index, element) => {
          if (papers.length >= maxResults) return false;
          const paper = this.parseScholarResult($, $(element));
          if (!paper) return;
          const key = `${paper.paperId}\u0000${paper.url}`;
          if (seen.has(key)) return;
          seen.add(key);
          papers.push(paper);
          newResults++;
        });

        pageCount++;
        pagesWithoutNewResults = newResults === 0 ? pagesWithoutNewResults + 1 : 0;
        if (pagesWithoutNewResults >= 2) break;
        start += resultsPerPage;
      }

      logDebug(`Google Scholar Results: Found ${papers.length} papers`);
      return papers;
    } catch (error) {
      if (isScholarOperationCancelled(error, operation)) return papers;
      if (papers.length > 0) return papers;
      return this.handleHttpError(error, 'search');
    } finally {
      ownedOperation?.dispose?.();
    }
  }

  private async makeRetrievalScholarRequest(
    params: Record<string, any>,
    operation: RetrievalOperationContext
  ): Promise<{ status?: number; data: string }> {
    const target = new URL(this.scholarUrl);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    const request = (strategy: 'direct' | 'static') => ({
      url: target.toString(),
      purpose: 'scholar_search' as const,
      strategy,
      documentFormat: 'html' as const,
      signal: operation.signal
    });

    const steps: RetrievalStrategyStep[] = this.transport === 'scrapingant'
      ? [{ request: request('static') }]
      : this.transport === 'direct'
        ? [{ request: request('direct') }]
        : [
          {
            request: request('direct'),
            retryResponse: response => shouldRetryScholarResponse(response),
            isTerminalResponse: response => !isServerError(response.targetStatus) || isScholarRestrictedResponse(response),
            continueOnError: error => isScholarFallbackError(error)
          },
          {
            request: request('static'),
            shouldAttempt: state => isServerError(state.previousResponse?.targetStatus)
              || isScholarFallbackError(state.previousError)
          }
        ];

    const response = await this.retrievalService.retrieveWithStrategies(steps, operation, {
      maxPaidStrategySelections: 3,
      maxBrowserDispatches: 0
    });
    return {
      status: response.targetStatus ?? response.document?.targetStatus,
      data: response.document?.html || ''
    };
  }

  /**
   * 初始化会话 - 先访问主页获取cookie
   */
  private async initializeSession(signal?: AbortSignal): Promise<void> {
    try {
      const userAgent = this.getRandomUserAgent();
      const response = await this.scholarHttpClient.request('https://scholar.google.com', {
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
        timeout: TIMEOUTS.DEFAULT,
        signal
      });

      const setCookie = getSetCookieValues(response.response.headers);
      if (setCookie.length) {
        this.sessionCookies = setCookie
          .map(cookie => cookie.split(';')[0])
          .join('; ');
        logDebug('Google Scholar session initialized');
      }
    } catch (error) {
      if (error instanceof GoogleScholarProxyConfigurationError || error instanceof GoogleScholarOriginError) throw error;
      if (signal?.aborted) throw error;
      logDebug('Failed to initialize Google Scholar session, continuing without cookies');
    }
  }

  /**
   * 重置会话
   */
  private async resetSession(): Promise<void> {
    this.sessionCookies = '';
    if (this.transport === 'scrapingant') return;
    await this.randomDelay(5000, 10000);
    await this.initializeSession();
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

  /**
   * 解析单个Scholar搜索结果
   */
  private parseScholarResult($: cheerio.CheerioAPI, element: cheerio.Cheerio<any>): Paper | null {
    try {
      const titleElement = element.find('h3.gs_rt');
      const titleLink = titleElement.find('a');
      const title = titleElement.text().replace(/^\[PDF\]|\[HTML\]|\[BOOK\]|\[B\]/, '').trim();
      const url = titleLink.attr('href') || '';

      if (!title) {
        return null;
      }

      const titleText = titleElement.text();
      if (titleText.includes('[BOOK]') || titleText.includes('[B]') ||
          url.includes('books.google.com')) {
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
    } catch (error) {
      logDebug('Error parsing Google Scholar result:', error);
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
    await delayWithSignal(waitTime, signal);
    this.lastRequestTime = Date.now();
  }

  /**
   * 随机延迟
   */
  private async randomDelay(min: number = 1000, max: number = 3000, signal?: AbortSignal): Promise<void> {
    const delay = Math.random() * (max - min) + min;
    await delayWithSignal(delay, signal);
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
    private readonly getUserAgent: () => string
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
    return await axios.request({
      ...config,
      headers,
      ...(agent ? { proxy: false, httpsAgent: agent } : {})
    }) as PublicHttpResponseData;
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

function isServerError(status: number | undefined): boolean {
  return typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599;
}

// ScrapingAnt compatibility errors are normalized by the shared transport adapter.
function isScholarFallbackError(error: RetrievalError | undefined): boolean {
  return Boolean(error && ['network', 'server_error', 'timeout'].includes(error.code));
}

function isScholarCaptcha(data: string): boolean {
  return /recaptcha|captcha|sorry, we can't verify that you're not a robot|cloudflare|checking\s+your\s+browser|verify\s+you\s+are\s+human/i.test(data || '');
}

function isScholarRestrictedHtml(data: string): boolean {
  const html = data || '';
  if (isScholarCaptcha(html)
    || /access\s+denied|just\s+a\s+moment|checking\s+your\s+browser|verify\s+you\s+are\s+human/i.test(html)) return true;
  // Result abstracts can legitimately discuss paywalls, subscriptions, or
  // institutional access. Remove only result entries before applying softer
  // page-level login/paywall predicates, so a separate gate still wins.
  const $ = cheerio.load(html);
  $.root().find('.gs_ri').remove();
  const pageLevel = `${$.root().text()} ${$.root().html() || ''}`;
  return /subscription\s+required|institutional\s+(?:access|login)|full\s*text\s+(?:is\s+)?(?:unavailable|restricted)/i.test(pageLevel)
    || isScholarLoginPage(pageLevel)
    || /paywall/i.test(pageLevel);
}

function isScholarLoginPage(data: string): boolean {
  return /(?:please|you\s+must|must)\s+(?:sign|log)\s*in\b|(?:sign|log)\s*in\s+(?:to\s+continue|is\s+required|required)|<(?:title|h1)\b[^>]*>\s*(?:sign\s*in|log\s*in|login)\b/i.test(data || '');
}

function isScholarRestrictedResponse(response: RetrievalResponse): boolean {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  if (targetStatus === 401 || targetStatus === 403 || targetStatus === 407 || targetStatus === 429 || targetStatus === 423) return true;
  const document = response.document;
  return isScholarRestrictedHtml(document
    ? [document.html, ...document.iframes.map(frame => frame.html)].join(' ')
    : '');
}

function shouldRetryScholarResponse(response: RetrievalResponse): boolean {
  const targetStatus = response.targetStatus ?? response.document?.targetStatus;
  return targetStatus !== undefined && targetStatus >= 500 && !isScholarRestrictedResponse(response);
}

function isScholarOperationCancelled(error: unknown, operation: RetrievalOperationContext): boolean {
  return operation.signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error && error.message.toLowerCase().includes('cancel'));
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

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim() !== '')?.trim();
}