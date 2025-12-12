/**
 * Scopus (Elsevier) Searcher
 * 
 * Documentation: https://dev.elsevier.com/documentation/SCOPUSSearchAPI.wadl
 * API Endpoints:
 * - Search API: https://api.elsevier.com/content/search/scopus
 * - Abstract API: https://api.elsevier.com/content/abstract/scopus_id/
 * 
 * Required API Key: Yes (X-ELS-APIKey header or apikey parameter)
 * Get API key from: https://dev.elsevier.com/apikey/manage
 * 
 * Scopus is the largest abstract and citation database of peer-reviewed literature
 */

import axios, { AxiosInstance } from 'axios';
import { PaperSource, SearchOptions, DownloadOptions, PlatformCapabilities } from './PaperSource.js';
import { Paper, PaperFactory } from '../models/Paper.js';
import { RateLimiter } from '../utils/RateLimiter.js';

interface ScopusSearchResponse {
  'search-results': {
    'opensearch:totalResults': string;
    'opensearch:startIndex': string;
    'opensearch:itemsPerPage': string;
    'opensearch:Query': {
      '@role': string;
      '@searchTerms': string;
      '@startPage': string;
    };
    entry?: ScopusEntry[];
    link?: Array<{
      '@ref': string;
      '@href': string;
      '@type': string;
    }>;
  };
}

interface ScopusEntry {
  '@_fa': string;
  'link': Array<{
    '@ref': string;
    '@href': string;
    '@type'?: string;
  }>;
  'prism:url': string;
  'dc:identifier': string;
  'eid': string;
  'dc:title': string;
  'dc:creator'?: string;
  'prism:publicationName'?: string;
  'prism:issn'?: string;
  'prism:eIssn'?: string;
  'prism:volume'?: string;
  'prism:issueIdentifier'?: string;
  'prism:pageRange'?: string;
  'prism:coverDate'?: string;
  'prism:coverDisplayDate'?: string;
  'prism:doi'?: string;
  'citedby-count'?: string;
  'affiliation'?: Array<{
    '@_fa': string;
    'affilname': string;
    'affiliation-city': string;
    'affiliation-country': string;
  }>;
  'prism:aggregationType': string;
  'subtype': string;
  'subtypeDescription': string;
  'author'?: Array<{
    '@_fa': string;
    'authid': string;
    'authname': string;
    'surname': string;
    'given-name': string;
    'initials': string;
    'afid': Array<{ '$': string }>;
  }>;
  'authkeywords'?: string;
  'article-number'?: string;
  'fund-acr'?: string;
  'fund-no'?: string;
  'fund-sponsor'?: string;
  'openaccess'?: string;
  'openaccessFlag'?: boolean;
}

interface ScopusAbstractResponse {
  'abstracts-retrieval-response': {
    coredata: {
      'dc:identifier': string;
      'eid': string;
      'dc:title': string;
      'dc:creator'?: Array<{ '$': string }>;
      'prism:publicationName'?: string;
      'prism:issn'?: string;
      'prism:volume'?: string;
      'prism:issueIdentifier'?: string;
      'prism:pageRange'?: string;
      'prism:coverDate'?: string;
      'prism:doi'?: string;
      'dc:description'?: string;
      'citedby-count'?: string;
      'pubmed-id'?: string;
    };
    authors?: {
      author: Array<{
        '@auid': string;
        'preferred-name': {
          'ce:given-name': string;
          'ce:surname': string;
          'ce:indexed-name': string;
        };
      }>;
    };
    subject?: {
      '@scheme': string;
      subject: Array<{
        '@code': string;
        '$': string;
      }>;
    };
  };
}

export class ScopusSearcher extends PaperSource {
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;
  private searchApiKey?: string;
  private elsevierApiKey?: string;

  constructor(apiKey?: string, searchApiKey?: string) {
    super('scopus', 'https://api.elsevier.com', apiKey);
    
    // Support two API keys: one for search, one for other operations
    this.elsevierApiKey = apiKey || process.env.ELSEVIER_API_KEY;
    this.searchApiKey = searchApiKey || process.env.SCOPUS_SEARCH_API_KEY || this.elsevierApiKey;
    
    this.client = axios.create({
      baseURL: 'https://api.elsevier.com',
      headers: {
        'Accept': 'application/json',
        ...(this.searchApiKey ? { 'X-ELS-APIKey': this.searchApiKey } : {})
      }
    });

    // Scopus rate limits (same as Elsevier):
    // - Without key: 20 requests per minute  
    // - With key: 10 requests per second (600 per minute)
    const requestsPerSecond = this.searchApiKey ? 10 : 0.33;
    
    this.rateLimiter = new RateLimiter({
      requestsPerSecond,
      burstCapacity: this.searchApiKey ? 20 : 5
    });
  }

  async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
    const customOptions = options as any;
    if (!this.apiKey) {
      throw new Error('Scopus API key is required');
    }

    const maxResults = Math.min(options.maxResults || 10, 25); // Scopus max is 25 per request
    const papers: Paper[] = [];

    try {
      // Build Scopus search query
      let searchQuery = `TITLE-ABS-KEY(${query})`;
      
      if (options.author) {
        searchQuery += ` AND AUTHOR(${options.author})`;
      }
      
      if (options.journal) {
        searchQuery += ` AND SRCTITLE(${options.journal})`;
      }
      
      if (customOptions.affiliation) {
        searchQuery += ` AND AFFIL(${customOptions.affiliation})`;
      }
      
      if (customOptions.subject) {
        searchQuery += ` AND SUBJAREA(${customOptions.subject})`;
      }
      
      if (options.year) {
        if (options.year.includes('-')) {
          const [startYear, endYear] = options.year.split('-');
          searchQuery += ` AND PUBYEAR > ${parseInt(startYear) - 1}`;
          if (endYear) {
            searchQuery += ` AND PUBYEAR < ${parseInt(endYear) + 1}`;
          }
        } else {
          searchQuery += ` AND PUBYEAR = ${options.year}`;
        }
      }

      if (customOptions.openAccess) {
        searchQuery += ' AND OPENACCESS(1)';
      }
      
      if (customOptions.documentType) {
        const docTypeMap: Record<string, string> = {
          'ar': 'Article',
          'cp': 'Conference Paper',
          're': 'Review',
          'bk': 'Book',
          'ch': 'Book Chapter'
        };
        searchQuery += ` AND DOCTYPE(${docTypeMap[customOptions.documentType]})`;
      }

      await this.rateLimiter.waitForPermission();

      const response = await this.client.get<ScopusSearchResponse>('/content/search/scopus', {
        params: {
          query: searchQuery,
          count: maxResults,
          start: 0,
          view: 'COMPLETE',
          field: 'dc:identifier,dc:title,dc:creator,prism:publicationName,prism:coverDate,prism:doi,prism:url,prism:volume,prism:issueIdentifier,prism:pageRange,citedby-count,dc:description,authkeywords,author,affiliation,openaccess,eid'
        }
      });

      const entries = response.data['search-results']?.entry || [];

      for (const entry of entries) {
        const paper = await this.parseEntry(entry);
        if (paper) {
          papers.push(paper);
        }
      }

      return papers;
    } catch (error: any) {
      console.error('Scopus search error:', error.message);
      if (error.response?.status === 401) {
        throw new Error('Invalid or missing Scopus API key');
      }
      if (error.response?.status === 429) {
        throw new Error('Scopus rate limit exceeded. Please try again later.');
      }
      throw error;
    }
  }

  private async parseEntry(entry: ScopusEntry): Promise<Paper | null> {
    try {
      // Extract authors
      let authors = '';
      if (entry.author && entry.author.length > 0) {
        authors = entry.author.map(a => a.authname).join(', ');
      } else if (entry['dc:creator']) {
        authors = entry['dc:creator'];
      }

      // Extract affiliations
      let affiliations: string[] = [];
      if (entry.affiliation) {
        affiliations = entry.affiliation.map(a => a.affilname);
      }

      // Build paper URL
      const paperUrl = entry['prism:url'] || 
                      (entry['prism:doi'] ? `https://doi.org/${entry['prism:doi']}` : undefined);

      // Extract keywords
      const keywords = entry.authkeywords?.split(' | ') || [];

      return PaperFactory.create({
        paperId: entry.eid || entry['dc:identifier'] || '',
        title: entry['dc:title'] || '',
        authors: authors ? authors.split(', ') : [],
        abstract: '', // Abstract not included in search results, need separate API call
        doi: entry['prism:doi'],
        publishedDate: entry['prism:coverDate'] ? new Date(entry['prism:coverDate']) : null,
        url: paperUrl,
        source: 'Scopus',
        journal: entry['prism:publicationName'],
        volume: entry['prism:volume'],
        issue: entry['prism:issueIdentifier'],
        pages: entry['prism:pageRange'],
        citationCount: entry['citedby-count'] ? parseInt(entry['citedby-count']) : undefined,
        keywords: keywords,
        extra: {
          scopusId: entry['dc:identifier'],
          eid: entry.eid,
          affiliations: affiliations,
          documentType: entry.subtypeDescription,
          issn: entry['prism:issn'],
          eIssn: entry['prism:eIssn'],
          openAccess: entry.openaccess === '1' || entry.openaccessFlag === true
        }
      });
    } catch (error) {
      console.error('Error parsing Scopus entry:', error);
      return null;
    }
  }

  async getAbstract(scopusId: string): Promise<Paper | null> {
    if (!this.apiKey) {
      throw new Error('Scopus API key is required');
    }

    try {
      await this.rateLimiter.waitForPermission();

      const response = await this.client.get<ScopusAbstractResponse>(`/content/abstract/scopus_id/${scopusId}`, {
        params: {
          view: 'FULL'
        }
      });

      const coredata = response.data['abstracts-retrieval-response']?.coredata;
      if (!coredata) return null;

      // Extract authors from detailed response
      let authors = '';
      const authorsData = response.data['abstracts-retrieval-response']?.authors;
      if (authorsData && authorsData.author) {
        authors = authorsData.author
          .map(a => `${a['preferred-name']['ce:given-name']} ${a['preferred-name']['ce:surname']}`)
          .join(', ');
      } else if (coredata['dc:creator']) {
        authors = coredata['dc:creator'].map((c: any) => c.$).join(', ');
      }

      // Extract subjects/keywords
      let keywords: string[] = [];
      const subjectData = response.data['abstracts-retrieval-response']?.subject;
      if (subjectData && subjectData.subject) {
        keywords = subjectData.subject.map(s => s.$);
      }

      return PaperFactory.create({
        paperId: scopusId,
        title: coredata['dc:title'] || '',
        authors: authors ? authors.split(', ') : [],
        abstract: coredata['dc:description'] || '',
        doi: coredata['prism:doi'],
        publishedDate: coredata['prism:coverDate'] ? new Date(coredata['prism:coverDate']) : null,
        url: coredata['prism:doi'] ? `https://doi.org/${coredata['prism:doi']}` : undefined,
        source: 'Scopus',
        journal: coredata['prism:publicationName'],
        volume: coredata['prism:volume'],
        issue: coredata['prism:issueIdentifier'],
        pages: coredata['prism:pageRange'],
        citationCount: coredata['citedby-count'] ? parseInt(coredata['citedby-count']) : undefined,
        keywords: keywords,
        extra: {
          scopusId: coredata['dc:identifier'],
          eid: coredata.eid,
          pubmedId: coredata['pubmed-id'],
          issn: coredata['prism:issn']
        }
      });
    } catch (error: any) {
      console.error('Scopus abstract retrieval error:', error.message);
      return null;
    }
  }

  getCapabilities(): PlatformCapabilities {
    return {
      search: true,
      download: false,
      fullText: false,
      citations: true,
      requiresApiKey: true,
      supportedOptions: ['maxResults', 'year', 'author', 'journal']
    };
  }

  async downloadPdf(paperId: string, options: DownloadOptions = {}): Promise<string> {
    throw new Error('PDF download requires institutional access for Scopus');
  }

  async readPaper(paperId: string, options: DownloadOptions = {}): Promise<string> {
    const paper = await this.getAbstract(paperId);
    if (!paper) {
      throw new Error('Paper not found');
    }
    return paper.abstract || 'Abstract not available';
  }

  /**
   * 获取参考文献的Scopus ID列表
   */
  async getReferenceIds(scopusId: string): Promise<string[]> {
    if (!this.elsevierApiKey) return [];

    try {
      await this.rateLimiter.waitForPermission();

      const response = await axios.get(
        `https://api.elsevier.com/content/abstract/scopus_id/${scopusId}`,
        {
          params: { view: 'REF' },
          headers: {
            'Accept': 'application/json',
            'X-ELS-APIKey': this.elsevierApiKey
          }
        }
      );

      const refIds: string[] = [];
      const coreData = response.data?.['abstracts-retrieval-response']?.item?.bibrecord;
      const tail = coreData?.tail;
      const bibliography = tail?.bibliography;
      const references = bibliography?.reference || [];

      for (const ref of references) {
        const refInfo = ref?.['ref-info'];
        const refScopusId = refInfo?.['refd-itemidlist']?.itemid?.['#text'];
        if (refScopusId) {
          refIds.push(refScopusId);
        }
      }

      return refIds;
    } catch (error) {
      console.error(`Error getting reference IDs for Scopus ID ${scopusId}:`, error);
      return [];
    }
  }

  /**
   * 获取引用文献的Scopus ID列表
   */
  async getCitationIds(scopusId: string): Promise<string[]> {
    if (!this.elsevierApiKey) return [];

    try {
      await this.rateLimiter.waitForPermission();

      const response = await axios.get(
        'https://api.elsevier.com/content/abstract/citations',
        {
          params: { scopus_id: scopusId },
          headers: {
            'Accept': 'application/json',
            'X-ELS-APIKey': this.elsevierApiKey
          }
        }
      );

      const citIds: string[] = [];
      const citationData = response.data?.['abstract-citations-response'];
      const citeInfoMatrix = citationData?.citeInfoMatrix;
      const citeInfo = citeInfoMatrix?.citeInfo || [];

      for (const cite of citeInfo) {
        const citeScopusId = cite?.['scopus-id'];
        if (citeScopusId) {
          citIds.push(citeScopusId);
        }
      }

      return citIds;
    } catch (error) {
      console.error(`Error getting citation IDs for Scopus ID ${scopusId}:`, error);
      return [];
    }
  }

  /**
   * 获取论文详情（包含references和citations ID列表）
   */
  async getPaperWithCitations(paperId: string): Promise<Paper | null> {
    try {
      const paper = await this.getAbstract(paperId);
      if (!paper) return null;

      const scopusId = paper.extra?.scopusId?.replace('SCOPUS_ID:', '') || paperId;
      
      const [refIds, citIds] = await Promise.all([
        this.getReferenceIds(scopusId),
        this.getCitationIds(scopusId)
      ]);

      paper.references = refIds;
      paper.extra = {
        ...paper.extra,
        citationIds: citIds
      };

      return paper;
    } catch (error) {
      console.error('Error getting paper with citations:', error);
      return null;
    }
  }
}
