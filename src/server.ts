#!/usr/bin/env node
/**
 * Paper Search MCP Server - Node.js Implementation with SSE Transport
 * 支持多个学术平台的论文搜索和下载，包括 Web of Science
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  InitializeRequestSchema,
  PingRequestSchema,
  Tool
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import http from 'http';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { ArxivSearcher } from './platforms/ArxivSearcher.js';
import { WebOfScienceSearcher } from './platforms/WebOfScienceSearcher.js';
import { PubMedSearcher } from './platforms/PubMedSearcher.js';
import { BioRxivSearcher, MedRxivSearcher } from './platforms/BioRxivSearcher.js';
import { SemanticScholarSearcher } from './platforms/SemanticScholarSearcher.js';
import { IACRSearcher } from './platforms/IACRSearcher.js';
import { GoogleScholarSearcher } from './platforms/GoogleScholarSearcher.js';
import { SciHubSearcher } from './platforms/SciHubSearcher.js';
import { ScienceDirectSearcher } from './platforms/ScienceDirectSearcher.js';
import { SpringerSearcher } from './platforms/SpringerSearcher.js';
import { WileySearcher } from './platforms/WileySearcher.js';
import { ScopusSearcher } from './platforms/ScopusSearcher.js';
import { PaperFactory, Paper } from './models/Paper.js';
import { PaperSource } from './platforms/PaperSource.js';
import { logToolCall, logToolResponse, logAccess, logError, logInfo } from './utils/logger.js';

// 加载环境变量
dotenv.config();

// MCP静默模式检测
const isMCPMode = process.argv.includes('--mcp') || process.env.MCP_SERVER === 'true' || process.stdin.isTTY === false;

// 静默日志函数 - 使用rest parameters支持多个参数
const debugLog = (...messages: any[]) => {
  if (!isMCPMode && process.env.NODE_ENV === 'development') {
    console.error(...messages);
  }
};

// 创建MCP服务器实例
const server = new Server({
  name: 'paper-search-mcp-nodejs',
  version: '0.3.0'
}, {
  capabilities: {
    tools: {
      listChanged: true
    }
  }
});

// 延迟初始化搜索器实例，避免阻塞服务器启动
let searchers: {
  arxiv: ArxivSearcher;
  webofscience: WebOfScienceSearcher;
  pubmed: PubMedSearcher;
  wos: WebOfScienceSearcher;
  biorxiv: BioRxivSearcher;
  medrxiv: MedRxivSearcher;
  semantic: SemanticScholarSearcher;
  iacr: IACRSearcher;
  googlescholar: GoogleScholarSearcher;
  scholar: GoogleScholarSearcher;
  scihub: SciHubSearcher;
  sciencedirect: ScienceDirectSearcher;
  springer: SpringerSearcher;
  wiley: WileySearcher;
  scopus: ScopusSearcher;
} | null = null;

const initializeSearchers = () => {
  if (searchers) return searchers;
  
  debugLog('🔧 Initializing searchers...');
  
  const arxivSearcher = new ArxivSearcher();
  const wosSearcher = new WebOfScienceSearcher(
    process.env.WOS_API_KEY,
    process.env.WOS_API_VERSION || 'v1'
  );
  const pubmedSearcher = new PubMedSearcher(process.env.PUBMED_API_KEY);
  const biorxivSearcher = new BioRxivSearcher('biorxiv');
  const medrxivSearcher = new MedRxivSearcher();
  const semanticSearcher = new SemanticScholarSearcher(process.env.SEMANTIC_SCHOLAR_API_KEY);
  const iacrSearcher = new IACRSearcher();
  const googleScholarSearcher = new GoogleScholarSearcher();
  const sciHubSearcher = new SciHubSearcher();
  const scienceDirectSearcher = new ScienceDirectSearcher(process.env.ELSEVIER_API_KEY);
  const springerSearcher = new SpringerSearcher(
    process.env.SPRINGER_API_KEY,
    process.env.SPRINGER_OPENACCESS_API_KEY
  );
  const wileySearcher = new WileySearcher(process.env.WILEY_TDM_TOKEN);
  const scopusSearcher = new ScopusSearcher(process.env.ELSEVIER_API_KEY);

  searchers = {
    arxiv: arxivSearcher,
    webofscience: wosSearcher,
    pubmed: pubmedSearcher,
    wos: wosSearcher, // 别名
    biorxiv: biorxivSearcher,
    medrxiv: medrxivSearcher,
    semantic: semanticSearcher,
    iacr: iacrSearcher,
    googlescholar: googleScholarSearcher,
    scholar: googleScholarSearcher, // 别名
    scihub: sciHubSearcher,
    sciencedirect: scienceDirectSearcher,
    springer: springerSearcher,
    wiley: wileySearcher,
    scopus: scopusSearcher
  };
  
  debugLog('✅ Searchers initialized successfully');
  return searchers;
};

// 工具参数类型定义
interface SearchPapersParams {
  query: string;
  platform?: 'arxiv' | 'webofscience' | 'pubmed' | 'wos' | 'biorxiv' | 'medrxiv' | 'semantic' | 'iacr' | 'googlescholar' | 'scholar' | 'scihub' | 'sciencedirect' | 'springer' | 'wiley' | 'scopus' | 'all';
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
  category?: string;
  sortBy?: 'relevance' | 'date' | 'citations';
  sortOrder?: 'asc' | 'desc';
  days?: number; // bioRxiv/medRxiv
  fetchDetails?: boolean; // IACR
  fieldsOfStudy?: string[]; // Semantic Scholar
}

interface SearchArxivParams {
  query: string;
  maxResults?: number;
  category?: string;
  author?: string;
}

interface SearchWebOfScienceParams {
  query: string;
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
}

interface SearchPubMedParams {
  query: string;
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
  publicationType?: string[];
}

interface SearchBioRxivParams {
  query: string;
  maxResults?: number;
  days?: number;
}

interface SearchMedRxivParams {
  query: string;
  maxResults?: number;
  days?: number;
}

interface SearchSemanticScholarParams {
  query: string;
  maxResults?: number;
  year?: string;
  fieldsOfStudy?: string[];
}

interface SearchIACRParams {
  query: string;
  maxResults?: number;
  fetchDetails?: boolean;
}

interface SearchSciHubParams {
  doiOrUrl: string;
  downloadPdf?: boolean;
  savePath?: string;
}

interface CheckSciHubMirrorsParams {
  forceCheck?: boolean;
}

interface SearchScienceDirectParams {
  query: string;
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
  openAccess?: boolean;
}

interface SearchSpringerParams {
  query: string;
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
  subject?: string;
  openAccess?: boolean;
  type?: 'Journal' | 'Book' | 'Chapter';
}

interface SearchWileyParams {
  query: string;
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
  subject?: string;
  openAccess?: boolean;
}

interface SearchScopusParams {
  query: string;
  maxResults?: number;
  year?: string;
  author?: string;
  journal?: string;
  affiliation?: string;
  subject?: string;
  openAccess?: boolean;
  documentType?: 'ar' | 'cp' | 're' | 'bk' | 'ch';
}

interface DownloadPaperParams {
  paperId: string;
  platform: 'arxiv' | 'biorxiv' | 'medrxiv' | 'semantic' | 'iacr' | 'scihub' | 'springer' | 'wiley';
  savePath?: string;
}

interface GetPaperByDoiParams {
  doi: string;
  platform?: 'arxiv' | 'webofscience' | 'semantic' | 'all';
}

// 定义所有可用工具
const TOOLS: Tool[] = [
  {
    name: 'debug_pubmed_test',
    description: 'Debug PubMed search with detailed logging to bypass MCP cache',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { type: 'number', minimum: 1, maximum: 5, description: 'Maximum number of results' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_papers',
    description: 'Search academic papers from multiple sources including arXiv, Web of Science, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        platform: { 
          type: 'string', 
          enum: ['arxiv', 'webofscience', 'pubmed', 'wos', 'biorxiv', 'medrxiv', 'semantic', 'iacr', 'googlescholar', 'scholar', 'scihub', 'sciencedirect', 'springer', 'wiley', 'scopus', 'all'],
          description: 'Platform to search (arxiv, webofscience/wos, pubmed, biorxiv, medrxiv, semantic, iacr, googlescholar/scholar, scihub, sciencedirect, springer, wiley, scopus, or all)'
        },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023", "2020-")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        category: { type: 'string', description: 'Category filter (e.g., cs.AI for arXiv)' },
        days: { 
          type: 'number', 
          description: 'Number of days to search back (bioRxiv/medRxiv only)'
        },
        fetchDetails: { 
          type: 'boolean', 
          description: 'Fetch detailed information (IACR only)'
        },
        fieldsOfStudy: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Fields of study filter (Semantic Scholar only)'
        },
        sortBy: { 
          type: 'string', 
          enum: ['relevance', 'date', 'citations'],
          description: 'Sort results by relevance, date, or citations'
        },
        sortOrder: { 
          type: 'string', 
          enum: ['asc', 'desc'],
          description: 'Sort order: ascending or descending'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_arxiv',
    description: 'Search academic papers specifically from arXiv preprint server',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 50,
          description: 'Maximum number of results to return'
        },
        category: { type: 'string', description: 'arXiv category filter (e.g., cs.AI, physics.gen-ph)' },
        author: { type: 'string', description: 'Author name filter' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_webofscience',
    description: 'Search academic papers from Web of Science database',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 50,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Publication year filter' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_pubmed',
    description: 'Search biomedical literature from PubMed/MEDLINE database using NCBI E-utilities API',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Publication year filter (e.g., "2023", "2020-2023")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        publicationType: { 
          type: 'array', 
          items: { type: 'string' },
          description: 'Publication type filter (e.g., ["Journal Article", "Review"])'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_biorxiv',
    description: 'Search bioRxiv preprint server for biology papers',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        days: { 
          type: 'number', 
          description: 'Number of days to search back (default: 30)' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_medrxiv',
    description: 'Search medRxiv preprint server for medical papers',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        days: { 
          type: 'number', 
          description: 'Number of days to search back (default: 30)' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_semantic_scholar',
    description: 'Search Semantic Scholar for academic papers with citation data',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023")' },
        fieldsOfStudy: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Fields of study filter (e.g., ["Computer Science", "Biology"])'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_iacr',
    description: 'Search IACR ePrint Archive for cryptography papers',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 50,
          description: 'Maximum number of results to return'
        },
        fetchDetails: { 
          type: 'boolean', 
          description: 'Fetch detailed information for each paper (slower)' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'download_paper',
    description: 'Download PDF file of an academic paper',
    inputSchema: {
      type: 'object',
      properties: {
        paperId: { type: 'string', description: 'Paper ID (e.g., arXiv ID, DOI for Sci-Hub)' },
        platform: { type: 'string', enum: ['arxiv', 'biorxiv', 'medrxiv', 'semantic', 'iacr', 'scihub', 'springer', 'wiley'], description: 'Platform where the paper is from' },
        savePath: { 
          type: 'string',
          description: 'Directory to save the PDF file'
        }
      },
      required: ['paperId', 'platform']
    }
  },
  {
    name: 'search_google_scholar',
    description: 'Search Google Scholar for academic papers using web scraping',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 20,
          description: 'Maximum number of results to return'
        },
        yearLow: { 
          type: 'number', 
          description: 'Earliest publication year' 
        },
        yearHigh: { 
          type: 'number', 
          description: 'Latest publication year' 
        },
        author: { 
          type: 'string', 
          description: 'Author name filter' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_paper_by_doi',
    description: 'Retrieve paper information using DOI from available platforms',
    inputSchema: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'DOI (Digital Object Identifier)' },
        platform: { 
          type: 'string', 
          enum: ['arxiv', 'webofscience', 'all'],
          description: 'Platform to search'
        }
      },
      required: ['doi']
    }
  },
  {
    name: 'search_scihub',
    description: 'Search and download papers from Sci-Hub using DOI or paper URL. Automatically detects and uses the fastest available mirror.',
    inputSchema: {
      type: 'object',
      properties: {
        doiOrUrl: { 
          type: 'string', 
          description: 'DOI (e.g., "10.1038/nature12373") or full paper URL' 
        },
        downloadPdf: { 
          type: 'boolean', 
          description: 'Whether to download the PDF file',
          default: false
        },
        savePath: { 
          type: 'string',
          description: 'Directory to save the PDF file (if downloadPdf is true)'
        }
      },
      required: ['doiOrUrl']
    }
  },
  {
    name: 'check_scihub_mirrors',
    description: 'Check the health status of all Sci-Hub mirror sites',
    inputSchema: {
      type: 'object',
      properties: {
        forceCheck: {
          type: 'boolean',
          description: 'Force a fresh health check even if recent data exists',
          default: false
        }
      }
    }
  },
  {
    name: 'get_platform_status',
    description: 'Check the status and capabilities of available academic platforms',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'search_sciencedirect',
    description: 'Search academic papers from Elsevier ScienceDirect database (requires API key)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        openAccess: { 
          type: 'boolean', 
          description: 'Filter for open access articles only' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_springer',
    description: 'Search academic papers from Springer Nature database. Uses Metadata API by default (all content) or OpenAccess API when openAccess=true (full text available). Same API key works for both.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        subject: { type: 'string', description: 'Subject area filter' },
        openAccess: { 
          type: 'boolean', 
          description: 'Search only open access content' 
        },
        type: { 
          type: 'string', 
          enum: ['Journal', 'Book', 'Chapter'],
          description: 'Publication type filter' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_wiley',
    description: 'Search academic papers from Wiley Online Library (requires TDM token)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 100,
          description: 'Maximum number of results to return'
        },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        subject: { type: 'string', description: 'Subject area filter' },
        openAccess: { 
          type: 'boolean', 
          description: 'Filter for open access articles only' 
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_scopus',
    description: 'Search the Scopus abstract and citation database (requires Elsevier API key)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        maxResults: { 
          type: 'number', 
          minimum: 1, 
          maximum: 25,
          description: 'Maximum number of results (max 25 per request)'
        },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        affiliation: { type: 'string', description: 'Institution/affiliation filter' },
        subject: { type: 'string', description: 'Subject area filter' },
        openAccess: { 
          type: 'boolean', 
          description: 'Filter for open access articles only' 
        },
        documentType: { 
          type: 'string', 
          enum: ['ar', 'cp', 're', 'bk', 'ch'],
          description: 'Document type: ar=article, cp=conference paper, re=review, bk=book, ch=chapter' 
        }
      },
      required: ['query']
    }
  }
];

// 添加initialize请求处理器 - MCP协议的核心初始化
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  debugLog('🤝 Received initialize request:', request.params);
  
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {
        listChanged: true
      }
    },
    serverInfo: {
      name: 'paper-search-mcp-nodejs',
      version: '0.2.2'
    }
  };
});

// 添加ping请求处理器 - 连接保活
server.setRequestHandler(PingRequestSchema, async () => {
  debugLog('🏓 Received ping request');
  return {};
});

// 添加tools/list请求处理器
server.setRequestHandler(ListToolsRequestSchema, async () => {
  debugLog('🔧 Received tools/list request');
  return {
    tools: TOOLS
  };
});

// 添加tools/call请求处理器
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();
  let success = true;
  let errorMessage: string | undefined;

  debugLog(`🔨 Received tools/call request: ${name}`);
  logToolCall(name, args);

  try {
    // 延迟初始化搜索器
    const currentSearchers = initializeSearchers();
    
    switch (name) {
      case 'debug_pubmed_test': {
        const params = args as unknown as { query: string; maxResults?: number };
        const { query, maxResults = 2 } = params;
        
        try {
          // 直接创建新的PubMed搜索器实例进行测试
          const testSearcher = new PubMedSearcher(process.env.PUBMED_API_KEY);
          const testResults = await testSearcher.search(query, { maxResults });
          
          return {
            content: [{
              type: 'text',
              text: `🧪 DEBUG PUBMED TEST 🧪\\nQuery: "${query}"\\nMaxResults: ${maxResults}\\nAPI Key: ${process.env.PUBMED_API_KEY ? 'SET' : 'NOT SET'}\\nResults: ${testResults.length}\\nFirst Title: ${testResults.length > 0 ? testResults[0].title : 'N/A'}\\n\\nFull Results:\\n${JSON.stringify(testResults.map(p => ({ title: p.title, paperId: p.paperId, authors: p.authors.slice(0, 2) })), null, 2)}`
            }]
          };
        } catch (error: any) {
          return {
            content: [{
              type: 'text',
              text: `🚨 DEBUG PUBMED ERROR 🚨\\nQuery: "${query}"\\nError: ${error.message}\\nStack: ${error.stack}`
            }]
          };
        }
      }

      case 'search_papers': {
        const params = args as unknown as SearchPapersParams;
        const { query, platform = 'all', maxResults = 10, year, author, sortBy = 'relevance', sortOrder = 'desc' } = params;
        const results = [];
        const searchOptions = { maxResults, year, author, sortBy, sortOrder };

        if (platform === 'all') {
          // 随机选择一个平台进行搜索
          const availablePlatforms = Object.keys(currentSearchers).filter(name => name !== 'wos' && name !== 'scholar'); // 跳过别名
          const randomPlatform = availablePlatforms[Math.floor(Math.random() * availablePlatforms.length)];
          
          debugLog(`🎲 Randomly selected platform: ${randomPlatform}`);
          
          try {
            const searcher = currentSearchers[randomPlatform as keyof typeof currentSearchers];
            const platformResults = await (searcher as PaperSource).search(query, searchOptions);
            results.push(...platformResults.map((paper: Paper) => PaperFactory.toDict(paper)));
          } catch (error) {
            debugLog(`Error searching random platform ${randomPlatform}:`, error);
            // 如果随机平台失败，尝试 arxiv 作为备选
            try {
              debugLog('🔄 Fallback to arXiv platform');
              const platformResults = await currentSearchers.arxiv.search(query, searchOptions);
              results.push(...platformResults.map((paper: Paper) => PaperFactory.toDict(paper)));
            } catch (fallbackError) {
              debugLog('Error with arxiv fallback:', fallbackError);
            }
          }
        } else {
          // 搜索指定平台
          const searcher = currentSearchers[platform as keyof typeof currentSearchers];
          if (!searcher) {
            throw new Error(`Unsupported platform: ${platform}`);
          }

          const platformResults = await (searcher as PaperSource).search(query, searchOptions);
          results.push(...platformResults.map((paper: Paper) => PaperFactory.toDict(paper)));
        }

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} papers.\\n\\n${JSON.stringify(results, null, 2)}`
          }]
        };
      }

      case 'search_arxiv': {
        const params = args as unknown as SearchArxivParams;
        const { query, maxResults = 10, category, author } = params;
        
        const results = await currentSearchers.arxiv.search(query, { 
          maxResults, 
          category, 
          author 
        });

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} arXiv papers.\\n\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_webofscience': {
        const params = args as unknown as SearchWebOfScienceParams;
        const { query, maxResults = 10, year, author, journal } = params;
        
        if (!process.env.WOS_API_KEY) {
          throw new Error('Web of Science API key not configured. Please set WOS_API_KEY environment variable.');
        }

        const results = await currentSearchers.webofscience.search(query, { 
          maxResults, 
          year, 
          author, 
          journal 
        });

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} Web of Science papers.\\n\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_pubmed': {
        const params = args as unknown as SearchPubMedParams;
        const { query, maxResults = 10, year, author, journal, publicationType } = params;
        
        debugLog(`🔍 MCP PubMed Search: query="${query}", maxResults=${maxResults}`);
        debugLog(`📋 MCP PubMed Search options:`, { maxResults, year, author, journal, publicationType });
        debugLog(`🔧 MCP PubMed Searcher type:`, typeof currentSearchers.pubmed);
        debugLog(`🔧 MCP PubMed Searcher hasApiKey:`, currentSearchers.pubmed.hasApiKey());
        
        debugLog(`⏳ MCP PubMed: About to call searcher.search()...`);
        const results = await currentSearchers.pubmed.search(query, { 
          maxResults, 
          year, 
          author, 
          journal,
          publicationType
        });
        debugLog(`⚡ MCP PubMed: searcher.search() completed`);
        
        debugLog(`📄 MCP PubMed Results: Found ${results.length} papers`);
        if (results.length > 0) {
          debugLog(`📋 First paper title:`, results[0].title);
          debugLog(`📋 First paper paperId:`, results[0].paperId);
        } else {
          debugLog(`❌ MCP PubMed: No results returned from searcher`);
        }

        // 获取速率限制器状态信息
        const rateStatus = currentSearchers.pubmed.getRateLimiterStatus();
        const apiKeyStatus = currentSearchers.pubmed.hasApiKey() ? 'configured' : 'not configured';
        const rateLimit = currentSearchers.pubmed.hasApiKey() ? '10 requests/second' : '3 requests/second';

        // 创建详细的调试信息
        const debugInfo = {
          searchParams: { query, maxResults, year, author, journal, publicationType },
          searcherType: typeof currentSearchers.pubmed,
          hasApiKey: currentSearchers.pubmed.hasApiKey(),
          apiKeyStatus,
          rateLimit,
          rateLimiterStatus: rateStatus,
          resultCount: results.length,
          resultTypes: results.map(r => typeof r),
          firstResultTitle: results.length > 0 ? results[0].title : 'N/A'
        };

        return {
          content: [{
            type: 'text',
            text: `MCP DEBUG: query="${query}", searcher.hasApiKey()=${currentSearchers.pubmed.hasApiKey()}, typeof results=${typeof results}, results.length=${results.length}\\n\\nFound ${results.length} PubMed papers.\\n\\nAPI Status: ${apiKeyStatus} (${rateLimit})\\nRate Limiter: ${rateStatus.availableTokens}/${rateStatus.maxTokens} tokens available\\n\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_biorxiv': {
        const params = args as unknown as SearchBioRxivParams;
        const { query, maxResults = 10, days } = params;
        
        const results = await currentSearchers.biorxiv.search(query, { 
          maxResults, 
          days 
        });

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} bioRxiv papers.\\\\n\\\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_medrxiv': {
        const params = args as unknown as SearchMedRxivParams;
        const { query, maxResults = 10, days } = params;
        
        const results = await currentSearchers.medrxiv.search(query, { 
          maxResults, 
          days 
        });

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} medRxiv papers.\\\\n\\\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_semantic_scholar': {
        const params = args as unknown as SearchSemanticScholarParams;
        const { query, maxResults = 10, year, fieldsOfStudy } = params;
        
        const results = await currentSearchers.semantic.search(query, { 
          maxResults, 
          year, 
          fieldsOfStudy 
        });

        // 获取速率限制器状态信息
        const rateStatus = (currentSearchers.semantic as any).getRateLimiterStatus();
        const apiKeyStatus = currentSearchers.semantic.hasApiKey() ? 'configured' : 'not configured (using free tier)';
        const rateLimit = currentSearchers.semantic.hasApiKey() ? '200 requests/minute' : '20 requests/minute';

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} Semantic Scholar papers.\\\\n\\\\nAPI Status: ${apiKeyStatus} (${rateLimit})\\\\nRate Limiter: ${rateStatus.availableTokens}/${rateStatus.maxTokens} tokens available\\\\n\\\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_iacr': {
        const params = args as unknown as SearchIACRParams;
        const { query, maxResults = 10, fetchDetails } = params;
        
        const results = await currentSearchers.iacr.search(query, { 
          maxResults, 
          fetchDetails 
        });

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} IACR ePrint papers.\\\\n\\\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'download_paper': {
        const params = args as unknown as DownloadPaperParams;
        const { paperId, platform, savePath = './downloads' } = params;
        
        const searcher = currentSearchers[platform as keyof typeof currentSearchers];
        if (!searcher) {
          throw new Error(`Unsupported platform for download: ${platform}`);
        }

        if (!searcher.getCapabilities().download) {
          throw new Error(`Platform ${platform} does not support PDF download`);
        }

        const filePath = await searcher.downloadPdf(paperId, { savePath });

        return {
          content: [{
            type: 'text',
            text: `PDF downloaded successfully to: ${filePath}`
          }]
        };
      }

      case 'search_google_scholar': {
        const params = args as unknown as { 
          query: string; 
          maxResults?: number; 
          yearLow?: number; 
          yearHigh?: number; 
          author?: string; 
        };
        const { query, maxResults = 10, yearLow, yearHigh, author } = params;
        
        debugLog(`🔍 Google Scholar Search: query="${query}", maxResults=${maxResults}`);
        
        const results = await currentSearchers.googlescholar.search(query, { 
          maxResults, 
          yearLow, 
          yearHigh, 
          author 
        });
        
        debugLog(`📄 Google Scholar Results: Found ${results.length} papers`);
        
        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} Google Scholar papers.\\n\\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'get_paper_by_doi': {
        const params = args as unknown as GetPaperByDoiParams;
        const { doi, platform = 'all' } = params;
        const results = [];

        if (platform === 'all') {
          // 尝试所有平台
          for (const [platformName, searcher] of Object.entries(currentSearchers)) {
            if (platformName === 'wos') continue; // 跳过别名
            
            try {
              const paper = await (searcher as PaperSource).getPaperByDoi(doi);
              if (paper) {
                results.push(PaperFactory.toDict(paper));
              }
            } catch (error) {
              debugLog(`Error getting paper by DOI from ${platformName}:`, error);
            }
          }
        } else {
          // 指定平台
          const searcher = currentSearchers[platform as keyof typeof currentSearchers];
          if (!searcher) {
            throw new Error(`Unsupported platform: ${platform}`);
          }

          const paper = await searcher.getPaperByDoi(doi);
          if (paper) {
            results.push(PaperFactory.toDict(paper));
          }
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No paper found with DOI: ${doi}`
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} paper(s) with DOI ${doi}:\\n\\n${JSON.stringify(results, null, 2)}`
          }]
        };
      }

      case 'search_scihub': {
        const params = args as unknown as { doiOrUrl: string; downloadPdf?: boolean; savePath?: string };
        const { doiOrUrl, downloadPdf = false, savePath = './downloads' } = params;
        
        debugLog(`🔍 Sci-Hub Search: doiOrUrl="${doiOrUrl}", downloadPdf=${downloadPdf}`);
        
        // Search for the paper
        const results = await currentSearchers.scihub.search(doiOrUrl);
        
        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No paper found on Sci-Hub for: ${doiOrUrl}`
            }]
          };
        }
        
        const paper = results[0];
        let responseText = `Found paper on Sci-Hub:\n\n${JSON.stringify(PaperFactory.toDict(paper), null, 2)}`;
        
        // Download PDF if requested
        if (downloadPdf && paper.pdfUrl) {
          try {
            const filePath = await currentSearchers.scihub.downloadPdf(doiOrUrl, { savePath });
            responseText += `\n\nPDF downloaded successfully to: ${filePath}`;
          } catch (downloadError: any) {
            responseText += `\n\nFailed to download PDF: ${downloadError.message}`;
          }
        }
        
        return {
          content: [{
            type: 'text',
            text: responseText
          }]
        };
      }

      case 'check_scihub_mirrors': {
        const params = args as unknown as { forceCheck?: boolean };
        const { forceCheck = false } = params;
        
        if (forceCheck) {
          debugLog('🔄 Forcing Sci-Hub mirror health check...');
          await currentSearchers.scihub.forceHealthCheck();
        }
        
        const mirrorStatus = currentSearchers.scihub.getMirrorStatus();
        
        return {
          content: [{
            type: 'text',
            text: `Sci-Hub Mirror Status:\n\n${JSON.stringify(mirrorStatus, null, 2)}`
          }]
        };
      }

      case 'search_sciencedirect': {
        const params = args as unknown as SearchScienceDirectParams;
        const { query, maxResults = 10, year, author, journal, openAccess } = params;
        
        if (!process.env.ELSEVIER_API_KEY) {
          throw new Error('Elsevier API key not configured. Please set ELSEVIER_API_KEY environment variable.');
        }

        const results = await currentSearchers.sciencedirect.search(query, { 
          maxResults, 
          year, 
          author, 
          journal,
          openAccess 
        } as any);

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} ScienceDirect papers.\n\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_springer': {
        const params = args as unknown as SearchSpringerParams;
        const { query, maxResults = 10, year, author, journal, subject, openAccess, type } = params;
        
        if (!process.env.SPRINGER_API_KEY) {
          throw new Error('Springer API key not configured. Please set SPRINGER_API_KEY environment variable.');
        }

        const results = await currentSearchers.springer.search(query, { 
          maxResults, 
          year, 
          author, 
          journal,
          subject,
          openAccess,
          type
        } as any);

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} Springer papers.\n\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_wiley': {
        const params = args as unknown as SearchWileyParams;
        const { query, maxResults = 10, year, author, journal, subject, openAccess } = params;
        
        if (!process.env.WILEY_TDM_TOKEN) {
          throw new Error('Wiley TDM token not configured. Please set WILEY_TDM_TOKEN environment variable.');
        }

        const results = await currentSearchers.wiley.search(query, { 
          maxResults, 
          year, 
          author, 
          journal,
          subject,
          openAccess
        } as any);

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} Wiley papers.\n\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'search_scopus': {
        const params = args as unknown as SearchScopusParams;
        const { query, maxResults = 10, year, author, journal, affiliation, subject, openAccess, documentType } = params;
        
        if (!process.env.ELSEVIER_API_KEY) {
          throw new Error('Elsevier API key not configured. Please set ELSEVIER_API_KEY environment variable.');
        }

        const results = await currentSearchers.scopus.search(query, { 
          maxResults, 
          year, 
          author, 
          journal,
          affiliation,
          subject,
          openAccess,
          documentType
        } as any);

        return {
          content: [{
            type: 'text',
            text: `Found ${results.length} Scopus papers.\n\n${JSON.stringify(
              results.map((paper: Paper) => PaperFactory.toDict(paper)), 
              null, 
              2
            )}`
          }]
        };
      }

      case 'get_platform_status': {
        const statusInfo = [];

        for (const [platformName, searcher] of Object.entries(currentSearchers)) {
          if (platformName === 'wos' || platformName === 'scholar') continue; // 跳过别名

          const capabilities = (searcher as PaperSource).getCapabilities();
          const hasApiKey = (searcher as PaperSource).hasApiKey();
          
          let apiKeyStatus = 'not_required';
          if (capabilities.requiresApiKey) {
            if (hasApiKey) {
              // 验证API密钥
              const isValid = await (searcher as PaperSource).validateApiKey();
              apiKeyStatus = isValid ? 'valid' : 'invalid';
            } else {
              apiKeyStatus = 'missing';
            }
          }
          
          // Add special status for Sci-Hub
          let additionalInfo = {};
          if (platformName === 'scihub') {
            additionalInfo = {
              mirrorCount: currentSearchers.scihub.getMirrorStatus().length,
              workingMirrors: currentSearchers.scihub.getMirrorStatus().filter(m => m.status === 'Working').length
            };
          }

          statusInfo.push({
            platform: platformName,
            baseUrl: (searcher as PaperSource).getBaseUrl(),
            capabilities: capabilities,
            apiKeyStatus: apiKeyStatus,
            ...additionalInfo
          });
        }

        return {
          content: [{
            type: 'text',
            text: `Platform Status:\n\n${JSON.stringify(statusInfo, null, 2)}`
          }]
        };
      }

      default:
        debugLog(`Unknown tool requested: ${name}`);
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    success = false;
    errorMessage = error.message;
    debugLog(`Error in tool ${name}:`, error);
    logError(error, { tool: name, arguments: args });
    return {
      content: [{
        type: 'text',
        text: `Error executing tool '${name}': ${error.message || 'Unknown error occurred'}`
      }],
      isError: true
    };
  } finally {
    const duration = Date.now() - startTime;
    logToolResponse(name, success, duration, errorMessage);
  }
});

/**
 * 启动服务器
 */
async function main() {
  try {
    const PORT = parseInt(process.env.PORT || '3000', 10);
    const HOST = process.env.HOST || 'localhost';

    debugLog('🚀 Starting Paper Search MCP Server (Node.js) with Streamable HTTP...');
    debugLog(`📍 Working directory: ${process.cwd()}`);
    debugLog(`📦 Node.js version: ${process.version}`);
    debugLog(`🔧 Process arguments:`, process.argv);

    // Create a single transport instance for the server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });

    // Connect the server to the transport
    await server.connect(transport);
    debugLog('✅ MCP Server connected to transport');

    // Create HTTP server
    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const sessionId = req.headers['x-session-id'] as string | undefined;

      // Log access
      logAccess(req.method || 'UNKNOWN', url.pathname, sessionId);

      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Health check endpoint
      if (url.pathname === '/health' && req.method === 'GET') {
        logAccess(req.method, url.pathname, sessionId, 200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'healthy',
          name: 'paper-search-mcp-nodejs',
          version: '0.3.0',
          transport: 'StreamableHTTP',
          sessionId: transport.sessionId
        }));
        return;
      }

      // MCP endpoint - handle all MCP requests (GET/POST/DELETE)
      if (url.pathname === '/mcp' || url.pathname === '/sse') {
        debugLog(`📡 ${req.method} request to ${url.pathname}`);
        debugLog(`📋 Headers:`, JSON.stringify(req.headers, null, 2));
        debugLog(`📋 Query:`, url.search);

        // Log detailed request information for debugging
        logInfo('MCP request received', {
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          headers: req.headers,
          sessionId
        });

        try {
          // Let the transport handle the request
          await transport.handleRequest(req, res);
          logAccess(req.method || 'UNKNOWN', url.pathname, sessionId, res.statusCode);
        } catch (error: any) {
          debugLog('❌ Error handling MCP request:', error);
          logError(error as Error, { method: req.method, path: url.pathname, sessionId });
          logAccess(req.method || 'UNKNOWN', url.pathname, sessionId, 500);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
        return;
      }

      // Default response
      logAccess(req.method || 'UNKNOWN', url.pathname, sessionId, 404);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    httpServer.listen(PORT, HOST, () => {
      const message = `Paper Search MCP Server is running on http://${HOST}:${PORT}`;
      console.log(`✅ Paper Search MCP Server is running!`);
      console.log(`🌐 HTTP Server listening on http://${HOST}:${PORT}`);
      console.log(`📡 MCP endpoint: http://${HOST}:${PORT}/mcp`);
      console.log(`📡 SSE endpoint: http://${HOST}:${PORT}/sse (legacy)`);
      console.log(`❤️  Health check: http://${HOST}:${PORT}/health`);
      console.log(`📝 Logs directory: ./logs`);
      debugLog('🔌 Ready to receive MCP protocol messages via Streamable HTTP');
      logInfo('Server started', { host: HOST, port: PORT });
    });

  } catch (error) {
    debugLog('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// 处理未捕获的错误 - MCP模式下更温和
process.on('uncaughtException', (error) => {
  if (!isMCPMode) {
    debugLog('Uncaught Exception:', error);
    process.exit(1);
  }
  // MCP模式下不立即退出，避免干扰协议通信
});

process.on('unhandledRejection', (reason, promise) => {
  if (!isMCPMode) {
    debugLog('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  }
});

// 启动服务器 - 直接调用main()确保服务器总是启动
main().catch((error) => {
  debugLog('Failed to start MCP server:', error);
  process.exit(1);
});