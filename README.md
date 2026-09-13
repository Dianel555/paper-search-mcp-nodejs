# Paper Search MCP (Node.js)

## English|[中文](README-sc.md)

A Node.js Model Context Protocol (MCP) server for searching and downloading academic papers from multiple sources, including arXiv, Web of Science, PubMed, Google Scholar, Sci-Hub, ScienceDirect, Springer, Wiley, Scopus, Crossref, and **14 academic platforms** in total.

![Node.js](https://img.shields.io/badge/node.js->=18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-^5.5.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platforms](https://img.shields.io/badge/platforms-14-brightgreen.svg)
![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)

## ✨ Key Features

- **🌍 14 Academic Platforms**: arXiv, Web of Science, PubMed, Google Scholar, bioRxiv, medRxiv, Semantic Scholar, IACR ePrint, Sci-Hub, ScienceDirect, Springer Nature, Wiley, Scopus, Crossref
- **🧭 WoS Starter + Expanded**: Starter v2 by default; Expanded SR/FR and citation relationships only when explicitly selected
- **🌐 Public-page access discovery**: optional ScrapingAnt Extended fetching for DOI publisher pages; never used for Clarivate API or institutional login pages
- **🔗 MCP Protocol Integration**: Seamless integration with Claude Desktop and other AI assistants
- **📊 Unified Data Model**: Standardized paper format across all platforms
- **⚡ High-Performance Search**: Concurrent search with intelligent rate limiting
- **🛡️ Security First**: DOI validation, query sanitization, injection prevention, sensitive data masking
- **📝 Type Safety**: Complete TypeScript support with extended interfaces
- **🎯 Academic Papers First**: Smart filtering prioritizing academic papers over books
- **🔄 Smart Error Handling**: Unified ErrorHandler with retry logic and platform fallback

## 📚 Supported Platforms

| Platform | Search | Download | Full Text | Citations | API Key | Special Features |
|----------|--------|----------|-----------|-----------|---------|------------------|
| **Crossref** | ✅ | ❌ | ❌ | ✅ | ❌ | Default search, extensive metadata coverage |
| **arXiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Physics/CS preprints |
| **Web of Science** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Starter v2 default; Expanded SR/FR and relations opt-in |
| **PubMed** | ✅ | ❌ | ❌ | ❌ | 🟡 Optional | Biomedical literature |
| **Google Scholar** | ✅ | ❌ | ❌ | ✅ | ❌ | Direct parser or optional ScrapingAnt General endpoint |
| **bioRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Biology preprints |
| **medRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Medical preprints |
| **Semantic Scholar** | ✅ | ✅ | ❌ | ✅ | 🟡 Optional | AI semantic search |
| **IACR ePrint** | ✅ | ✅ | ✅ | ❌ | ❌ | Cryptography papers |
| **Sci-Hub** | Opt-in | Opt-in | ❌ | ❌ | ❌ | Controlled DOI-only HTML adapter; disabled by default |
| **ScienceDirect** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Elsevier's full-text database |
| **Springer Nature** | ✅ | ✅* | ❌ | ❌ | ✅ Required | Dual API: Meta v2 & OpenAccess |
| **Wiley** | ❌ | ✅ | ✅ | ❌ | ✅ Required | TDM API: DOI-based PDF download only |
| **Scopus** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Largest citation database |

✅ Supported | ❌ Not supported | 🟡 Optional | ✅* Open Access only

> **Note**: Wiley TDM API does not support keyword search. Use `search_crossref` to find Wiley articles, then use `download_paper` with `platform="wiley"` to download PDFs by DOI.

## ⚖️ Compliance & Ethical Use (Sci-Hub / Google Scholar)

This project includes integrations that may have **legal, contractual (ToS), and ethical** constraints. You are responsible for ensuring your usage complies with applicable laws, institutional policies, and third‑party terms.

- **Sci-Hub**: Disabled by default and limited to an unstable DOI/mirror adapter. It does not grant access rights; enable it only for content you are legally authorized to access.
- **Google Scholar/ScrapingAnt**: Automated fetching may trigger blocking or contractual restrictions. ScrapingAnt is used only for public Scholar or publisher pages when configured, never for WoS login, SSO, MFA, or institutional subscription pages.

## 🚀 Quick Start

### System Requirements

- Node.js >= 18.0.0
- npm or yarn

### Installation

```bash
# Clone repository
git clone https://github.com/your-username/paper-search-mcp-nodejs.git
cd paper-search-mcp-nodejs

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

### Configuration

1. **Get Web of Science API Key**
   - Visit [Clarivate Developer Portal](https://developer.clarivate.com/apis)
   - Register and apply for Web of Science API access
   - Add API key to `.env` file

2. **Get PubMed API Key (Optional)**
   - Without API key: Free usage, 3 requests/second limit
   - With API key: 10 requests/second, more stable service
   - Get key: See [NCBI API Keys](https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/)

3. **Configure Environment Variables**
   ```bash
   # Edit .env file
   # Web of Science defaults to Starter v2 and uses WOS_API_KEY.
   WOS_API_KEY=your_web_of_science_api_key
   # Optional Expanded product key.
   WOS_EXPANDED_API_KEY=your_expanded_key
   WOS_STARTER_VERSION=v2
   WOS_STARTER_RPS=1
   WOS_STARTER_DAILY_LIMIT=50
   WOS_EXPANDED_RPS=2
   # Full Record records/day; 0 means unlimited local accounting.
   WOS_EXPANDED_FULL_RECORD_BUDGET=0
   WOS_EXPANDED_BASE_URL=https://api.clarivate.com/api/wos

   # Optional public-page HTML fetching; never a WoS proxy.
   # A key alone does not authorize paid retrieval; browser escalation is opt-in.
   # Residential access is rejected; defaults are 50 credits/operation and 10/request.
   SCRAPINGANT_API_KEY=
   SCRAPINGANT_ENABLED=false
   SCRAPINGANT_ALLOW_BROWSER_ESCALATION=false
   SCRAPINGANT_MAX_CREDITS_PER_OPERATION=50
   SCRAPINGANT_MAX_CREDITS_PER_REQUEST=10
   SCRAPINGANT_MAX_CONCURRENCY=1
   SCRAPINGANT_PROXY_TYPE=datacenter

   # Controlled Sci-Hub adapter; disabled unless explicitly enabled.
   SCIHUB_ENABLED=false
   SCIHUB_FETCH_MODE=fallback
   SCIHUB_MIRRORS=
   SCIHUB_HEALTHCHECK_CONCURRENCY=3
   
   # PubMed API key (optional, recommended for better performance)
   PUBMED_API_KEY=your_ncbi_api_key_here
   
   # Semantic Scholar API key (optional, increases rate limits)
   SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_api_key
   
   # Elsevier API key: ScienceDirect Search v2 and Scopus details
   ELSEVIER_API_KEY=your_elsevier_api_key
   # Optional dedicated key for Scopus Search API; falls back to ELSEVIER_API_KEY
   SCOPUS_SEARCH_API_KEY=
   
   # Springer Nature API keys (required for Springer)
   SPRINGER_API_KEY=your_springer_api_key  # For Metadata API v2
   # Optional: Separate key for OpenAccess API (if different from main key)
   SPRINGER_OPENACCESS_API_KEY=your_openaccess_api_key
   
   # Wiley TDM token (required for Wiley)
   WILEY_TDM_TOKEN=your_wiley_tdm_token
   ```

### Build and Run

#### Method 1: NPX (Recommended for MCP)
```bash
# Direct run with npx (most common MCP deployment)
npx -y paper-search-mcp-nodejs

# Or install globally
npm install -g paper-search-mcp-nodejs
paper-search-mcp
```

#### Method 2: Local Development
```bash
# Build TypeScript code
npm run build

# Start server
npm start

# Or run in development mode
npm run dev
```

### MCP Server Configuration

Add the following configuration to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

#### Complete NPX Configuration (Recommended)
The following is a complete MCP configuration. Every value in `env` must be a string; leave optional keys empty when that platform is not enabled. Replace every placeholder with a value from your own environment, and never commit real credentials.

```json
{
  "mcpServers": {
    "paper-search-nodejs": {
      "command": "npx",
      "args": ["-y", "paper-search-mcp-nodejs"],
      "env": {
        "NODE_ENV": "production",
        "LOG_LEVEL": "info",
        "WOS_API_KEY": "your_web_of_science_api_key",
        "WOS_STARTER_VERSION": "v2",
        "WOS_STARTER_RPS": "1",
        "WOS_STARTER_DAILY_LIMIT": "50",
        "WOS_EXPANDED_API_KEY": "",
        "WOS_EXPANDED_RPS": "2",
        "WOS_EXPANDED_FULL_RECORD_BUDGET": "0",
        "WOS_EXPANDED_BASE_URL": "https://api.clarivate.com/api/wos",
        "PUBMED_API_KEY": "",
        "SEMANTIC_SCHOLAR_API_KEY": "",
        "ELSEVIER_API_KEY": "",
        "SCOPUS_SEARCH_API_KEY": "",
        "SPRINGER_API_KEY": "",
        "SPRINGER_OPENACCESS_API_KEY": "",
        "WILEY_TDM_TOKEN": "",
        "CROSSREF_MAILTO": "you@example.com",
        "SCRAPINGANT_API_KEY": "",
        "SCRAPINGANT_ENABLED": "false",
        "SCRAPINGANT_ALLOW_BROWSER_ESCALATION": "false",
        "SCRAPINGANT_MAX_CREDITS_PER_OPERATION": "50",
        "SCRAPINGANT_MAX_CREDITS_PER_REQUEST": "10",
        "SCRAPINGANT_MAX_CONCURRENCY": "1",
        "SCRAPINGANT_PROXY_TYPE": "datacenter",
        "SCHOLAR_PROXY": "http://user:password@proxy.example:8080",
        "SCIHUB_ENABLED": "false",
        "SCIHUB_FETCH_MODE": "fallback",
        "SCIHUB_MIRRORS": "",
        "SCIHUB_HEALTHCHECK_CONCURRENCY": "3",
        "DEFAULT_DOWNLOAD_PATH": "./downloads",
        "MAX_FILE_SIZE_MB": "100",
        "RATE_LIMIT_REQUESTS_PER_MINUTE": "60",
        "RATE_LIMIT_BURST": "10"
      }
    }
  }
}
```

Replace the `SCHOLAR_PROXY` placeholder with an authorized proxy, or remove that entry when the process already inherits `HTTPS_PROXY`/`HTTP_PROXY`. `WOS_EXPANDED_API_KEY`, `SCRAPINGANT_API_KEY`, and the other optional keys may remain empty.

#### Local Installation Configuration
For a local build, keep the complete `env` object above and change only the server command:

```json
{
  "command": "node",
  "args": ["/path/to/paper-search-mcp-nodejs/dist/server.js"]
}
```

## 🛠️ MCP Tools

### `search_papers`
Search academic papers across multiple platforms

```typescript
// Random platform selection (default behavior)
search_papers({
  query: "machine learning",
  platform: "all",      // Randomly selects one platform for efficiency
  maxResults: 10,
  year: "2023",
  sortBy: "date"
})

// Search specific platform
search_papers({
  query: "quantum computing",
  platform: "webofscience",  // Target specific platform
  maxResults: 5
})
```

**Platform Selection Behavior:**
- `platform: "crossref"` (default) - Free API with extensive scholarly metadata coverage
- `platform: "all"` - Randomly selects one platform for efficient, focused results
- Specific platform - Searches only that platform
- Available platforms: `crossref`, `arxiv`, `webofscience`/`wos`, `pubmed`, `biorxiv`, `medrxiv`, `semantic`, `iacr`, `googlescholar`/`scholar`, `scihub`, `sciencedirect`, `springer`, `scopus`
- Note: `wiley` only supports PDF download by DOI, not keyword search

### `search_crossref`
Search academic papers from Crossref database (default search platform)

```typescript
search_crossref({
  query: "machine learning",
  maxResults: 10,
  year: "2023",
  author: "Smith",
  sortBy: "relevance",  // or "date", "citations"
  sortOrder: "desc"
})
```

### `search_arxiv`
Search arXiv preprints specifically

```typescript
search_arxiv({
  query: "transformer neural networks",
  maxResults: 10,
  category: "cs.AI",
  author: "Vaswani",
  year: "2023",
  sortBy: "date",      // relevance, date, citations
  sortOrder: "desc"    // asc, desc
})
```

### `search_webofscience`
Search Web of Science database specifically

```typescript
search_webofscience({
  query: "CRISPR gene editing",
  maxResults: 5,
  year: "2022",
  journal: "Nature",
  apiProduct: "expanded",   // omit for Starter v2
  recordView: "short",      // expanded only; "full" is opt-in
  discoverAccess: true,      // optional publisher public-page discovery
  discoverAccessMaxItems: 5  // explicit bound; default is 5, range 1-100
})

get_webofscience_related_records({
  uid: "WOS:000000000000001",
  relation: "citing",       // references, citing, or related
  maxResults: 50
})
```

### `search_pubmed`
Search PubMed/MEDLINE biomedical literature database

```typescript
search_pubmed({
  query: "COVID-19 vaccine efficacy",
  maxResults: 20,
  year: "2023",
  author: "Smith",
  journal: "New England Journal of Medicine",
  publicationType: ["Journal Article", "Clinical Trial"],
  sortBy: "date"       // relevance, date
})
```

### `search_google_scholar`
Search Google Scholar academic database

```typescript
search_google_scholar({
  query: "machine learning",
  maxResults: 10,
  yearLow: 2020,
  yearHigh: 2023,
  author: "Bengio"
})
```

### `search_biorxiv` / `search_medrxiv`
Search biology and medical preprints

```typescript
search_biorxiv({
  query: "CRISPR",
  maxResults: 15,
  days: 30,
  category: "genomics"  // neuroscience, genomics, etc.
})

search_medrxiv({
  query: "COVID-19",
  maxResults: 10,
  days: 30,
  category: "infectious_diseases"
})
```

### `search_semantic_scholar`
Search Semantic Scholar AI semantic database

```typescript
search_semantic_scholar({
  query: "deep learning",
  maxResults: 10,
  fieldsOfStudy: ["Computer Science"],
  year: "2023"
})
```

### `search_iacr`
Search IACR ePrint cryptography archive

```typescript
search_iacr({
  query: "zero knowledge proof",
  maxResults: 5,
  fetchDetails: true
})
```

### `search_scihub`
Controlled, opt-in Sci-Hub DOI lookup/download; disabled by default and not an official API

```typescript
// Requires SCIHUB_ENABLED=true. DOI/doi.org inputs only.
search_scihub({
  doiOrUrl: "10.1038/nature12373",
  downloadPdf: true,
  savePath: "./downloads"
})
```

### `search_sciencedirect`
Search Elsevier ScienceDirect database

```typescript
search_sciencedirect({
  query: "artificial intelligence",
  maxResults: 10,
  year: "2023",
  author: "Smith",
  openAccess: true  // Filter for open access articles
})
```

### `search_springer`
Search Springer Nature database (Metadata API v2 or OpenAccess API)

```typescript
search_springer({
  query: "machine learning",
  maxResults: 10,
  year: "2023",
  openAccess: true,  // Use OpenAccess API for downloadable PDFs
  type: "Journal"    // Filter: Journal, Book, or Chapter
})
```

### `search_scopus`
Search Scopus citation database

```typescript
search_scopus({
  query: "renewable energy",
  maxResults: 10,
  year: "2023",
  affiliation: "MIT",
  documentType: "ar"  // ar=article, cp=conference, re=review
})
```

### `check_scihub_mirrors`
Check health status of Sci-Hub mirror sites

```typescript
check_scihub_mirrors({
  forceCheck: true  // Force fresh health check
})
```

### `download_paper`
Download paper PDF files

```typescript
download_paper({
  paperId: "2106.12345",  // or DOI for Sci-Hub
  platform: "arxiv",      // or "scihub" for Sci-Hub downloads
  savePath: "./downloads"
})
```

### `get_paper_by_doi`
Get paper information by DOI

```typescript
get_paper_by_doi({
  doi: "10.1038/s41586-023-12345-6",
  platform: "all"
})
```

### `discover_paper_access`
Discover one public publisher PDF candidate by DOI. This does not claim open-license status or complete download success; PDF verification is opt-in and bounded.

```typescript
discover_paper_access({
  doi: "https://doi.org/10.1038/s41586-023-12345-6",
  verifyPdf: false
})
```

### `get_platform_status`
Check platform status and API keys

```typescript
get_platform_status({})
```

## 📊 Data Model

All platform paper data is converted to a unified format:

```typescript
interface Paper {
  paperId: string;           // Unique identifier
  title: string;            // Paper title
  authors: string[];        // Author list
  abstract: string;         // Abstract
  doi: string;             // DOI
  publishedDate: Date;     // Publication date
  pdfUrl: string;          // PDF link
  url: string;             // Paper page URL
  source: string;          // Source platform
  citationCount?: number;   // Citation count
  journal?: string;         // Journal name
  year?: number;           // Publication year
  categories?: string[];    // Subject categories
  keywords?: string[];      // Keywords
  // ... more fields
}
```

## 🔧 Development

### Project Structure

```
src/
├── models/
│   └── Paper.ts              # Paper data model
├── platforms/
│   ├── PaperSource.ts        # Abstract base class
│   ├── ArxivSearcher.ts      # arXiv searcher
│   ├── WebOfScienceSearcher.ts # Web of Science searcher
│   ├── PubMedSearcher.ts     # PubMed searcher
│   ├── GoogleScholarSearcher.ts # Google Scholar searcher
│   ├── BioRxivSearcher.ts    # bioRxiv/medRxiv searcher
│   ├── SemanticScholarSearcher.ts # Semantic Scholar searcher
│   ├── IACRSearcher.ts       # IACR ePrint searcher
│   ├── SciHubSearcher.ts     # Sci-Hub searcher with mirror management
│   ├── ScienceDirectSearcher.ts # ScienceDirect (Elsevier) searcher
│   ├── SpringerSearcher.ts   # Springer Nature searcher (Meta v2 & OpenAccess APIs)
│   ├── WileySearcher.ts      # Wiley TDM API (DOI-based PDF download only)
│   ├── ScopusSearcher.ts     # Scopus citation database searcher
│   └── CrossrefSearcher.ts   # Crossref API searcher (default platform)
├── mcp/
│   ├── tools.ts              # MCP tool definitions
│   ├── schemas.ts            # Zod schemas for tool arguments
│   ├── handleToolCall.ts     # Tool call dispatcher
│   └── searchers.ts          # Searcher initialization
├── utils/
│   ├── SecurityUtils.ts      # DOI validation, query sanitization, injection prevention
│   ├── PublicNetwork.ts      # Public-target DNS/redirect and SSRF checks
│   ├── ConcurrencyLimiter.ts # Dependency-free bounded concurrency
│   ├── ErrorHandler.ts       # Unified error handling with retry logic
│   ├── RateLimiter.ts        # Token bucket rate limiting
│   ├── QuotaManager.ts       # Daily quota tracking
│   ├── RequestCache.ts       # LRU caching for requests
│   ├── PDFExtractor.ts       # PDF text extraction
│   └── Logger.ts             # Debug logging
├── config/
│   └── constants.ts          # Timeouts, endpoints, limits
├── services/
│   ├── CitationService.ts             # Citation fetching service
│   ├── WebOfScienceParser.ts          # Starter/Expanded response parsers
│   ├── WebOfScienceRequestService.ts  # WoS retry, rate, quota, and status
│   ├── PublicHttpClient.ts            # Redirect-checked public HTTP
│   ├── ScrapingAntFetcher.ts          # General/Extended HTML API wrapper
│   └── PublicAccessDiscovery.ts       # DOI publisher-page PDF discovery
└── server.ts                 # MCP server main file
```

### Adding New Platforms

1. Create new searcher class extending `PaperSource`
2. Implement required abstract methods
3. Register new searcher in `searchers.ts`
4. Add corresponding MCP tool in `tools.ts`

### Security Best Practices

- All DOIs are validated before use in URLs
- Query parameters are escaped to prevent injection
- API keys are masked in all log output
- Request timeouts prevent hanging connections
- Query complexity limits prevent DoS attacks
- Rate limiting and quota management prevent API abuse
- Caching reduces external API calls

### Testing

```bash
# Run tests
npm test

# Run linting
npm run lint

# Code formatting
npm run format
```

**Test Coverage:**
- Includes WoS HTTP contracts, ScrapingAnt status/credits, public-target SSRF checks, access discovery, Sci-Hub fallback/PDF validation, and MCP schemas.
- Platform searchers covered by unit and contract tests
- Security utilities (DOI validation, query sanitization)
- ErrorHandler (error classification, retry logic)
- Rate limiting integration, QuotaManager, RequestCache

| Test Suite | Coverage |
|------------|----------|
| Platform Searchers | ✅ |
| SecurityUtils | ✅ |
| ErrorHandler | ✅ |
| RateLimiter & Integration | ✅ |
| QuotaManager | ✅ |
| RequestCache | ✅ |

## 🌟 Platform-Specific Features

### Springer Nature Dual API System

Springer Nature provides two APIs:

1. **Metadata API v2** (Main API)
   - Endpoint: `https://api.springernature.com/meta/v2/json`
   - Searches all Springer content (subscription + open access)
   - Requires API key from https://dev.springernature.com/

2. **OpenAccess API** (Optional)
   - Endpoint: `https://api.springernature.com/openaccess/json`
   - Only searches open access content
   - May require separate API key or special permissions
   - Better for finding downloadable PDFs

```typescript
// Search all Springer content
search_springer({
  query: "machine learning",
  maxResults: 10
})

// Search only open access papers
search_springer({
  query: "COVID-19",
  openAccess: true,  // Uses OpenAccess API if available
  maxResults: 5
})
```

### Web of Science Advanced Search

🎯 **WoS Starter + Expanded**: Starter API v2 is the default and v1 remains an explicit compatibility choice. Expanded must be selected explicitly.

**API Version and product configuration:**
```bash
# Starter version (default: v2; fixed for the process)
WOS_STARTER_VERSION=v2
# WOS_STARTER_VERSION=v1

# Web of Science defaults to Starter v2.
WOS_API_KEY=...
# Optional Expanded product key.
WOS_EXPANDED_API_KEY=...
```

Starter requests use the documented `/documents` endpoints, page at most 50 records, and preserve unknown citation counts as `null`. Expanded uses its separate `/api/wos` contract, defaults to Short Record, and supports Full Record, references, citing, and related-record operations only when requested. The default is the current Swagger server `https://api.clarivate.com/api/wos`; older `wos-api.clarivate.com` guidance is not used.

```typescript
// Multi-topic search
search_webofscience({
  query: 'oriented structure',
  year: '2023-2025',
  sortBy: 'date',
  sortOrder: 'desc',
  maxResults: 10
})

// Year range filtering
search_webofscience({
  query: 'machine learning',
  year: '2020-2024',  // Supports range format
  sortBy: 'citations',
  sortOrder: 'desc'
})

// Advanced query with filters
search_webofscience({
  query: 'blockchain',
  author: 'zhang',
  journal: 'Nature',
  year: '2023',
  sortBy: 'date',
  sortOrder: 'desc'
})

// Traditional WOS query syntax with field tags
search_webofscience({
  query: 'TS="machine learning" AND PY=2023 AND DT="Article"',
  maxResults: 20
})
```

**🔧 v0.3.0 Improvements:**

- ✅ **Google Scholar**: Isolated same-origin session, 429/captcha detection, bounded transport fallback, adaptive delay, and proxy support (`SCHOLAR_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY`)
- ✅ **arXiv**: Fixed search query prefix (`all:`) to comply with arXiv API spec
- ✅ **Google Scholar**: Updated User-Agents to latest browser versions (Chrome 131, Firefox 133, Edge 131)
- ✅ **Performance**: Implemented `RequestCache` for caching search results and API responses
- ✅ **Reliability**: Added `RateLimiter` and `QuotaManager` to prevent API abuse and 429 errors
- ✅ **New Features**: Added `CitationService` and `PDFExtractor` for future enhancements
- ✅ **Testing**: Restructured test suite into `tests/platforms`, `tests/utils`, and `tests/integration`
- ✅ **WoS contracts**: Separate Starter v1/v2 and Expanded SR/FR/reference request and response handling
- ✅ **Quota safety**: Per-attempt throttling, concurrent reservations, Full Record budget tracking, and quota-header status
- ✅ **Public access discovery**: DOI redirect validation and bounded ScrapingAnt publisher-page discovery (opt-in)
- ✅ **Shared services**: Parsing and WoS request mechanics moved out of platform-specific public files
- ✅ **18 Field Tags**: Full support for all WoS Starter API field tags
- ✅ **Enhanced Filtering**: ISSN, Volume, Page, Issue, DocType, PMID filters
- ✅ **Query Validation**: Security checks for query complexity and injection prevention

**Supported Search Options:**
- `query`: Search terms (supports multi-topic)
- `year`: Single year "2023" or range "2020-2023"
- `author`: Author name filtering
- `journal`: Journal/source filtering
- `sortBy`: Supported sort field (`date`, `citations`, `relevance`)
- `sortOrder`: Sort direction (`asc`, `desc`)
- `maxResults`: Maximum results (1-100; Starter fetches 50 per page)
- `apiProduct`: `starter` (default) or explicit `expanded`
- `recordView`: Expanded `short` (default) or explicit `full`
- `discoverAccess`: Optional publisher public-page discovery
- `discoverAccessMaxItems`: Discovery bound (1-100; explicit value, deployment default, then 5)

**Supported WOS Field Tags (18 total):**
| Tag | Description | Tag | Description |
|-----|-------------|-----|-------------|
| `TS` | Topic (title, abstract, keywords) | `TI` | Title |
| `AU` | Author | `AI` | Author Identifier |
| `SO` | Source/Journal | `IS` | ISSN/ISBN |
| `PY` | Publication Year | `FPY` | Final Publication Year |
| `DO` | DOI | `DOP` | Date of Publication |
| `VL` | Volume | `PG` | Page |
| `CS` | Issue | `DT` | Document Type |
| `PMID` | PubMed ID | `UT` | Accession Number |
| `OG` | Organization | `SUR` | Source URL |

**Example with Field Tags:**
```typescript
// Search by PMID
search_webofscience({ query: 'PMID=12345678' })

// Search by DOI
search_webofscience({ query: 'DO="10.1038/nature12373"' })

// Filter by document type
search_webofscience({ query: 'TS="CRISPR" AND DT="Review"' })

// Search specific volume/issue
search_webofscience({ query: 'SO="Nature" AND VL=580 AND CS=7805' })
```

**🔧 Debugging WOS Issues:**
```bash
# Enable debug logging
export NODE_ENV=development

# In CI, logDebug is enabled automatically when CI=true
```

### Google Scholar Features

- **HTML search adapter**: Uses the Scholar web page, not an official public API
- **Metadata and citations**: Parses titles, authors, abstracts, publication years, and “Cited by” counts
- **Bounded retrieval**: Requests at most 20 results across at most 10 pages with adaptive delays and bounded retry handling
- **Provider-neutral transport**: Direct Scholar traffic keeps its isolated HTTPS/SOCKS proxy and same-origin session; ScrapingAnt is a static fallback only for network/server failures
- **No full-text authorization**: PDF/library links remain publisher or institutional links

> **Google Scholar access**: Google’s official help says automated software should respect `robots.txt` and that bulk access is not provided. Direct requests use `SCHOLAR_PROXY` first, then standard proxy aliases (`HTTPS_PROXY`/`HTTP_PROXY`, including lowercase forms) when configured. With the default transport, the configured ScrapingAnt fetcher is used only as a backup for transport failures or upstream 5xx responses—not to bypass 403/429/CAPTCHA responses. If a separately authorized proxy is already configured, use `SCHOLAR_PROXY`:
> ```bash
> # HTTP/HTTPS proxy
> SCHOLAR_PROXY=http://user:pass@host:port
> # SOCKS proxy
> SCHOLAR_PROXY=socks://host:port
> ```
> Required packages are loaded lazily (`http-proxy-agent`, `https-proxy-agent`, `socks-proxy-agent`) — install the one matching your proxy type.

### Semantic Scholar Features

- **AI-Powered Search**: Semantic understanding of queries
- **Citation Networks**: Paper relationships and influence metrics
- **Open Access PDFs**: Direct links to freely available papers
- **Research Fields**: Filter by specific academic disciplines

### ScrapingAnt Public Fetch Layer

ScrapingAnt is an optional, paid public-page fallback: a key alone does not enable dispatch. Set `SCRAPINGANT_ENABLED=true` to opt in; browser escalation remains disabled unless `SCRAPINGANT_ALLOW_BROWSER_ESCALATION=true` is explicitly authorized. The local defaults are 50 credits per operation and 10 credits per request, and only `datacenter` proxy type is accepted; residential access is rejected. Google Scholar uses `/v2/general`, while WoS DOI access discovery and Sci-Hub fallback use `/v2/extended`. The layer is never a Clarivate/WoS API proxy. DOI discovery rejects known login/SSO/Clarivate targets before dispatch where the local redirect chain is visible. Local DNS checks cannot prove the remote proxy's own redirect destination, so a discovered link is not an OA, authorization, or copyright determination. Actual usage is taken from response credit headers; local budgets are not provider billing balances.

### Sci-Hub Features

- **Opt-in only**: Disabled by default; accepts DOI, `doi:` and `doi.org` forms only
- **Controlled fallback**: Direct mirror lookup first, then bounded ScrapingAnt Extended HTML fallback when enabled
- **Health monitoring**: Five seeded mirrors, max three concurrent direct checks, cached and single-flight
- **Explicit states**: Distinguishes not-found, blocked, markup-changed, unhealthy, and transport failures
- **Safe PDF handling**: Public-target redirect checks, MIME/magic/size validation, temporary files, and atomic replacement
- **Compliance notice**: Does not grant access rights or claim copyright/authorization status

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

1. Fork the project
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 🐛 Issue Reporting

If you encounter issues, please report them at [GitHub Issues](https://github.com/your-username/paper-search-mcp-nodejs/issues).

## 🙏 Acknowledgments

- Original [paper-search-mcp](https://github.com/openags/paper-search-mcp) for the foundation
- MCP community for the protocol standards

---

⭐ If this project helps you, please give it a star!