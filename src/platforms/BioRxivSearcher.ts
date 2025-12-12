/**
 * bioRxiv API集成模块
 * 支持bioRxiv和medRxiv预印本论文搜索
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { TIMEOUTS, USER_AGENT } from '../config/constants.js';
import { logDebug } from '../utils/Logger.js';

interface BioRxivSearchOptions extends SearchOptions {
  /** 搜索天数范围 */
  days?: number;
  /** 服务器类型 */
  server?: 'biorxiv' | 'medrxiv';
}

interface BioRxivResponse {
  messages: Array<{
    status: string;
    count: number;
  }>;
  collection: BioRxivPaper[];
}

interface BioRxivPaper {
  doi: string;
  title: string;
  authors: string;
  author_corresponding: string;
  author_corresponding_institution: string;
  date: string;
  version: string;
  type: string;
  license: string;
  category: string;
  jatsxml: string;
  abstract: string;
  published?: string;
  server: string;
}

export class BioRxivSearcher extends PaperSource {
  private readonly serverType: 'biorxiv' | 'medrxiv';
  
  constructor(serverType: 'biorxiv' | 'medrxiv' = 'biorxiv') {
    super(serverType, `https://api.biorxiv.org/details/${serverType}`);
    this.serverType = serverType;
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true,
      fullText: true,
      citations: false,
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'days', 'category']
    };
  }

  /**
   * 搜索bioRxiv/medRxiv论文
   */
  async search(query: string, options: BioRxivSearchOptions = {}): Promise<Paper[]> {
    try {
      // 计算日期范围
      const days = options.days || 30;
      const endDate = new Date().toISOString().split('T')[0];
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      // 构建搜索URL
      const searchUrl = `${this.baseUrl}/${startDate}/${endDate}`;
      
      const params: Record<string, any> = {
        cursor: 0
      };
      
      // 添加分类过滤
      if (query && query !== '*') {
        // 将查询转换为分类格式
        const category = query.toLowerCase().replace(/\s+/g, '_');
        params.category = category;
      }

      logDebug(`${this.serverType} API Request: GET ${searchUrl}`);
      logDebug(`${this.serverType} Request params:`, params);

      const response = await axios.get(searchUrl, { 
        params,
        timeout: TIMEOUTS.DEFAULT,
        headers: {
          'User-Agent': USER_AGENT
        }
      });
      
      logDebug(`${this.serverType} API Response: ${response.status} ${response.statusText}`);
      
      const papers = this.parseSearchResponse(response.data, query, options);
      logDebug(`${this.serverType} Parsed ${papers.length} papers`);
      
      return papers.slice(0, options.maxResults || 10);
    } catch (error: any) {
      logDebug(`${this.serverType} Search Error:`, error.message);
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * 下载PDF文件
   */
  async downloadPdf(paperId: string, options: DownloadOptions = {}): Promise<string> {
    try {
      const savePath = options.savePath || './downloads';
      
      // 构建PDF URL
      const pdfUrl = `https://www.${this.serverType}.org/content/${paperId}v1.full.pdf`;
      
      // 确保保存目录存在
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      const filename = `${paperId.replace(/\//g, '_')}.pdf`;
      const filePath = path.join(savePath, filename);

      // 检查文件是否已存在
      if (fs.existsSync(filePath) && !options.overwrite) {
        return filePath;
      }

      const response = await axios.get(pdfUrl, {
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
      const filePath = path.join(savePath, `${paperId.replace(/\//g, '_')}.pdf`);

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
   * 解析搜索响应
   */
  private parseSearchResponse(data: BioRxivResponse, query: string, options: BioRxivSearchOptions): Paper[] {
    if (!data.collection || !Array.isArray(data.collection)) {
      return [];
    }

    // 如果有查询词，进行文本匹配过滤
    let filteredCollection = data.collection;
    if (query && query !== '*' && query.trim()) {
      const queryLower = query.toLowerCase();
      filteredCollection = data.collection.filter(item => 
        item.title.toLowerCase().includes(queryLower) ||
        item.abstract.toLowerCase().includes(queryLower) ||
        item.authors.toLowerCase().includes(queryLower) ||
        item.category.toLowerCase().includes(queryLower)
      );
    }

    return filteredCollection.map(item => this.parseBioRxivPaper(item))
      .filter(paper => paper !== null) as Paper[];
  }

  /**
   * 解析单个bioRxiv论文
   */
  private parseBioRxivPaper(item: BioRxivPaper): Paper | null {
    try {
      // 解析作者
      const authors = item.authors.split(';').map(author => author.trim());
      
      // 解析日期
      const publishedDate = this.parseDate(item.date);
      const year = publishedDate?.getFullYear();
      
      // 构建URL
      const paperUrl = `https://www.${this.serverType}.org/content/${item.doi}v${item.version}`;
      const pdfUrl = `https://www.${this.serverType}.org/content/${item.doi}v${item.version}.full.pdf`;

      return PaperFactory.create({
        paperId: item.doi,
        title: this.cleanText(item.title),
        authors: authors,
        abstract: this.cleanText(item.abstract),
        doi: item.doi,
        publishedDate: publishedDate,
        pdfUrl: pdfUrl,
        url: paperUrl,
        source: this.serverType,
        categories: [item.category],
        keywords: [],
        citationCount: 0,
        year: year,
        extra: {
          version: item.version,
          type: item.type,
          license: item.license,
          server: item.server,
          corresponding_author: item.author_corresponding,
          corresponding_institution: item.author_corresponding_institution
        }
      });
    } catch (error) {
      logDebug(`Error parsing ${this.serverType} paper:`, error);
      return null;
    }
  }
}

/**
 * medRxiv搜索器 - 继承自BioRxivSearcher
 */
export class MedRxivSearcher extends BioRxivSearcher {
  constructor() {
    super('medrxiv');
  }
}