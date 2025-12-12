/**
 * arXiv API集成模块
 * 基于arXiv API v1.1实现论文搜索和下载功能
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';

interface ArxivEntry {
  id: string[];
  title: string[];
  summary: string[];
  author: Array<{ name: string[] }> | { name: string[] };
  published: string[];
  updated: string[];
  'arxiv:primary_category': Array<{ $: { term: string } }>;
  category?: Array<{ $: { term: string } }>;
  link: Array<{
    $: {
      href: string;
      type?: string;
      title?: string;
    };
  }>;
  'arxiv:doi'?: string[];
}

interface ArxivResponse {
  feed: {
    entry?: ArxivEntry | ArxivEntry[];
    'opensearch:totalResults': string[];
  };
}

export class ArxivSearcher extends PaperSource {
  constructor() {
    super('arxiv', 'https://export.arxiv.org/api');
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true,
      fullText: true,
      citations: false, // arXiv本身不提供被引统计
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'year', 'author', 'category', 'sortBy', 'sortOrder']
    };
  }

  /**
   * 搜索arXiv论文
   */
  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    try {
      const searchQuery = this.buildSearchQuery(query, options);
      const url = `${this.baseUrl}/query`;
      
      // Map sortOrder: arXiv API requires 'ascending' or 'descending'
      const sortOrderMap: Record<string, string> = {
        'asc': 'ascending',
        'desc': 'descending',
        'ascending': 'ascending',
        'descending': 'descending'
      };
      
      const params = {
        search_query: searchQuery,
        max_results: options.maxResults || 10,
        sortBy: this.mapSortField(options.sortBy || 'relevance'),
        sortOrder: sortOrderMap[options.sortOrder || 'desc'] || 'descending'
      };

      console.error(`🔍 arXiv API Request: GET ${url}`);
      console.error(`📋 arXiv Request params:`, params);

      const response = await axios.get(url, { 
        params, 
        timeout: 30000,
        headers: {
          'User-Agent': 'Paper-Search-MCP/1.0 (Academic Research Tool)'
        }
      });
      
      console.error(`✅ arXiv API Response: ${response.status} ${response.statusText}, Data length: ${response.data?.length || 0}`);
      
      const papers = await this.parseSearchResponse(response.data);
      console.error(`📄 arXiv Parsed ${papers.length} papers`);
      
      return papers;
    } catch (error: any) {
      console.error(`❌ arXiv Search Error:`, error.message);
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * 下载PDF文件
   */
  async downloadPdf(paperId: string, options: DownloadOptions = {}): Promise<string> {
    try {
      const savePath = options.savePath || './downloads';
      const pdfUrl = `https://arxiv.org/pdf/${paperId}.pdf`;
      
      // 确保保存目录存在
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      const filename = `${paperId}.pdf`;
      const filePath = path.join(savePath, filename);

      // 检查文件是否已存在
      if (fs.existsSync(filePath) && !options.overwrite) {
        return filePath;
      }

      const response = await axios.get(pdfUrl, {
        responseType: 'stream',
        timeout: 60000
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
   * 读取论文全文内容（从PDF中提取）
   */
  async readPaper(paperId: string, options: DownloadOptions = {}): Promise<string> {
    try {
      const savePath = options.savePath || './downloads';
      const filePath = path.join(savePath, `${paperId}.pdf`);

      // 如果PDF不存在，先下载
      if (!fs.existsSync(filePath)) {
        await this.downloadPdf(paperId, options);
      }

      // 这里需要PDF解析库，暂时返回提示信息
      return `PDF file downloaded at: ${filePath}. Full text extraction requires additional PDF parsing implementation.`;
    } catch (error) {
      this.handleHttpError(error, 'read paper');
    }
  }

  /**
   * 构建搜索查询
   */
  private buildSearchQuery(query: string, options: SearchOptions): string {
    let searchQuery = query;

    // 添加作者过滤
    if (options.author) {
      searchQuery += ` AND au:"${options.author}"`;
    }

    // 添加分类过滤
    if (options.category) {
      searchQuery += ` AND cat:${options.category}`;
    }

    // 添加年份过滤（arXiv使用日期范围）
    if (options.year) {
      const year = options.year;
      if (year.includes('-')) {
        // 年份范围
        const [startYear, endYear] = year.split('-');
        if (startYear) {
          searchQuery += ` AND submittedDate:[${startYear}0101 TO `;
          searchQuery += endYear ? `${endYear}1231]` : '*]';
        }
      } else {
        // 单一年份
        searchQuery += ` AND submittedDate:[${year}0101 TO ${year}1231]`;
      }
    }

    return searchQuery;
  }

  /**
   * 映射排序字段
   */
  private mapSortField(sortBy: string): string {
    const fieldMap: Record<string, string> = {
      'relevance': 'relevance',
      'date': 'submittedDate',
      'citations': 'submittedDate' // arXiv没有被引排序，使用日期代替
    };
    return fieldMap[sortBy] || 'relevance';
  }

  /**
   * 解析搜索响应
   */
  private async parseSearchResponse(xmlData: string): Promise<Paper[]> {
    try {
      const parser = new xml2js.Parser();
      const result: ArxivResponse = await parser.parseStringPromise(xmlData);

      if (!result.feed.entry) {
        return [];
      }

      const entries = Array.isArray(result.feed.entry) 
        ? result.feed.entry 
        : [result.feed.entry];

      return entries.map(entry => this.parseArxivEntry(entry))
        .filter(paper => paper !== null) as Paper[];
    } catch (error) {
      console.error('Error parsing arXiv response:', error);
      return [];
    }
  }

  /**
   * 解析单个arXiv条目
   */
  private parseArxivEntry(entry: ArxivEntry): Paper | null {
    try {
      // 提取论文ID
      const arxivUrl = entry.id[0];
      const paperId = arxivUrl.split('/').pop()?.replace('abs/', '') || '';

      // 提取标题
      const title = entry.title[0];

      // 提取作者
      const authorData = entry.author;
      const authors = Array.isArray(authorData) 
        ? authorData.map(a => a.name[0])
        : [authorData.name[0]];

      // 提取摘要
      const abstract = entry.summary[0];

      // 提取日期
      const publishedDate = this.parseDate(entry.published[0]);
      const updatedDate = this.parseDate(entry.updated[0]);

      // 提取DOI
      const doi = entry['arxiv:doi']?.[0] || '';

      // 提取分类
      const primaryCategory = entry['arxiv:primary_category']?.[0]?.$?.term || '';
      const categories = entry.category?.map(cat => cat.$.term) || [primaryCategory];

      // 提取链接
      const pdfLink = entry.link.find(link => link.$.type === 'application/pdf');
      const pdfUrl = pdfLink?.$.href || `https://arxiv.org/pdf/${paperId}.pdf`;

      // 提取年份
      const year = publishedDate?.getFullYear();

      return PaperFactory.create({
        paperId: paperId,
        title: this.cleanText(title),
        authors: authors,
        abstract: this.cleanText(abstract),
        doi: doi,
        publishedDate: publishedDate,
        pdfUrl: pdfUrl,
        url: `https://arxiv.org/abs/${paperId}`,
        source: 'arxiv',
        updatedDate: updatedDate || undefined,
        categories: categories,
        keywords: [], // arXiv通常不提供关键词
        citationCount: 0, // arXiv本身不提供被引统计
        year: year,
        extra: {
          primaryCategory: primaryCategory,
          arxivId: paperId
        }
      });
    } catch (error) {
      console.error('Error parsing arXiv entry:', error);
      return null;
    }
  }
}