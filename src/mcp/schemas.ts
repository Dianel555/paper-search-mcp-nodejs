import { z } from 'zod';

const SortBySchema = z.enum(['relevance', 'date', 'citations']);
const SortOrderSchema = z.enum(['asc', 'desc']);

export const SearchPapersSchema = z
  .object({
    query: z.string().min(1),
    platform: z
      .enum([
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
      ])
      .optional()
      .default('crossref'),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    journal: z.string().optional(),
    category: z.string().optional(),
    days: z.number().int().min(1).max(3650).optional(),
    fetchDetails: z.boolean().optional(),
    fieldsOfStudy: z.array(z.string()).optional(),
    sortBy: SortBySchema.optional().default('relevance'),
    sortOrder: SortOrderSchema.optional().default('desc')
  })
  .strip();

export const SearchArxivSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
    category: z.string().optional(),
    author: z.string().optional(),
    year: z.string().optional(),
    sortBy: SortBySchema.optional(),
    sortOrder: SortOrderSchema.optional()
  })
  .strip();

export const SearchWebOfScienceSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    journal: z.string().optional(),
    sortBy: z
      .enum(['relevance', 'date', 'citations', 'title', 'author', 'journal'])
      .optional(),
    sortOrder: SortOrderSchema.optional()
  })
  .strip();

export const SearchPubMedSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    journal: z.string().optional(),
    publicationType: z.array(z.string()).optional(),
    sortBy: z.enum(['relevance', 'date']).optional()
  })
  .strip();

export const SearchBioRxivSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    days: z.number().int().min(1).max(3650).optional(),
    category: z.string().optional()
  })
  .strip();

export const SearchMedRxivSchema = SearchBioRxivSchema;

export const SearchSemanticScholarSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    year: z.string().optional(),
    fieldsOfStudy: z.array(z.string()).optional()
  })
  .strip();

export const SearchIACRSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(50).optional().default(10),
    fetchDetails: z.boolean().optional()
  })
  .strip();

export const DownloadPaperSchema = z
  .object({
    paperId: z.string().min(1),
    platform: z.enum(['arxiv', 'biorxiv', 'medrxiv', 'semantic', 'iacr', 'scihub', 'springer', 'wiley']),
    savePath: z.string().optional()
  })
  .strip();

export const SearchGoogleScholarSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(20).optional().default(10),
    yearLow: z.number().int().optional(),
    yearHigh: z.number().int().optional(),
    author: z.string().optional()
  })
  .strip();

export const GetPaperByDoiSchema = z
  .object({
    doi: z.string().min(1),
    platform: z.enum(['arxiv', 'webofscience', 'all']).optional().default('all')
  })
  .strip();

export const SearchSciHubSchema = z
  .object({
    doiOrUrl: z.string().min(1),
    downloadPdf: z.boolean().optional().default(false),
    savePath: z.string().optional()
  })
  .strip();

export const CheckSciHubMirrorsSchema = z
  .object({
    forceCheck: z.boolean().optional().default(false)
  })
  .strip();

export const SearchScienceDirectSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    journal: z.string().optional(),
    openAccess: z.boolean().optional()
  })
  .strip();

export const SearchSpringerSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    journal: z.string().optional(),
    subject: z.string().optional(),
    openAccess: z.boolean().optional(),
    type: z.enum(['Journal', 'Book', 'Chapter']).optional()
  })
  .strip();

export const SearchWileySchema = z
  .object({
    query: z.string().min(1)
  })
  .strip();

export const SearchScopusSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(25).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    journal: z.string().optional(),
    affiliation: z.string().optional(),
    subject: z.string().optional(),
    openAccess: z.boolean().optional(),
    documentType: z.enum(['ar', 'cp', 're', 'bk', 'ch']).optional()
  })
  .strip();

export const SearchCrossrefSchema = z
  .object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).optional().default(10),
    year: z.string().optional(),
    author: z.string().optional(),
    sortBy: SortBySchema.optional().default('relevance'),
    sortOrder: SortOrderSchema.optional().default('desc')
  })
  .strip();

export const GetPlatformStatusSchema = z
  .object({
    validate: z.boolean().optional().default(false)
  })
  .strip();

export type ToolName =
  | 'search_papers'
  | 'search_arxiv'
  | 'search_webofscience'
  | 'search_pubmed'
  | 'search_biorxiv'
  | 'search_medrxiv'
  | 'search_semantic_scholar'
  | 'search_iacr'
  | 'download_paper'
  | 'search_google_scholar'
  | 'get_paper_by_doi'
  | 'search_scihub'
  | 'check_scihub_mirrors'
  | 'get_platform_status'
  | 'search_sciencedirect'
  | 'search_springer'
  | 'search_wiley'
  | 'search_scopus'
  | 'search_crossref';

export function parseToolArgs(toolName: ToolName, args: unknown): any {
  switch (toolName) {
    case 'search_papers':
      return SearchPapersSchema.parse(args);
    case 'search_arxiv':
      return SearchArxivSchema.parse(args);
    case 'search_webofscience':
      return SearchWebOfScienceSchema.parse(args);
    case 'search_pubmed':
      return SearchPubMedSchema.parse(args);
    case 'search_biorxiv':
      return SearchBioRxivSchema.parse(args);
    case 'search_medrxiv':
      return SearchMedRxivSchema.parse(args);
    case 'search_semantic_scholar':
      return SearchSemanticScholarSchema.parse(args);
    case 'search_iacr':
      return SearchIACRSchema.parse(args);
    case 'download_paper':
      return DownloadPaperSchema.parse(args);
    case 'search_google_scholar':
      return SearchGoogleScholarSchema.parse(args);
    case 'get_paper_by_doi':
      return GetPaperByDoiSchema.parse(args);
    case 'search_scihub':
      return SearchSciHubSchema.parse(args);
    case 'check_scihub_mirrors':
      return CheckSciHubMirrorsSchema.parse(args);
    case 'get_platform_status':
      return GetPlatformStatusSchema.parse(args ?? {});
    case 'search_sciencedirect':
      return SearchScienceDirectSchema.parse(args);
    case 'search_springer':
      return SearchSpringerSchema.parse(args);
    case 'search_wiley':
      return SearchWileySchema.parse(args);
    case 'search_scopus':
      return SearchScopusSchema.parse(args);
    case 'search_crossref':
      return SearchCrossrefSchema.parse(args);
    default:
      return args;
  }
}
