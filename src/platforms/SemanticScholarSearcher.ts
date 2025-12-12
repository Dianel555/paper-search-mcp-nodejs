/**
 * Semantic Scholar API集成模块
 * 支持免费API和付费API密钥
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { sanitizeDoi } from '../utils/SecurityUtils.js';
import { TIMEOUTS, USER_AGENT } from '../config/constants.js';
import { logDebug } from '../utils/Logger.js';

interface SemanticSearchOptions extends SearchOptions {
  /** 发表年份范围 */
  year?: string; // 格式: "2019" 或 "2016-2020" 或 "2010-" 或 "-2015"
  /** 研究领域过滤 */
  fieldsOfStudy?: string[];
}

interface SemanticSearchResponse {
  total: number;
  offset: number;
  next?: number;
  data: SemanticPaper[];
}

interface SemanticPaper {
  paperId: string;
  title: string;
  abstract?: string;
  venue?: string;
  year?: number;
  referenceCount?: number;
  citationCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: {
    url?: string;
    status?: string;
    disclaimer?: string;
  };
  fieldsOfStudy?: string[];
  s2FieldsOfStudy?: Array<{
    category: string;
    source: string;
  }>;
  publicationTypes?: string[];
  publicationDate?: string;
  journal?: {
    name?: string;
    pages?: string;
    volume?: string;
  };
  authors?: Array<{
    authorId: string;
    name: string;
  }>;
  externalIds?: {
    DOI?: string;
    ArXiv?: string;
    PubMed?: string;
    MAG?: string;
    ACL?: string;
    DBLP?: string;
  };
  url?: string;
}

export class SemanticScholarSearcher extends PaperSource {
  private readonly rateLimiter: RateLimiter;
  private readonly baseApiUrl: string;

  constructor(apiKey?: string) {
    super('semantic', 'https://api.semanticscholar.org/graph/v1', apiKey);
    this.baseApiUrl = this.baseUrl;
    
    // Semantic Scholar免费API限制：100 requests per 5 minutes
    // 付费API: 1000 requests per 5 minutes
    // 更保守的速率限制以避免被封
    const requestsPerMinute = apiKey ? 180 : 18; // 有API密钥时更宽松
    this.rateLimiter = new RateLimiter({
      requestsPerSecond: requestsPerMinute / 60,
      burstCapacity: Math.max(3, Math.floor(requestsPerMinute / 20)), // 降低突发容量
      debug: process.env.NODE_ENV === 'development'
    });
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true, // 部分论文有开放获取PDF
      fullText: false, // 只有部分PDF
      citations: true, // 提供引用统计
      requiresApiKey: false, // 免费API可用，但有限制
      supportedOptions: ['maxResults', 'year', 'fieldsOfStudy', 'sortBy']
    };
  }

  /**
   * 搜索Semantic Scholar论文
   */
  async search(query: string, options: SemanticSearchOptions = {}): Promise<Paper[]> {
    await this.rateLimiter.waitForPermission();

    try {
      const params: Record<string, any> = {
        query: query,
        limit: Math.min(options.maxResults || 10, 100), // API限制最大100
        fields: [
          'paperId', 'title', 'abstract', 'venue', 'year', 
          'referenceCount', 'citationCount', 'influentialCitationCount',
          'isOpenAccess', 'openAccessPdf', 'fieldsOfStudy', 's2FieldsOfStudy',
          'publicationTypes', 'publicationDate', 'journal', 'authors', 
          'externalIds', 'url'
        ].join(',')
      };

      // 添加年份过滤
      if (options.year) {
        params.year = options.year;
      }

      // 添加研究领域过滤
      if (options.fieldsOfStudy && options.fieldsOfStudy.length > 0) {
        params.fieldsOfStudy = options.fieldsOfStudy.join(',');
      }

      const url = `${this.baseApiUrl}/paper/search`;
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9'
      };

      // 添加API密钥（如果有）- 根据官方文档推荐的方式
      if (this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      logDebug(`Semantic Scholar API Request: GET ${url}`);
      logDebug('Semantic Scholar Request params:', params);

      const response = await axios.get(url, { 
        params, 
        headers,
        timeout: TIMEOUTS.DEFAULT,
        // 改善请求可靠性
        maxRedirects: 5,
        validateStatus: (status) => status < 500 // allow 4xx through so we can provide consistent messaging
      });
      
      logDebug(`Semantic Scholar API Response: ${response.status} ${response.statusText}`);
      
      // 处理可能的错误响应
      if (response.status >= 400) {
        // Convert non-throwing 4xx response to unified error handling
        this.handleHttpError({ response, config: response.config }, 'search');
      }
      
      const papers = this.parseSearchResponse(response.data);
      logDebug(`Semantic Scholar Parsed ${papers.length} papers`);
      
      return papers;
    } catch (error: any) {
      logDebug('Semantic Scholar Search Error:', error.message);
      
      // 处理速率限制错误
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after'];
        logDebug(
          `Rate limited by Semantic Scholar API. ${retryAfter ? `Retry after ${retryAfter} seconds.` : 'Please wait before making more requests.'}`
        );
      }
      
      // 处理API限制错误
      if (error.response?.status === 403) {
        logDebug('Access denied. Please check your API key or ensure you are within the free tier limits.');
      }
      
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * 获取论文详细信息
   */
  async getPaperDetails(paperId: string): Promise<Paper | null> {
    await this.rateLimiter.waitForPermission();

    try {
      const params = {
        fields: [
          'paperId', 'title', 'abstract', 'venue', 'year',
          'referenceCount', 'citationCount', 'influentialCitationCount',
          'isOpenAccess', 'openAccessPdf', 'fieldsOfStudy', 's2FieldsOfStudy',
          'publicationTypes', 'publicationDate', 'journal', 'authors',
          'externalIds', 'url'
        ].join(',')
      };

      const url = `${this.baseApiUrl}/paper/${paperId}`;
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      };

      if (this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      const response = await axios.get(url, { 
        params, 
        headers, 
        timeout: TIMEOUTS.DEFAULT,
        maxRedirects: 5,
        validateStatus: (status) => status < 500
      });
      
      return this.parseSemanticPaper(response.data);
    } catch (error: any) {
      logDebug('Error getting paper details from Semantic Scholar:', error.message);
      return null;
    }
  }

  /**
   * 下载PDF文件
   */
  async downloadPdf(paperId: string, options: DownloadOptions = {}): Promise<string> {
    try {
      // 首先获取论文详细信息以获取PDF URL
      const paper = await this.getPaperDetails(paperId);
      if (!paper?.pdfUrl) {
        throw new Error(`No PDF URL available for paper ${paperId}`);
      }

      const savePath = options.savePath || './downloads';
      
      // 确保保存目录存在
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      const filename = `semantic_${paperId.replace(/[/\\:*?"<>|]/g, '_')}.pdf`;
      const filePath = path.join(savePath, filename);

      // 检查文件是否已存在
      if (fs.existsSync(filePath) && !options.overwrite) {
        return filePath;
      }

      const response = await axios.get(paper.pdfUrl, {
        responseType: 'stream',
        timeout: TIMEOUTS.DOWNLOAD,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(filePath));
        writer.on('error', reject);
      });
    } catch (error) {
      this.handleHttpError(error, 'download PDF');
    }
  }

  /**
   * 读取论文全文内容
   */
  async readPaper(paperId: string, options: DownloadOptions = {}): Promise<string> {
    try {
      const savePath = options.savePath || './downloads';
      const filename = `semantic_${paperId.replace(/[/\\:*?"<>|]/g, '_')}.pdf`;
      const filePath = path.join(savePath, filename);

      // 如果PDF不存在，先下载
      if (!fs.existsSync(filePath)) {
        await this.downloadPdf(paperId, options);
      }

      return `PDF file downloaded at: ${filePath}. Full text extraction requires additional PDF parsing implementation.`;
    } catch (error) {
      this.handleHttpError(error, 'read paper');
    }
  }

  /**
   * 根据DOI获取论文信息
   */
  async getPaperByDoi(doi: string): Promise<Paper | null> {
    // Clean and validate DOI
    const doiResult = sanitizeDoi(doi);
    if (!doiResult.valid) {
      logDebug('Invalid DOI format:', doiResult.error);
      return null;
    }

    try {
      return await this.getPaperDetails(`DOI:${doiResult.sanitized}`);
    } catch (error) {
      logDebug('Error getting paper by DOI from Semantic Scholar:', error);
      return null;
    }
  }

  /**
   * 解析搜索响应
   */
  private parseSearchResponse(data: SemanticSearchResponse): Paper[] {
    if (!data.data || !Array.isArray(data.data)) {
      return [];
    }

    return data.data.map(item => this.parseSemanticPaper(item))
      .filter(paper => paper !== null) as Paper[];
  }

  /**
   * 解析单个Semantic Scholar论文
   */
  private parseSemanticPaper(item: SemanticPaper): Paper | null {
    try {
      // 提取作者
      const authors = item.authors?.map(author => author.name) || [];
      
      // 提取发表日期
      const publishedDate = item.publicationDate ? 
        this.parseDate(item.publicationDate) : 
        (item.year ? new Date(item.year, 0, 1) : null);

      // 提取PDF URL
      let pdfUrl = '';
      if (item.openAccessPdf?.url) {
        pdfUrl = item.openAccessPdf.url;
      } else if (item.openAccessPdf?.disclaimer) {
        // 尝试从disclaimer中提取URL
        const urlMatch = item.openAccessPdf.disclaimer.match(/https?:\/\/[^\s,)]+/);
        if (urlMatch) {
          pdfUrl = urlMatch[0];
        }
      }

      // 提取DOI
      const doi = item.externalIds?.DOI || '';

      // 提取分类
      const fieldsOfStudy = item.fieldsOfStudy || [];
      const s2Fields = item.s2FieldsOfStudy?.map(field => field.category) || [];
      const categories = [...fieldsOfStudy, ...s2Fields];

      // 构建URL
      const url = item.url || `https://www.semanticscholar.org/paper/${item.paperId}`;

      return PaperFactory.create({
        paperId: item.paperId,
        title: this.cleanText(item.title),
        authors: authors,
        abstract: this.cleanText(item.abstract || ''),
        doi: doi,
        publishedDate: publishedDate,
        pdfUrl: pdfUrl,
        url: url,
        source: 'semantic',
        categories: [...new Set(categories)], // 去重
        keywords: [],
        citationCount: item.citationCount || 0,
        journal: item.venue || item.journal?.name || '',
        volume: item.journal?.volume || undefined,
        pages: item.journal?.pages || undefined,
        year: item.year,
        extra: {
          semanticScholarId: item.paperId,
          referenceCount: item.referenceCount || 0,
          influentialCitationCount: item.influentialCitationCount || 0,
          isOpenAccess: item.isOpenAccess || false,
          publicationTypes: item.publicationTypes || [],
          externalIds: item.externalIds || {}
        }
      });
    } catch (error) {
      logDebug('Error parsing Semantic Scholar paper:', error);
      return null;
    }
  }

  /**
   * 获取速率限制器状态
   */
  getRateLimiterStatus() {
    return this.rateLimiter.getStatus();
  }

  /**
   * 验证API密钥（如果提供）
   */
  async validateApiKey(): Promise<boolean> {
    if (!this.apiKey) {
      return true; // 无API密钥时使用免费限制
    }

    try {
      await this.search('test', { maxResults: 1 });
      return true;
    } catch (error: any) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return false;
      }
      return true; // 其他错误可能是网络问题
    }
  }
}