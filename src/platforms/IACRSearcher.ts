/**
 * IACR ePrint Archive集成模块
 * 密码学和相关领域的学术论文搜索
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { TIMEOUTS } from '../config/constants.js';
import { logDebug } from '../utils/Logger.js';

interface IACRSearchOptions extends SearchOptions {
  /** 是否获取详细信息 */
  fetchDetails?: boolean;
}

export class IACRSearcher extends PaperSource {
  private readonly searchUrl: string;
  private readonly userAgents: string[];
  
  constructor() {
    super('iacr', 'https://eprint.iacr.org');
    this.searchUrl = `${this.baseUrl}/search`;
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    ];
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true,
      fullText: true,
      citations: false,
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'fetchDetails']
    };
  }

  /**
   * 搜索IACR ePrint Archive论文
   */
  async search(query: string, options: IACRSearchOptions = {}): Promise<Paper[]> {
    try {
      const params = {
        q: query
      };

      logDebug(`IACR API Request: GET ${this.searchUrl}`);
      logDebug('IACR Request params:', params);

      const response = await axios.get(this.searchUrl, {
        params,
        timeout: TIMEOUTS.DEFAULT,
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      
      logDebug(`IACR API Response: ${response.status} ${response.statusText}`);
      
      const papers = await this.parseSearchResponse(response.data, options);
      logDebug(`IACR Parsed ${papers.length} papers`);
      
      return papers.slice(0, options.maxResults || 10);
    } catch (error: any) {
      logDebug('IACR Search Error:', error.message);
      this.handleHttpError(error, 'search');
    }
  }

  /**
   * 获取论文详细信息
   */
  async getPaperDetails(paperId: string): Promise<Paper | null> {
    try {
      const paperUrl = paperId.startsWith('http') ? paperId : `${this.baseUrl}/${paperId}`;
      
      const response = await axios.get(paperUrl, {
        timeout: TIMEOUTS.DEFAULT,
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      if (response.status !== 200) {
        logDebug(`Failed to fetch paper details: HTTP ${response.status}`);
        return null;
      }

      return this.parseIACRPaperDetails(response.data, paperId);
    } catch (error: any) {
      logDebug(`Error fetching paper details for ${paperId}:`, error.message);
      return null;
    }
  }

  /**
   * 下载PDF文件
   */
  async downloadPdf(paperId: string, options: DownloadOptions = {}): Promise<string> {
    try {
      const pdfUrl = `${this.baseUrl}/${paperId}.pdf`;
      const savePath = options.savePath || './downloads';
      
      // 确保保存目录存在
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      const filename = `iacr_${paperId.replace(/\//g, '_')}.pdf`;
      const filePath = path.join(savePath, filename);

      // 检查文件是否已存在
      if (fs.existsSync(filePath) && !options.overwrite) {
        return filePath;
      }

      const response = await axios.get(pdfUrl, {
        responseType: 'stream',
        timeout: TIMEOUTS.EXTENDED,
        headers: {
          'User-Agent': this.getRandomUserAgent()
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
      const filename = `iacr_${paperId.replace(/\//g, '_')}.pdf`;
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
   * 解析搜索响应
   */
  private async parseSearchResponse(html: string, options: IACRSearchOptions): Promise<Paper[]> {
    const $ = cheerio.load(html);
    const papers: Paper[] = [];
    
    // 查找所有搜索结果条目
    $('.mb-4').each((index, element) => {
      try {
        const $element = $(element);
        
        // 提取论文ID和链接
        const paperLink = $element.find('.d-flex .paperlink').first();
        if (!paperLink.length) return;
        
        const paperId = paperLink.text().trim();
        const paperUrl = this.baseUrl + paperLink.attr('href');
        
        // 提取PDF链接
        const pdfLink = $element.find('a[href$=".pdf"]').first();
        const pdfUrl = pdfLink.length ? this.baseUrl + pdfLink.attr('href') : '';
        
        // 提取更新日期
        const lastUpdatedElem = $element.find('small.ms-auto');
        let updatedDate: Date | null = null;
        if (lastUpdatedElem.length) {
          const dateText = lastUpdatedElem.text().replace('Last updated:', '').trim();
          updatedDate = this.parseDate(dateText);
        }
        
        // 从内容区域提取信息
        const contentDiv = $element.find('.ms-md-4');
        if (!contentDiv.length) return;
        
        // 提取标题
        const titleElem = contentDiv.find('strong').first();
        const title = titleElem.text().trim();
        
        // 提取作者
        const authorsElem = contentDiv.find('span.fst-italic').first();
        const authors = authorsElem.length ? 
          authorsElem.text().split(',').map(author => author.trim()) : [];
        
        // 提取分类
        const categoryElem = contentDiv.find('small.badge').first();
        const categories = categoryElem.length ? [categoryElem.text().trim()] : [];
        
        // 提取摘要
        const abstractElem = contentDiv.find('p.search-abstract').first();
        const abstract = abstractElem.text().trim();
        
        const paper = PaperFactory.create({
          paperId: paperId,
          title: this.cleanText(title),
          authors: authors,
          abstract: this.cleanText(abstract),
          doi: '',
          publishedDate: updatedDate || new Date(),
          pdfUrl: pdfUrl,
          url: paperUrl,
          source: 'iacr',
          updatedDate: updatedDate || undefined,
          categories: categories,
          keywords: [],
          citationCount: 0,
          year: updatedDate?.getFullYear(),
          extra: {
            iacrId: paperId
          }
        });
        
        papers.push(paper);
      } catch (error) {
        logDebug('Error parsing IACR search result:', error);
      }
    });
    
    // 如果需要详细信息，获取每篇论文的详细信息
    if (options.fetchDetails && papers.length > 0) {
      logDebug('Fetching detailed information for IACR papers...');
      const detailedPapers: Paper[] = [];
      
      for (const paper of papers) {
        try {
          const detailedPaper = await this.getPaperDetails(paper.paperId);
          if (detailedPaper) {
            detailedPapers.push(detailedPaper);
          } else {
            detailedPapers.push(paper); // 退回到搜索结果数据
          }
          
          // 添加延迟避免过快请求
          await this.delay(1000);
        } catch (error) {
          logDebug(`Error fetching details for ${paper.paperId}:`, error);
          detailedPapers.push(paper);
        }
      }
      
      return detailedPapers;
    }
    
    return papers;
  }

  /**
   * 解析IACR论文详细页面
   */
  private parseIACRPaperDetails(html: string, paperId: string): Paper | null {
    try {
      const $ = cheerio.load(html);
      
      // 提取标题
      const title = $('h3.mb-3').text().trim();
      
      // 提取作者
      const authorText = $('p.fst-italic').text().trim();
      const authors = authorText ? 
        authorText.replace(/ and /g, ',').split(',').map(author => author.trim()) : [];
      
      // 提取摘要
      const abstract = $('p[style*="white-space: pre-wrap"]').text().trim();
      
      // 提取关键词
      const keywords: string[] = [];
      $('a.badge.bg-secondary.keyword').each((index, element) => {
        keywords.push($(element).text().trim());
      });
      
      // 提取发表信息和历史记录
      const pageText = $.text();
      const lines = pageText.split('\n').map(line => line.trim()).filter(line => line);
      
      let publicationInfo = '';
      let historyEntries: string[] = [];
      let lastUpdated: Date | null = null;
      
      // 查找发表信息
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('Publication info') && i + 1 < lines.length) {
          publicationInfo = lines[i + 1];
          break;
        }
      }
      
      // 查找历史记录
      let historyFound = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === 'History' && !line.includes(':')) {
          historyFound = true;
          continue;
        } else if (historyFound && line.includes(':') && !line.startsWith('Short URL')) {
          historyEntries.push(line);
          // 尝试从第一个历史记录中提取最后更新日期
          if (!lastUpdated) {
            const dateStr = line.split(':')[0].trim();
            lastUpdated = this.parseDate(dateStr);
          }
        } else if (historyFound && (line.startsWith('Short URL') || line.startsWith('License'))) {
          break;
        }
      }
      
      // 构建PDF URL
      const pdfUrl = `${this.baseUrl}/${paperId}.pdf`;
      const paperUrl = `${this.baseUrl}/${paperId}`;
      
      // 使用最后更新日期或当前日期作为发表日期
      const publishedDate = lastUpdated || new Date();
      
      return PaperFactory.create({
        paperId: paperId,
        title: this.cleanText(title),
        authors: authors,
        abstract: this.cleanText(abstract),
        doi: '',
        publishedDate: publishedDate,
        pdfUrl: pdfUrl,
        url: paperUrl,
        source: 'iacr',
        updatedDate: lastUpdated || undefined,
        categories: [],
        keywords: keywords,
        citationCount: 0,
        year: publishedDate.getFullYear(),
        extra: {
          iacrId: paperId,
          publicationInfo: publicationInfo,
          history: historyEntries.join('; ')
        }
      });
    } catch (error) {
      logDebug('Error parsing IACR paper details:', error);
      return null;
    }
  }

  /**
   * 获取随机User-Agent
   */
  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}