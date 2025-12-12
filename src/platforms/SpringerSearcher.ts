/**
 * Springer Nature Searcher
 * 
 * Documentation: https://dev.springernature.com/
 * API Endpoints:
 * - Metadata API v2: https://api.springernature.com/meta/v2/json
 * - OpenAccess API: https://api.springernature.com/openaccess/json (if available with your key)
 * 
 * Required API Key: Yes (api_key parameter)
 * Get API key from: https://dev.springernature.com/signup
 * 
 * Note: Meta API v2 is the primary API. OpenAccess API may require special access.
 */

import axios, { AxiosInstance } from 'axios';
import { sanitizeDoi, escapeQueryValue, withTimeout, validateQueryComplexity } from '../utils/SecurityUtils.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { logDebug, logWarn } from '../utils/Logger.js';
import { TIMEOUTS, USER_AGENT } from '../config/constants.js';

interface SpringerResponse {
  // Meta v2 API structure
  records?: SpringerResult[];  // v2 API: actual paper records
  result?: Array<{             // v2 API: search metadata
    total: string;
    start: string;
    pageLength: string;
    recordsDisplayed: string;
  }>;
  // Common fields
  apiMessage?: string;
  facets?: any[];
  query?: string;
  nextPage?: string;
}

interface SpringerResult {
  identifier: string;
  title: string;
  creators?: Array<{ creator: string }>;
  publicationName?: string;
  publicationDate?: string;
  doi?: string;
  url?: Array<{ format: string; platform: string; value: string }>;
  abstract?: string;
  volume?: string;
  number?: string;
  startingPage?: string;
  endingPage?: string;
  isbn?: string;
  issn?: string;
  genre?: string;
  contentType?: string;
  language?: string;
  openaccess?: string;
  copyright?: string;
}

export class SpringerSearcher extends PaperSource {
  private metadataClient: AxiosInstance;
  private openAccessClient: AxiosInstance;
  private rateLimiter: RateLimiter;
  private hasOpenAccessAPI: boolean | undefined;
  private openAccessApiKey?: string;
  private testingPromise: Promise<void> | null = null;

  constructor(apiKey?: string, openAccessApiKey?: string) {
    super('springer', 'https://api.springernature.com', apiKey);
    
    // Check for separate OpenAccess API key from environment
    this.openAccessApiKey = openAccessApiKey || process.env.SPRINGER_OPENACCESS_API_KEY || apiKey;
    
    // Use v2 API endpoint for metadata
    this.metadataClient = axios.create({
      baseURL: 'https://api.springernature.com/meta/v2',
      timeout: TIMEOUTS.DEFAULT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });

    // OpenAccess API client (may not be available for all API keys)
    this.openAccessClient = axios.create({
      baseURL: 'https://api.springernature.com/openaccess',
      timeout: TIMEOUTS.DEFAULT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      }
    });

    // Springer rate limits:
    // - 5000 requests per day for both APIs combined
    // - Approximately 200 per hour or 3-4 per minute to be safe
    // Note: The same API key works for both Metadata and OpenAccess APIs
    this.rateLimiter = new RateLimiter({ 
      requestsPerSecond: 0.05, // Conservative: 3 per minute
      burstCapacity: 5
    });
  }

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const customOptions = options as any;
    if (!this.apiKey) {
      throw new Error('Springer API key is required');
    }

    const maxResults = Math.min(options.maxResults || 10, 100);
    const papers: Paper[] = [];

    try {
      // Decide which API to use
      let useOpenAccess = customOptions.openAccess === true;
      
      // If openAccess is requested and we haven't tested the API yet, test it
      if (useOpenAccess && this.hasOpenAccessAPI === undefined) {
        await this.testOpenAccessAPI();
      }
      
      // Fall back to Meta API if OpenAccess API is not available
      if (useOpenAccess && !this.hasOpenAccessAPI) {
        logDebug('OpenAccess API not available, using Meta API with filtering');
        useOpenAccess = false;
      }
      
      // Build query parameters
      const params: any = {
        q: query,
        api_key: useOpenAccess ? this.openAccessApiKey : this.apiKey,
        s: 1, // start index
        p: maxResults // page size
      };

      // Add filters - Note: Some filters may require premium access
      if (options.author) {
        const sanitizedAuthor = this.sanitizeQueryValue(options.author);
        params.q += ` name:"${sanitizedAuthor}"`;
      }

      if (options.journal) {
        const sanitizedJournal = this.sanitizeQueryValue(options.journal);
        params.q += ` pub:"${sanitizedJournal}"`;
      }

      if (options.year) {
        // Year filter may cause 403 for some API keys
        if (options.year.includes('-')) {
          const [startYear, endYear] = options.year.split('-');
          params.q += ` year:${startYear} TO ${endYear || '*'}`;
        } else {
          params.q += ` year:${options.year}`;
        }
      }

      if (customOptions.subject) {
        // Subject filter may cause 403 for some API keys
        const sanitizedSubject = this.sanitizeQueryValue(customOptions.subject);
        params.q += ` subject:"${sanitizedSubject}"`;
      }

      if (customOptions.type) {
        // Type filter generally works
        params.q += ` type:${customOptions.type}`;
      }

      await this.rateLimiter.waitForPermission();

      // Choose the appropriate API
      let response: any;
      if (useOpenAccess) {
        // Use OpenAccess API (if available)
        response = await this.openAccessClient.get<SpringerResponse>('/json', { params });
      } else {
        // Use Meta v2 API
        response = await this.metadataClient.get<SpringerResponse>('/json', { params });
      }

      // Handle different response structures
      // Meta v2 API: records contains the actual papers, result contains metadata
      // OpenAccess API: might use either records or result for the actual papers
      let results: SpringerResult[] = [];
      
      // For Meta v2 API, records is always the array of papers
      if (response.data.records && Array.isArray(response.data.records)) {
        results = response.data.records;
      } 
      // For older API versions or different response format
      else if (response.data.result && Array.isArray(response.data.result) && 
               response.data.result.length > 0 && 
               response.data.result[0].title) {
        // If result contains actual papers (has title field), use it
        results = response.data.result as SpringerResult[];
      }
      
      if (results && results.length > 0) {
        for (const result of results) {
          const paper = this.parseResult(result);
          if (paper) {
            // If openAccess filter was requested but using Meta API, filter results
            if (customOptions.openAccess && !useOpenAccess && result.openaccess !== 'true') {
              continue;
            }
            papers.push(paper);
          }
        }
      }

      return papers;
    } catch (error: any) {
      if (error.response?.status === 401) {
        this.handleHttpError(error, 'search');
      }
      if (error.response?.status === 403) {
        // Some filters require premium access
        logWarn('Springer API returned 403 - some filters may require premium access');
        // Try a simpler query without advanced filters
        if (options.year || customOptions.subject) {
          logDebug('Retrying without year/subject filters...');
          const simpleOptions = { ...options };
          delete simpleOptions.year;
          delete (simpleOptions as any).subject;
          return this.search(query, simpleOptions);
        }
        this.handleHttpError(error, 'search');
      }
      if (error.response?.status === 429) {
        this.handleHttpError(error, 'search');
      }
      this.handleHttpError(error, 'search');
    }
  }

  private parseResult(result: SpringerResult): Paper | null {
    try {
      // Extract authors
      const authors = result.creators?.map(c => c.creator).join(', ') || '';

      // Extract URL
      let paperUrl: string | undefined;
      let pdfUrl: string | undefined;
      
      if (result.url && result.url.length > 0) {
        for (const urlObj of result.url) {
          if (urlObj.format === 'pdf') {
            pdfUrl = urlObj.value;
          } else if (!paperUrl) {
            paperUrl = urlObj.value;
          }
        }
      }

      // If no URL found, construct from DOI
      if (!paperUrl && result.doi) {
        paperUrl = `https://doi.org/${result.doi}`;
      }

      // Extract page range
      let pages: string | undefined;
      if (result.startingPage && result.endingPage) {
        pages = `${result.startingPage}-${result.endingPage}`;
      } else if (result.startingPage) {
        pages = result.startingPage;
      }

      return PaperFactory.create({
        paperId: result.doi || result.identifier || '',
        title: result.title || '',
        authors: authors ? authors.split(', ') : [],
        abstract: result.abstract || '',
        doi: result.doi,
        publishedDate: result.publicationDate ? new Date(result.publicationDate) : null,
        pdfUrl: pdfUrl,
        url: paperUrl,
        source: 'springer',
        journal: result.publicationName,
        volume: result.volume,
        issue: result.number,
        pages: pages,
        extra: {
          isbn: result.isbn,
          issn: result.issn,
          contentType: result.contentType,
          genre: result.genre,
          language: result.language,
          openAccess: result.openaccess === 'true',
          copyright: result.copyright
        }
      });
    } catch (error) {
      logDebug('Error parsing Springer result:', error);
      return null;
    }
  }

  async downloadPdf(doi: string, options: { savePath?: string } = {}): Promise<string> {
    // Search for the paper and check if it has a PDF URL
    const papers = await this.search(doi, { maxResults: 1 });
    
    if (papers.length === 0) {
      throw new Error('Paper not found');
    }
    
    if (!papers[0].pdfUrl) {
      // Try searching with openAccess filter to get PDF links
      const openAccessPapers = await this.search(doi, { maxResults: 1, openAccess: true } as any);
      if (openAccessPapers.length === 0 || !openAccessPapers[0].pdfUrl) {
        throw new Error('PDF not available (may require institutional access or not be open access)');
      }
      papers[0] = openAccessPapers[0];
    }

    const paper = papers[0];
    if (!paper.pdfUrl) {
      throw new Error('PDF URL not available for this paper');
    }

    // Download PDF
    const fs = await import('fs');
    const path = await import('path');
    
    const savePath = options.savePath || './downloads';
    if (!fs.existsSync(savePath)) {
      fs.mkdirSync(savePath, { recursive: true });
    }

    const fileName = `${doi.replace(/[\/\\:*?"<>|]/g, '_')}.pdf`;
    const filePath = path.join(savePath, fileName);

    try {
      const response = await axios.get(paper.pdfUrl, {
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(filePath));
        writer.on('error', reject);
      });
    } catch (error: any) {
      throw new Error(`Failed to download PDF: ${error.message}`);
    }
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: true,
      fullText: false,
      citations: true,
      requiresApiKey: true,
      supportedOptions: ['maxResults', 'year', 'author', 'journal', 'openAccess', 'subject', 'type']
    };
  }

  /**
   * 获取引用此论文的文献列表(通过Crossref/OpenCitations)
   */
  async getCitations(doi: string): Promise<Paper[]> {
    try {
      // Validate DOI format
      if (!doi || typeof doi !== 'string') {
        throw new Error('Invalid DOI: must be a non-empty string');
      }

      // Sanitize and validate DOI
      const doiValidation = sanitizeDoi(doi);
      if (!doiValidation.valid) {
        throw new Error(`Invalid DOI: ${doiValidation.error}`);
      }

      const { CrossrefSearcher } = await import('./CrossrefSearcher.js');
      const crossref = new CrossrefSearcher();

      // Add timeout wrapper for Crossref API calls
      return await withTimeout(
        crossref.getCitations(doiValidation.sanitized),
        TIMEOUTS.HEALTH_CHECK,
        'Crossref citation request timed out'
      );
    } catch (error) {
      // Don't log the DOI in case it's sensitive
      logDebug('Error getting Springer citations:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  /**
   * 获取论文的参考文献列表(通过Crossref)
   */
  async getReferences(doi: string): Promise<Paper[]> {
    try {
      // Validate DOI format
      if (!doi || typeof doi !== 'string') {
        throw new Error('Invalid DOI: must be a non-empty string');
      }

      // Sanitize and validate DOI
      const doiValidation = sanitizeDoi(doi);
      if (!doiValidation.valid) {
        throw new Error(`Invalid DOI: ${doiValidation.error}`);
      }

      const { CrossrefSearcher } = await import('./CrossrefSearcher.js');
      const crossref = new CrossrefSearcher();

      // Add timeout wrapper for Crossref API calls
      return await withTimeout(
        crossref.getReferences(doiValidation.sanitized),
        TIMEOUTS.HEALTH_CHECK,
        'Crossref references request timed out'
      );
    } catch (error) {
      // Don't log the DOI in case it's sensitive
      logDebug('Error getting Springer references:', error instanceof Error ? error.message : 'Unknown error');
      return [];
    }
  }

  /**
   * 清理和转义查询参数中的特殊字符
   */
  private sanitizeQueryValue(value: string, context: 'author' | 'journal' | 'subject' | 'general' = 'general'): string {
    return escapeQueryValue(value, 'springer');
  }

  /**
   * Test if OpenAccess API is available for this API key
   * Uses promise caching to prevent race conditions with concurrent requests
   */
  private async testOpenAccessAPI(): Promise<void> {
    // Already tested
    if (this.hasOpenAccessAPI !== undefined) {
      return;
    }
    
    // Test already in progress - wait for it
    if (this.testingPromise) {
      return this.testingPromise;
    }
    
    // Start new test and cache the promise
    this.testingPromise = this.performOpenAccessTest();
    
    try {
      await this.testingPromise;
    } finally {
      this.testingPromise = null;
    }
  }

  /**
   * Perform the actual OpenAccess API test
   */
  private async performOpenAccessTest(): Promise<void> {
    try {
      const response = await this.openAccessClient.get('/json', {
        params: {
          q: 'test',
          api_key: this.openAccessApiKey,
          s: 1,
          p: 1
        }
      });
      this.hasOpenAccessAPI = response.status === 200;
      logDebug('OpenAccess API is available');
    } catch (error: any) {
      if (error.response?.status === 401) {
        this.hasOpenAccessAPI = false;
        logDebug('OpenAccess API is not available (401 Unauthorized - check API key permissions)');
      } else {
        // Network error or other issue, assume not available
        this.hasOpenAccessAPI = false;
        logDebug('OpenAccess API test failed:', error.message);
      }
    }
  }

  async readPaper(paperId: string, options: DownloadOptions = {}): Promise<string> {
    const papers = await this.search(paperId, { maxResults: 1 });
    if (papers.length === 0) {
      throw new Error('Paper not found');
    }
    return papers[0].abstract || 'Abstract not available';
  }
}
