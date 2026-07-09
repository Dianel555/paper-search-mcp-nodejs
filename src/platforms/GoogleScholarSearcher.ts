/**
 * Google Scholar搜索器 - 网页抓取实现
 * 基于HTML解析，包含反检测机制、会话管理和代理支持
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { TIMEOUTS } from '../config/constants.js';
import { logDebug } from '../utils/Logger.js';

interface GoogleScholarOptions extends SearchOptions {
  /** 语言设置 */
  language?: string;
  /** 时间范围（年份） */
  yearLow?: number;
  yearHigh?: number;
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
  // Optional proxy support: set SCHOLAR_PROXY=http://user:pass@host:port to bypass IP-based blocking
  private readonly proxy: string | undefined = process.env.SCHOLAR_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  constructor() {
    super('google_scholar', 'https://scholar.google.com');
    if (this.proxy) {
      logDebug(`Google Scholar using proxy: ${this.proxy.split('@').pop()}`);
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
    logDebug(`Google Scholar Search: query="${query}"`);

    try {
      await this.initializeSession();

      const papers: Paper[] = [];
      let start = 0;
      const resultsPerPage = 10;
      const maxResults = Math.min(options.maxResults || 10, 20);

      while (papers.length < maxResults) {
        await this.adaptiveDelay();

        const params = this.buildSearchParams(query, start, options);
        const response = await this.makeScholarRequest(params);

        if (response.status === 429 || response.status === 403) {
          logDebug(`Google Scholar rate limited (HTTP ${response.status}), resetting session...`);
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.maxRetries) {
            throw new Error('Google Scholar search blocked after multiple retries. Please try again later or use a different platform.');
          }
          await this.resetSession();
          continue;
        }

        if (response.status !== 200) {
          logDebug(`Google Scholar HTTP Error: ${response.status}`);
          break;
        }

        if (response.data.includes('recaptcha') || response.data.includes('captcha') ||
            response.data.includes('Sorry, we can\'t verify that you\'re not a robot')) {
          logDebug('Google Scholar captcha detected');
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.maxRetries) {
            throw new Error('Google Scholar requires captcha verification. Please try again later or use a different platform.');
          }
          await this.resetSession();
          continue;
        }

        this.consecutiveFailures = 0;

        const $ = cheerio.load(response.data);
        const results = $('.gs_ri');

        if (results.length === 0) {
          logDebug('Google Scholar: No more results found');
          break;
        }

        logDebug(`Google Scholar: Found ${results.length} results on page`);

        results.each((index, element) => {
          if (papers.length >= maxResults) return false;

          const paper = this.parseScholarResult($, $(element));
          if (paper) {
            papers.push(paper);
          }
        });

        start += resultsPerPage;
      }

      logDebug(`Google Scholar Results: Found ${papers.length} papers`);
      return papers;

    } catch (error) {
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * 初始化会话 - 先访问主页获取cookie
   */
  private async initializeSession(): Promise<void> {
    try {
      const userAgent = this.getRandomUserAgent();
      const response = await axios.get('https://scholar.google.com', {
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
        maxRedirects: 5,
        ...(this.proxy ? { proxy: false, httpsAgent: this.buildProxyAgent() } : {})
      });

      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        this.sessionCookies = (Array.isArray(setCookie) ? setCookie : [setCookie])
          .map(c => c.split(';')[0])
          .join('; ');
        logDebug('Google Scholar session initialized');
      }
    } catch (error) {
      logDebug('Failed to initialize Google Scholar session, continuing without cookies');
    }
  }

  /**
   * 重置会话
   */
  private async resetSession(): Promise<void> {
    this.sessionCookies = '';
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
   * 发起Scholar请求（不自动重试，由search方法控制重试逻辑）
   */
  private async makeScholarRequest(params: Record<string, any>): Promise<any> {
    const userAgent = this.getRandomUserAgent();

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'DNT': '1'
    };

    if (this.sessionCookies) {
      headers['Cookie'] = this.sessionCookies;
    }

    const config: any = {
      params,
      headers,
      timeout: TIMEOUTS.DEFAULT,
      maxRedirects: 5,
      validateStatus: (status: number) => true,
      ...(this.proxy ? { proxy: false, httpsAgent: this.buildProxyAgent() } : {})
    };

    logDebug(`Google Scholar Request: GET ${this.scholarUrl}`);

    return await axios.get(this.scholarUrl, config);
  }

  /**
   * 构建代理Agent（支持http/https/socks代理）
   */
  private buildProxyAgent(): any {
    if (!this.proxy) return undefined;
    try {
      const u = new URL(this.proxy);
      const proto = u.protocol.replace(':', '');
      const agentMod = proto === 'https' ? 'https-proxy-agent' : proto === 'socks' || proto.startsWith('socks') ? 'socks-proxy-agent' : 'http-proxy-agent';
      // lazy require to avoid hard dependency
      const Agent = require(agentMod);
      const AgentClass = Agent.HttpsProxyAgent || Agent.SocksProxyAgent || Agent.HttpProxyAgent || Agent.default || Agent;
      return new AgentClass(this.proxy);
    } catch (error: any) {
      logDebug(`Failed to build proxy agent for ${this.proxy}: ${error.message}`);
      return undefined;
    }
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
  private async adaptiveDelay(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = this.baseDelay + this.consecutiveFailures * 2000;

    if (timeSinceLastRequest < minDelay) {
      const waitTime = minDelay - timeSinceLastRequest + Math.random() * 2000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    } else {
      await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * 随机延迟
   */
  private async randomDelay(min: number = 1000, max: number = 3000): Promise<void> {
    const delay = Math.random() * (max - min) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}