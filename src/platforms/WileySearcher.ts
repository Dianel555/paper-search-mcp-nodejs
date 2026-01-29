/**
 * Wiley TDM (Text and Data Mining) API - PDF Download Only
 * 
 * Documentation: https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining
 * GitHub Client: https://github.com/WileyLabs/tdm-client
 * 
 * IMPORTANT: Wiley TDM API does NOT support keyword search.
 * It only supports downloading PDFs by DOI.
 * For searching Wiley content, use Crossref API with publisher filter.
 * 
 * API Endpoint: https://api.wiley.com/onlinelibrary/tdm/v1/articles/{DOI}
 * Header: Wiley-TDM-Client-Token: <token>
 * 
 * Rate limits:
 * - Up to 3 articles per second
 * - Up to 60 requests per 10 minutes (build in 10 second delay between requests)
 */

import axios, { AxiosInstance } from 'axios';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import { sanitizeDoi } from '../utils/SecurityUtils.js';
import { TIMEOUTS } from '../config/constants.js';

export class WileySearcher extends PaperSource {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor(tdmToken?: string) {
    super('wiley', 'https://api.wiley.com/onlinelibrary/tdm/v1', tdmToken);
    
    this.client = axios.create({
      baseURL: 'https://api.wiley.com/onlinelibrary/tdm/v1',
      headers: {
        'Accept': 'application/pdf',
        ...(tdmToken ? { 'Wiley-TDM-Client-Token': tdmToken } : {})
      },
      maxRedirects: 5,
      timeout: TIMEOUTS.EXTENDED
    });

    // Wiley rate limits: 3 articles/sec, 60 requests/10min
    this.rateLimiter = new RateLimiter({
      requestsPerSecond: 0.1, // Conservative: ~6 per minute
      burstCapacity: 3
    });
  }

  /**
   * Search is NOT supported by Wiley TDM API.
   * Use Crossref API to search for Wiley articles, then use download() to get PDFs.
   */
  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    throw new Error(
      'Wiley TDM API does not support keyword search. ' +
      'Use Crossref API (search_crossref) to find Wiley articles by DOI, ' +
      'then use download_paper with platform="wiley" to download PDFs.'
    );
  }

  /**
   * Download PDF by DOI using Wiley TDM API
   * @param doi - The DOI of the article (e.g., "10.1111/jtsb.12390")
   * @param options - Download options including savePath
   */
  async downloadPdf(doi: string, options: { savePath?: string } = {}): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Wiley TDM token is required. Set WILEY_TDM_TOKEN environment variable.');
    }

    // Clean and validate DOI format
    const doiResult = sanitizeDoi(doi);
    if (!doiResult.valid) {
      throw new Error(`Invalid DOI format: ${doi}. ${doiResult.error || ''}`);
    }
    const cleanDoi = doiResult.sanitized;

    const fs = await import('fs');
    const path = await import('path');
    
    const savePath = options.savePath || './downloads';
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    // Encode DOI for URL (replace / with %2F)
    const encodedDoi = encodeURIComponent(cleanDoi);
    const url = `/articles/${encodedDoi}`;

    await this.rateLimiter.waitForPermission();

    try {
      const response = await ErrorHandler.retryWithBackoff(
        () => this.client.get(url, {
          responseType: 'stream',
          headers: {
            'Wiley-TDM-Client-Token': this.apiKey,
            'Accept': 'application/pdf'
          }
        }),
        { context: 'Wiley download' }
      );

      // Generate filename from DOI
      const fileName = `${cleanDoi.replace(/[\/\\:*?"<>|]/g, '_')}.pdf`;
      const filePath = path.join(savePath, fileName);

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(filePath));
        writer.on('error', reject);
      });
    } catch (error: any) {
      const status = error.response?.status;
      const errorMessages: Record<number, string> = {
        400: 'No TDM Client Token was found in the request',
        403: 'TDM Client Token is invalid or not registered',
        404: 'Access denied - you or your institution does not have access to this content. Check your subscription.',
        429: 'Rate limit exceeded. Please reduce request frequency (max 60 requests per 10 minutes).'
      };
      
      if (status && errorMessages[status]) {
        throw new Error(`Wiley TDM Error (${status}): ${errorMessages[status]}`);
      }
      throw new Error(`Failed to download PDF: ${error.message}`);
    }
  }

  /**
   * Get article metadata and download link (without downloading)
   */
  async getArticleInfo(doi: string): Promise<Paper> {
    // Clean and validate DOI
    const doiResult = sanitizeDoi(doi);
    const cleanDoi = doiResult.valid ? doiResult.sanitized : doi;

    // Since TDM API only provides PDF download, we create basic paper info from DOI
    return PaperFactory.create({
      paperId: cleanDoi,
      title: `Wiley Article: ${cleanDoi}`,
      authors: [],
      abstract: '',
      doi: cleanDoi,
      publishedDate: null,
      pdfUrl: `https://api.wiley.com/onlinelibrary/tdm/v1/articles/${encodeURIComponent(cleanDoi)}`,
      url: `https://doi.org/${cleanDoi}`,
      source: 'wiley',
      extra: {
        note: 'Use Crossref API for full metadata. This endpoint only provides PDF download.'
      }
    });
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: false, // TDM API does not support search
      download: true, // PDF download by DOI
      fullText: true, // Full PDF available
      citations: false,
      requiresApiKey: true,
      supportedOptions: [] // No search options - only DOI-based download
    };
  }

  async readPaper(paperId: string, options: DownloadOptions = {}): Promise<string> {
    return 'Wiley TDM API only supports PDF download. Use downloadPdf() method with a DOI to get the full PDF.';
  }
}
