/**
 * Crossref API Integration
 * 
 * Crossref is a DOI registration agency providing free access to scholarly metadata.
 * No API key required, but providing email (mailto parameter) is recommended for polite pool access.
 * 
 * Documentation: https://api.crossref.org/
 */

import axios, { AxiosInstance } from 'axios';
import { Paper, PaperFactory } from '../models/Paper.js';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { withTimeout } from '../utils/SecurityUtils.js';

export class CrossrefSearcher extends PaperSource {
  private client: AxiosInstance;
  private mailto: string;

  constructor(mailto?: string) {
    super('crossref', 'https://api.crossref.org/works', undefined);
    this.mailto = mailto || process.env.CROSSREF_MAILTO || 'paper-search-mcp@example.com';
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': `paper-search-mcp-nodejs/0.2.2 (mailto:${this.mailto})`
      }
    });
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: false,
      fullText: false,
      citations: true,
      requiresApiKey: false,
      supportedOptions: ['maxResults', 'year', 'author', 'sortBy', 'sortOrder']
    };
  }

  /**
   * Clean and validate DOI format
   * @param doi Raw DOI string (may include URL prefixes)
   * @returns Cleaned DOI or null if invalid
   */
  private cleanAndValidateDoi(doi: string): string | null {
    if (!doi) return null;
    
    const cleanDoi = doi
      .replace('https://doi.org/', '')
      .replace('http://dx.doi.org/', '')
      .replace('doi:', '')
      .trim();

    // DOIs must start with '10.'
    if (!cleanDoi || !cleanDoi.startsWith('10.')) {
      return null;
    }

    return cleanDoi;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const maxResults = Math.min(options.maxResults || 10, 1000);
    
    const params: Record<string, any> = {
      query: query,
      rows: maxResults,
      mailto: this.mailto
    };

    // Build filters
    const filters: string[] = [];

    // Year filter
    if (options.year) {
      const yearMatch = options.year.match(/^(\d{4})(?:-(\d{4})?)?$/);
      if (yearMatch) {
        const startYear = yearMatch[1];
        const endYear = yearMatch[2] || startYear;
        if (startYear) {
          filters.push(`from-pub-date:${startYear}`);
        }
        if (endYear && endYear !== startYear) {
          filters.push(`until-pub-date:${endYear}`);
        }
      }
    }

    // Add filters
    if (filters.length > 0) {
      params.filter = filters.join(',');
    }

    // Sorting
    const sortMapping: Record<string, string> = {
      'relevance': 'relevance',
      'date': 'published',
      'citations': 'is-referenced-by-count'
    };
    params.sort = sortMapping[options.sortBy || 'relevance'] || 'relevance';
    params.order = options.sortOrder === 'asc' ? 'asc' : 'desc';

    try {
      const response = await this.client.get('', { params });
      
      if (response.status === 200 && response.data?.message?.items) {
        return this.parseSearchResponse(response.data);
      }
      
      return [];
    } catch (error: any) {
      console.error('Crossref search error:', error.message);
      return [];
    }
  }

  async getPaperByDoi(doi: string): Promise<Paper | null> {
    const cleanDoi = this.cleanAndValidateDoi(doi);
    if (!cleanDoi) {
      console.error('Invalid DOI format:', doi);
      return null;
    }

    try {
      // Encode DOI for URL path (DOIs can contain special characters like /)
      const encodedDoi = encodeURIComponent(cleanDoi);
      const response = await this.client.get(`/${encodedDoi}`, {
        params: { mailto: this.mailto }
      });

      if (response.status === 200 && response.data?.message) {
        const paper = this.parsePaper(response.data.message);
        
        // Extract references
        if (paper) {
          const references = this.extractReferenceDois(response.data.message);
          paper.references = references;
        }
        
        return paper;
      }
      
      return null;
    } catch (error: any) {
      console.error(`Crossref get paper error for DOI ${doi}:`, error.message);
      return null;
    }
  }

  async getCitations(doi: string): Promise<Paper[]> {
    // Crossref API doesn't directly provide citations
    // Use OpenCitations COCI API as supplement
    
    const cleanDoi = this.cleanAndValidateDoi(doi);
    if (!cleanDoi) {
      console.error('Invalid DOI format for citations:', doi);
      return [];
    }

    try {
      // Encode DOI for URL path
      const encodedDoi = encodeURIComponent(cleanDoi);
      
      // Wrap with timeout for additional protection
      const response = await withTimeout(
        axios.get(
          `https://opencitations.net/index/coci/api/v1/citations/${encodedDoi}`,
          { timeout: 30000 }
        ),
        35000, // Slightly longer than axios timeout
        'OpenCitations API request timed out'
      );

      if (response.status !== 200) {
        return [];
      }

      const citingDois: string[] = [];
      for (const item of response.data || []) {
        if (item.citing) {
          citingDois.push(item.citing);
        }
      }

      if (citingDois.length === 0) {
        return [];
      }

      // Fetch citing papers (limit to 50)
      const papers: Paper[] = [];
      for (const citingDoi of citingDois.slice(0, 50)) {
        try {
          const paper = await this.getPaperByDoi(citingDoi);
          if (paper) {
            papers.push(paper);
          }
        } catch (error) {
          // Skip failed DOIs
        }
      }

      return papers;
    } catch (error: any) {
      console.error('Error getting citations from OpenCitations:', error.message);
      return [];
    }
  }

  async getReferences(doi: string): Promise<Paper[]> {
    try {
      const paper = await this.getPaperByDoi(doi);
      if (!paper || !paper.references || paper.references.length === 0) {
        return [];
      }

      // Fetch reference papers (limit to 50)
      const papers: Paper[] = [];
      for (const refDoi of paper.references.slice(0, 50)) {
        try {
          const refPaper = await this.getPaperByDoi(refDoi);
          if (refPaper) {
            papers.push(refPaper);
          }
        } catch (error) {
          // Skip failed DOIs
        }
      }

      return papers;
    } catch (error: any) {
      console.error('Error getting Crossref references:', error.message);
      return [];
    }
  }

  async downloadPdf(paperId: string, options?: DownloadOptions): Promise<string> {
    throw new Error('Crossref does not support direct PDF download');
  }

  async readPaper(paperId: string, options?: DownloadOptions): Promise<string> {
    throw new Error('Crossref does not support full text extraction');
  }

  private parseSearchResponse(data: any): Paper[] {
    const papers: Paper[] = [];
    const items = data.message?.items || [];

    for (const item of items) {
      const paper = this.parsePaper(item);
      if (paper) {
        papers.push(paper);
      }
    }

    return papers;
  }

  private parsePaper(data: any): Paper | null {
    try {
      const doi = data.DOI || '';
      
      // Extract title
      const titleList = data.title || [];
      const title = titleList[0] || 'No title';

      // Extract authors
      const authors: string[] = [];
      for (const author of data.author || []) {
        const given = author.given || '';
        const family = author.family || '';
        const fullName = `${given} ${family}`.trim();
        if (fullName) {
          authors.push(fullName);
        }
      }

      // Extract abstract - may contain HTML tags
      let abstract = data.abstract || '';
      if (abstract) {
        // Remove HTML tags
        abstract = abstract.replace(/<[^>]+>/g, '');
      }

      // Extract publication date
      let publishedDate: Date | null = null;
      let year: number | undefined;

      const dateData = data['published-print'] || 
                       data['published-online'] || 
                       data['published'] || 
                       data['created'];

      if (dateData && dateData['date-parts']?.[0]) {
        const dateParts = dateData['date-parts'][0];
        if (dateParts.length > 0 && typeof dateParts[0] === 'number') {
          year = dateParts[0];
          const month = dateParts[1] || 1;
          const day = dateParts[2] || 1;
          try {
            publishedDate = new Date(year as number, month - 1, day);
          } catch {
            // Ignore date parsing errors
          }
        }
      }

      // Extract journal name
      const containerTitleList = data['container-title'] || [];
      const journal = containerTitleList[0] || undefined;

      // Extract publisher
      const publisher = data.publisher || '';

      // Extract citation count
      const citationCount = data['is-referenced-by-count'] || 0;

      // Extract URL
      const url = data.URL || (doi ? `https://doi.org/${doi}` : '');

      // Extract pages, volume, issue
      const pages = data.page || undefined;
      const volume = data.volume || undefined;
      const issue = data.issue || undefined;

      // Document type
      const docType = data.type || '';

      return PaperFactory.create({
        paperId: doi,
        title: title,
        authors: authors,
        abstract: abstract,
        source: 'crossref',
        publishedDate: publishedDate,
        year: year,
        journal: journal,
        doi: doi,
        url: url,
        pdfUrl: '',
        volume: volume,
        issue: issue,
        pages: pages,
        citationCount: citationCount,
        extra: {
          publisher: publisher,
          type: docType,
          issn: data.ISSN || [],
          isbn: data.ISBN || [],
          subjects: data.subject || []
        }
      });
    } catch (error: any) {
      console.error('Error parsing Crossref paper:', error.message);
      return null;
    }
  }

  private extractReferenceDois(data: any): string[] {
    const references: string[] = [];
    const referenceData = data.reference || [];

    for (const ref of referenceData) {
      const doi = ref.DOI;
      if (doi) {
        references.push(doi);
      }
    }

    return references;
  }
}
