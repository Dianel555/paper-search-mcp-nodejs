import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOLS: Tool[] = [
  {
    name: 'search_papers',
    description: 'Search academic papers from multiple sources including arXiv, Web of Science, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
        platform: {
          type: 'string',
          enum: [
            'arxiv',
            'webofscience',
            'pubmed',
            'wos',
            'biorxiv',
            'medrxiv',
            'semantic',
            'iacr',
            'googlescholar',
            'scholar',
            'scihub',
            'sciencedirect',
            'springer',
            'scopus',
            'crossref',
            'all'
          ],
          description:
            'Platform to search (default: crossref). Options: arxiv, webofscience/wos, pubmed, biorxiv, medrxiv, semantic, iacr, googlescholar/scholar, scihub, sciencedirect, springer, scopus, crossref, or all. Note: Wiley only supports PDF download by DOI, use download_paper instead.'
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
        author: { type: 'string', description: 'Author name filter' },
        year: { type: 'string', description: 'Year filter (e.g., "2023", "2020-2023")' },
        sortBy: {
          type: 'string',
          enum: ['relevance', 'date', 'citations'],
          description: 'Sort results by field'
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
        year: { type: 'string', description: 'Publication year filter (e.g., "2023", "2020-2023")' },
        author: { type: 'string', description: 'Author name filter' },
        journal: { type: 'string', description: 'Journal name filter' },
        sortBy: {
          type: 'string',
          enum: ['relevance', 'date', 'citations', 'title', 'author', 'journal'],
          description: 'Sort results by field'
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
        },
        sortBy: {
          type: 'string',
          enum: ['relevance', 'date'],
          description: 'Sort results by relevance or date'
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
        },
        category: { type: 'string', description: 'Category filter (e.g., neuroscience, genomics)' }
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
        },
        category: { type: 'string', description: 'Category filter (e.g., infectious_diseases, epidemiology)' }
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
        platform: {
          type: 'string',
          enum: ['arxiv', 'biorxiv', 'medrxiv', 'semantic', 'iacr', 'scihub', 'springer', 'wiley'],
          description: 'Platform where the paper is from'
        },
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
    description:
      'Search and download papers from Sci-Hub using DOI or paper URL. Automatically detects and uses the fastest available mirror.',
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
      properties: {
        validate: {
          type: 'boolean',
          description:
            'Whether to validate configured API keys by making a real request (may trigger rate limits). Default: false.'
        }
      }
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
    description:
      'Search academic papers from Springer Nature database. Uses Metadata API by default (all content) or OpenAccess API when openAccess=true (full text available). Same API key works for both.',
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
    description:
      'DEPRECATED: Wiley TDM API does not support keyword search. Use search_crossref to find Wiley articles, then use download_paper with platform="wiley" to download PDFs by DOI.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'This tool is deprecated. Use search_crossref instead.' }
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
  },
  {
    name: 'search_crossref',
    description:
      'Search academic papers from Crossref database. Free API with extensive scholarly metadata coverage across publishers.',
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
  }
];
