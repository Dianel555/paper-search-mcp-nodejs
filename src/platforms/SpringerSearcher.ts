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
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { RateLimiter } from '../utils/RateLimiter.js';

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

  constructor(apiKey?: string, openAccessApiKey?: string) {
    super('springer', 'https://api.springernature.com', apiKey);
    
    // Check for separate OpenAccess API key from environment
    this.openAccessApiKey = openAccessApiKey || process.env.SPRINGER_OPENACCESS_API_KEY || apiKey;
    
    // Use v2 API endpoint for metadata
    this.metadataClient = axios.create({
      baseURL: 'https://api.springernature.com/meta/v2',
      headers: {
        'Accept': 'application/json'
      }
    });

    // OpenAccess API client (may not be available for all API keys)
    this.openAccessClient = axios.create({
      baseURL: 'https://api.springernature.com/openaccess',
      headers: {
        'Accept': 'application/json'
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
        console.log('OpenAccess API not available, using Meta API with filtering');
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
        params.q += ` name:"${options.author}"`;
      }

      if (options.journal) {
        params.q += ` pub:"${options.journal}"`;
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
        params.q += ` subject:"${customOptions.subject}"`;
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
      console.error('Springer search error:', error.message);
      if (error.response?.status === 401) {
        throw new Error('Invalid or missing Springer API key. Please check your API key.');
      }
      if (error.response?.status === 403) {
        // Some filters require premium access
        console.warn('Springer API returned 403 - some filters may require premium access');
        // Try a simpler query without advanced filters
        if (options.year || customOptions.subject) {
          console.log('Retrying without year/subject filters...');
          const simpleOptions = { ...options };
          delete simpleOptions.year;
          delete (simpleOptions as any).subject;
          return this.search(query, simpleOptions);
        }
        throw new Error('Springer API access forbidden. Some filters require premium access.');
      }
      if (error.response?.status === 429) {
        throw new Error('Springer rate limit exceeded. Please try again later.');
      }
      throw error;
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
        source: 'Springer',
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
      console.error('Error parsing Springer result:', error);
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
      download: true, // For papers with available PDFs
      fullText: false,
      citations: false,
      requiresApiKey: true,
      supportedOptions: ['maxResults', 'year', 'author', 'journal']
    };
  }

  /**
   * Test if OpenAccess API is available for this API key
   */
  private async testOpenAccessAPI(): Promise<void> {
    if (this.hasOpenAccessAPI !== undefined) {
      return;
    }
    
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
      console.log('OpenAccess API is available');
    } catch (error: any) {
      if (error.response?.status === 401) {
        this.hasOpenAccessAPI = false;
        console.log('OpenAccess API is not available (401 Unauthorized - check API key permissions)');
      } else {
        // Network error or other issue, assume not available
        this.hasOpenAccessAPI = false;
        console.log('OpenAccess API test failed:', error.message);
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
