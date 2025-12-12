/**
 * Sci-Hub 论文搜索和下载器
 * 支持多镜像站点轮询、自动健康检测和故障转移
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { logDebug, logWarn } from '../utils/Logger.js';
import { TIMEOUTS } from '../config/constants.js';

interface MirrorSite {
  url: string;
  lastChecked?: Date;
  responseTime?: number;
  isWorking: boolean;
  failureCount: number;
}

export class SciHubSearcher extends PaperSource {
  private mirrorSites: MirrorSite[];
  private currentMirrorIndex: number = 0;
  private axiosInstance: AxiosInstance;
  private readonly maxRetries: number = 3;
  private readonly mirrorTestTimeout: number = TIMEOUTS.HEALTH_CHECK;
  private lastHealthCheck: Date | null = null;
  private readonly healthCheckInterval: number = 300000; // 5 minutes

  constructor() {
    super('Sci-Hub', 'https://sci-hub.se');
    
    // 初始化镜像站点列表
    this.mirrorSites = [
      { url: 'https://sci-hub.se', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.st', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.ru', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.ren', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.mksa.top', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.ee', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.wf', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.yt', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.sci-hub.se', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.sci-hub.st', isWorking: true, failureCount: 0 },
      { url: 'https://sci-hub.sci-hub.ru', isWorking: true, failureCount: 0 },
    ];

    this.axiosInstance = axios.create({
      timeout: TIMEOUTS.DEFAULT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      maxRedirects: 5,
      validateStatus: (status) => status < 500
    });
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true,
      fullText: false,
      citations: false,
      requiresApiKey: false,
      supportedOptions: ['maxResults']
    };
  }

  /**
   * 检测所有镜像站点的健康状态
   */
  private async checkMirrorHealth(): Promise<void> {
    logDebug('Checking Sci-Hub mirror sites health...');
    
    const healthPromises = this.mirrorSites.map(async (mirror, index) => {
      try {
        const startTime = Date.now();
        const response = await axios.get(mirror.url, {
          timeout: this.mirrorTestTimeout,
          headers: this.axiosInstance.defaults.headers as any,
          maxRedirects: 2
        });
        
        const responseTime = Date.now() - startTime;
        
        // 检查响应是否包含 Sci-Hub 特征
        const html = response.data;
        const isValidSciHub = html.includes('sci-hub') || 
                             html.includes('Sci-Hub') || 
                             html.includes('alexandra elbakyan');
        
        this.mirrorSites[index] = {
          ...mirror,
          lastChecked: new Date(),
          responseTime,
          isWorking: response.status === 200 && isValidSciHub,
          failureCount: 0
        };
        
        if (this.mirrorSites[index].isWorking) {
          logDebug(`${mirror.url} - OK (${responseTime}ms)`);
        } else {
          logDebug(`${mirror.url} - Invalid response`);
        }
      } catch (error) {
        this.mirrorSites[index] = {
          ...mirror,
          lastChecked: new Date(),
          isWorking: false,
          failureCount: mirror.failureCount + 1
        };
        logDebug(`${mirror.url} - Failed`);
      }
    });

    await Promise.allSettled(healthPromises);
    
    // 按响应时间排序可用的镜像
    this.mirrorSites.sort((a, b) => {
      if (a.isWorking && !b.isWorking) return -1;
      if (!a.isWorking && b.isWorking) return 1;
      if (a.isWorking && b.isWorking) {
        return (a.responseTime || Infinity) - (b.responseTime || Infinity);
      }
      return 0;
    });

    this.lastHealthCheck = new Date();
    
    const workingCount = this.mirrorSites.filter(m => m.isWorking).length;
    logDebug(`Health check complete: ${workingCount}/${this.mirrorSites.length} mirrors working`);
    
    if (workingCount === 0) {
      logWarn('Warning: No Sci-Hub mirrors are currently accessible!');
    }
  }

  /**
   * 获取当前可用的镜像站点
   */
  private async getCurrentMirror(): Promise<string> {
    // 定期进行健康检查
    if (!this.lastHealthCheck || 
        Date.now() - this.lastHealthCheck.getTime() > this.healthCheckInterval) {
      await this.checkMirrorHealth();
    }

    // 找到第一个可用的镜像
    const workingMirror = this.mirrorSites.find(m => m.isWorking);
    if (!workingMirror) {
      // 如果没有可用镜像，重新检测
      await this.checkMirrorHealth();
      const retryMirror = this.mirrorSites.find(m => m.isWorking);
      if (!retryMirror) {
        throw new Error('No working Sci-Hub mirrors available');
      }
      return retryMirror.url;
    }
    
    return workingMirror.url;
  }

  /**
   * 标记镜像站点失败并切换到下一个
   */
  private async markMirrorFailed(mirrorUrl: string): Promise<string> {
    const mirrorIndex = this.mirrorSites.findIndex(m => m.url === mirrorUrl);
    if (mirrorIndex !== -1) {
      this.mirrorSites[mirrorIndex].failureCount++;
      if (this.mirrorSites[mirrorIndex].failureCount >= 3) {
        this.mirrorSites[mirrorIndex].isWorking = false;
        logDebug(`Mirror ${mirrorUrl} marked as failed after multiple attempts`);
      }
    }

    // 尝试下一个镜像
    const nextWorkingMirror = this.mirrorSites.find((m, idx) => 
      idx > mirrorIndex && m.isWorking
    );
    
    if (nextWorkingMirror) {
      return nextWorkingMirror.url;
    }
    
    // 如果没有更多镜像，重新检测健康状态
    await this.checkMirrorHealth();
    return this.getCurrentMirror();
  }

  /**
   * 通过 DOI 或 URL 搜索论文
   */
  async search(query: string, options?: SearchOptions): Promise<Paper[]> {
    // Sci-Hub 主要通过 DOI 或直接 URL 工作
    // 如果输入不是 DOI 或 URL，返回空结果
    if (!this.isValidDOIOrURL(query)) {
      return [];
    }

    try {
      const paperInfo = await this.fetchPaperInfo(query);
      if (paperInfo) {
        return [paperInfo];
      }
    } catch (error) {
      logDebug('Sci-Hub search error:', error);
    }
    
    return [];
  }

  /**
   * 验证输入是否为有效的 DOI 或 URL
   */
  private isValidDOIOrURL(input: string): boolean {
    // DOI 模式：10.xxxx/xxxxx
    const doiPattern = /^10\.\d{4,}\/[-._;()\/:a-zA-Z0-9]+$/;
    
    // URL 模式
    const urlPattern = /^https?:\/\/.+/;
    
    // 也接受带有 doi: 前缀的格式
    const doiPrefixPattern = /^doi:\s*10\.\d{4,}\/[-._;()\/:a-zA-Z0-9]+$/i;
    
    return doiPattern.test(input) || 
           urlPattern.test(input) || 
           doiPrefixPattern.test(input);
  }

  /**
   * 从 Sci-Hub 获取论文信息
   */
  private async fetchPaperInfo(doiOrUrl: string): Promise<Paper | null> {
    let currentMirror = await this.getCurrentMirror();
    let retries = 0;
    
    // 清理 DOI 格式
    const cleanedQuery = doiOrUrl.replace(/^doi:\s*/i, '');
    
    while (retries < this.maxRetries) {
      try {
        const searchUrl = `${currentMirror}/${cleanedQuery}`;
        logDebug(`Searching on ${currentMirror} for: ${cleanedQuery}`);
        
        const response = await this.axiosInstance.get(searchUrl);
        
        if (response.status === 200) {
          const $ = cheerio.load(response.data);
          
          // 检查是否找到论文
          const pdfFrame = $('#pdf');
          const pdfEmbed = $('embed[type="application/pdf"]');
          const pdfIframe = $('iframe[src*=".pdf"]');
          
          let pdfUrl = '';
          
          // 尝试多种方式获取 PDF URL
          if (pdfFrame.length > 0) {
            pdfUrl = pdfFrame.attr('src') || '';
          } else if (pdfEmbed.length > 0) {
            pdfUrl = pdfEmbed.attr('src') || '';
          } else if (pdfIframe.length > 0) {
            pdfUrl = pdfIframe.attr('src') || '';
          } else {
            // 查找下载按钮
            const downloadButton = $('button[onclick*="download"]');
            if (downloadButton.length > 0) {
              const onclickAttr = downloadButton.attr('onclick') || '';
              const match = onclickAttr.match(/location\.href='([^']+)'/);
              if (match) {
                pdfUrl = match[1];
              }
            }
          }
          
          // 处理相对 URL
          if (pdfUrl && !pdfUrl.startsWith('http')) {
            if (pdfUrl.startsWith('//')) {
              pdfUrl = 'https:' + pdfUrl;
            } else if (pdfUrl.startsWith('/')) {
              pdfUrl = currentMirror + pdfUrl;
            }
          }
          
          if (pdfUrl) {
            // 提取标题（尝试从页面标题或 citation 信息获取）
            let title = $('title').text();
            const citation = $('#citation').text();
            if (citation) {
              // 从引用信息中提取标题
              const titleMatch = citation.match(/([^.]+)\./);
              if (titleMatch) {
                title = titleMatch[1].trim();
              }
            }
            
            // 清理标题
            title = title.replace(/\s*\|\s*Sci-Hub.*$/, '')
                        .replace(/Sci-Hub\s*:\s*/, '')
                        .trim();
            
            return PaperFactory.create({
              paperId: cleanedQuery,
              title: title || `Paper: ${cleanedQuery}`,
              source: 'scihub',
              authors: [],
              abstract: '',
              doi: this.isValidDOIOrURL(cleanedQuery) && cleanedQuery.includes('10.') 
                   ? cleanedQuery 
                   : '',
              publishedDate: null,
              pdfUrl: pdfUrl,
              url: searchUrl,
              extra: {
                mirror: currentMirror,
                fetchedAt: new Date().toISOString()
              }
            });
          } else {
            logDebug(`Paper not found on ${currentMirror}`);
            currentMirror = await this.markMirrorFailed(currentMirror);
            retries++;
          }
        } else {
          logDebug(`Unexpected status ${response.status} from ${currentMirror}`);
          currentMirror = await this.markMirrorFailed(currentMirror);
          retries++;
        }
      } catch (error: any) {
        logDebug(`Error fetching from ${currentMirror}:`, error.message);
        currentMirror = await this.markMirrorFailed(currentMirror);
        retries++;
      }
    }
    
    return null;
  }

  /**
   * 下载 PDF 文件
   */
  async downloadPdf(paperId: string, options?: DownloadOptions): Promise<string> {
    const savePath = options?.savePath || './downloads';
    
    // 确保下载目录存在
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    // 首先获取论文信息
    const paperInfo = await this.fetchPaperInfo(paperId);
    if (!paperInfo || !paperInfo.pdfUrl) {
      throw new Error(`Cannot find PDF for: ${paperId}`);
    }

    const fileName = `${paperId.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const filePath = path.join(savePath, fileName);

    // 检查文件是否已存在
    if (fs.existsSync(filePath) && !options?.overwrite) {
      return filePath;
    }

    // 下载 PDF
    let retries = 0;
    let currentPdfUrl = paperInfo.pdfUrl;
    
    while (retries < this.maxRetries) {
      try {
        logDebug(`Downloading PDF from: ${currentPdfUrl}`);
        
        const response = await this.axiosInstance.get(currentPdfUrl, {
          responseType: 'stream',
          timeout: TIMEOUTS.DOWNLOAD
        });

        if (response.status === 200) {
          const writer = fs.createWriteStream(filePath);
          response.data.pipe(writer);

          return new Promise((resolve, reject) => {
            writer.on('finish', () => {
              resolve(filePath);
            });
            writer.on('error', reject);
          });
        } else {
          throw new Error(`Failed to download PDF: status ${response.status}`);
        }
      } catch (error: any) {
        logDebug(`Download attempt ${retries + 1} failed:`, error.message);
        retries++;
        
        if (retries < this.maxRetries) {
          // 尝试重新获取论文信息（可能 PDF URL 已更改）
          const updatedInfo = await this.fetchPaperInfo(paperId);
          if (updatedInfo?.pdfUrl && updatedInfo.pdfUrl !== currentPdfUrl) {
            currentPdfUrl = updatedInfo.pdfUrl;
            logDebug('Trying updated PDF URL...');
          } else {
            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, 2000 * retries));
          }
        }
      }
    }

    throw new Error(`Failed to download PDF after ${this.maxRetries} attempts`);
  }

  /**
   * 读取论文内容（Sci-Hub 不提供文本提取）
   */
  async readPaper(paperId: string, options?: DownloadOptions): Promise<string> {
    // Sci-Hub 只提供 PDF 下载，不提供文本提取
    const filePath = await this.downloadPdf(paperId, options);
    return `PDF downloaded to: ${filePath}. Please use a PDF reader to view the content.`;
  }

  /**
   * 根据 DOI 获取论文
   */
  async getPaperByDoi(doi: string): Promise<Paper | null> {
    return this.fetchPaperInfo(doi);
  }

  /**
   * 获取镜像站点状态
   */
  getMirrorStatus(): { url: string; status: string; responseTime?: number }[] {
    return this.mirrorSites.map(mirror => ({
      url: mirror.url,
      status: mirror.isWorking ? 'Working' : 'Failed',
      responseTime: mirror.responseTime
    }));
  }

  /**
   * 手动触发健康检查
   */
  async forceHealthCheck(): Promise<void> {
    await this.checkMirrorHealth();
  }
}
