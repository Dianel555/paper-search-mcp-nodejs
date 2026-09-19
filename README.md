# Paper Search MCP (Node.js)

## English|[中文](README-sc.md)

A Node.js Model Context Protocol (MCP) server for searching and downloading academic papers from multiple sources, including arXiv, Web of Science, PubMed, Google Scholar, Sci-Hub, ScienceDirect, Springer, Wiley, Scopus, Crossref, and **14 academic platforms** in total.

![Node.js](https://img.shields.io/badge/node.js-20.18.1%2B%20%2F%2022%2B-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-^5.5.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platforms](https://img.shields.io/badge/platforms-14-brightgreen.svg)
![Version](https://img.shields.io/badge/version-0.3.3-blue.svg)

## 💖 Sponsors

<p>
  <a href="https://scrapingant.com/">
    <img src="assets/scrapingant.png" alt="ScrapingAnt" width="60" height="60">
  </a>
</p>

<a href="https://scrapingant.com/">
  <img src="assets/scrapingant-banner.png" alt="ScrapingAnt web scraping service" width="640">
</a>

This project is sponsored by [ScrapingAnt](https://scrapingant.com/), a web scraping service for accessing public web data.

**Offer for project users:** Use code `ENTHUSIAST_50` for **50% off the first month of the Enthusiast plan**. The discount applies to the first month only.

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

- Node.js 20.18.1+ (Node.js 21 is excluded by dependency engine constraints)
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
   
   # Optional public-page HTML fallback; never a WoS/API proxy.
   # A key alone does not authorize paid retrieval; browser and residential
   # escalation are separate opt-ins. Invalid/missing paid configuration keeps Direct available.
   # Without residential authorization Publisher/Scholar default to 50 credits/operation and 10/request.
   # With SCRAPINGANT_ALLOW_RESIDENTIAL=true their defaults become 500/125;
   # explicit limits always win and a residential request still requires the residential ceiling.
   SCRAPINGANT_API_KEY=
   SCRAPINGANT_ENABLED=false
   SCRAPINGANT_ALLOW_BROWSER_ESCALATION=false
   SCRAPINGANT_ALLOW_RESIDENTIAL=false
   SCRAPINGANT_MAX_CREDITS_PER_OPERATION=50
   SCRAPINGANT_MAX_CREDITS_PER_REQUEST=10
   SCRAPINGANT_MAX_CONCURRENCY=1
   SCRAPINGANT_PROXY_TYPE=datacenter
   
   # Controlled Sci-Hub adapter; disabled unless explicitly enabled.
   # Mirror addresses are discovered from the Sci-Hub and ooopn directory pages.
   # SCIHUB_MIRRORS is optional and accepts comma-separated supplemental URLs.
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

#### Minimal NPX Configuration (Start Here)
Use this minimal configuration to start immediately with public sources such as Crossref and arXiv. No API key or optional environment variable is required; add platform-specific keys only when you need them.

```json
{
  "mcpServers": {
    "paper-search-nodejs": {
      "command": "npx",
      "args": ["-y", "paper-search-mcp-nodejs"]
    }
  }
}
```

#### Complete NPX Configuration (Advanced/Optional)
Use the complete configuration below only when you need keyed platforms, optional fallbacks, or custom limits. Every value in `env` must be a string; replace placeholders with values from your own environment, and never commit real credentials.

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
        "SCRAPINGANT_ALLOW_RESIDENTIAL": "false",
        "SCRAPINGANT_MAX_CREDITS_PER_OPERATION": "50",
        "SCRAPINGANT_MAX_CREDITS_PER_REQUEST": "10",
        "SCRAPINGANT_MAX_CONCURRENCY": "1",
        "SCRAPINGANT_PROXY_TYPE": "datacenter",
        "SCHOLAR_PROXY": "",
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

`SCHOLAR_PROXY` is an optional explicit override for Scholar direct transport. When it is empty, Scholar uses the standard local proxy aliases (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, including lowercase forms) when configured; when set, it takes precedence and is parsed as a full HTTP(S)/SOCKS proxy URL. It does not select the ScrapingAnt paid fallback. The retrieval benchmark does not enable or replace it. `WOS_EXPANDED_API_KEY`, `SCRAPINGANT_API_KEY`, and the other optional keys may remain empty.

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
// Mirrors are discovered from https://sci-hub.mobi/en/mirrors and
// https://www.ooopn.com/tool/scihub/; SCIHUB_MIRRORS adds optional comma-separated URLs.
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

Scopus search requests `COMPLETE` by default. If Elsevier explicitly denies the `COMPLETE` view because the key lacks that entitlement, the search enters one bounded `STANDARD` fallback strategy; any transient retries remain subject to the existing retry policy. The fallback omits the `field` override so the API can return its standard field set. Other authentication, query, rate-limit, network, and server errors are not converted into a view fallback. `STANDARD` may contain less enriched metadata (for example, full author, abstract, keyword, affiliation, and funding fields); a valid Scopus API key is still required. See [Scopus Search API views](https://dev.elsevier.com/sc_search_views.html) for the fields available in each view.

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
Check local platform capability and API-key status. This is a local diagnostic and does not validate ScrapingAnt account quota or make a paid request.

```typescript
get_platform_status({})
```

### Public access and cost boundaries

`discover_paper_access` accepts only a DOI. It returns a bounded access state such as `oa_candidate`, `pdf_verified`, `not_found`, `restricted`, `failed`, or `skipped`; a candidate is not an open-license or complete-download claim. `verifyPdf` is opt-in and performs only a bounded PDF prefix check. Candidate order, source provenance, HTTP/API status, fallback attempts, and known local cost are separate evidence fields.

Paid retrieval is Direct-first and finite. Empty/parse-failed public pages may consume an explicitly authorized fallback attempt; a known permission, unsafe target, resource limit, cancellation, deadline, unknown price, or closed ledger stops paid work. Missing/invalid post-dispatch billing is recorded as unknown and consumes its local estimate, but does not independently stop a bounded retry/fallback chain; the final reported credits remain unknown until reconciled. When browser escalation is explicitly enabled, Scholar production tries ScrapingAnt `browser:datacenter` before the remaining paid combinations; browser is one bounded dispatch and has no retry. Returned diagnostics never include cookies, authorization, queries, raw HTML, or sensitive URLs. Public cookies are not read from configuration; Scholar session cookies, when obtained, stay on the exact Scholar HTTPS origin and are never sent to ScrapingAnt.

Use `SCRAPINGANT_ENABLED=true` only after obtaining deployment authorization. Scholar's browser-first fallback requires `SCRAPINGANT_ALLOW_BROWSER_ESCALATION=true`; `SCRAPINGANT_ALLOW_BROWSER_ESCALATION` and `SCRAPINGANT_ALLOW_RESIDENTIAL` are independent controls. Restarting with either flag disabled rolls back the corresponding combinations; it does not erase already observed local costs. A run can also be disabled by leaving the key/paid flag off. No setting synchronizes provider quota or clears an in-flight ledger.

### Offline benchmark

The fixed benchmark corpus and strategy schedule are validated without network access. A complete 360-cell live run is a separately authorized external qualification, not the completion gate for each engineering fix:

```bash
# Accounting/report simulation (no production retrieval workflow)
npm run --silent benchmark:offline -- --json
# Reviewed offline production workflow beneath fixed raw fixtures (virtual clock)
npm run --silent benchmark:offline -- --workflow --json
# Optional: write encoded run-id .json and .md artifacts without overwriting existing files.
npm run --silent benchmark:offline -- --workflow --output-dir ./benchmark-artifacts
```

The default command validates the frozen 20 DOI/10 Scholar query corpus with an injected response-only accounting simulator. Add `--workflow` to run the reviewed `createProductionBenchmarkCellExecutor` instead: it invokes the real Publisher/Scholar business entries, providers, parsing, session, fallback, scheduler, billing bridge and PDF-prefix paths beneath independent fixed raw fixtures, using a virtual clock while preserving the production pacing rules. Both modes are explicitly offline-only; neither initializes a live provider or uses credentials for retrieval, and neither can produce `live_passed`. The workflow report must be identified separately from simulator totals. Live evaluation is exposed only through the separately named command below; it requires explicit `--authorize-live`, an exclusive explicit `--run-id`, a complete preflight, and the fixed safety ceiling of 15,000 credits, 1,500 HTTP dispatches, and 7,200,000ms. A failed preflight writes a privacy-safe `blocked` report with zero dispatches; it never shrinks the frozen matrix or bypasses configuration. The live executor uses real production transports and is not the offline fixture executor. The planned schedule is 60 production cells plus 300 independent comparison cells; unexecuted live cells remain `not_run` and keep their denominator. Artifact paths are exclusive so a report cannot silently overwrite an earlier run.

```bash
# Explicitly authorized live campaign; preflight blocks without complete paid/browser/residential configuration.
npm run --silent benchmark:live -- --authorize-live --authorize-scholar-proxy --run-id live-YYYYMMDD-01 --output-dir ./live-benchmark-artifacts --json
```

Do not pass `--authorize-live` unless the campaign, provider billing, target scope, and live-capable harness have been reviewed. Pass `--authorize-scholar-proxy` only when the explicit `SCHOLAR_PROXY` endpoint has separately passed TLS/ownership review; ambient proxy aliases alone remain blocked. The command never resumes an old run, appends budget, or changes `offlineOnly` fixtures.

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
- **Bounded retrieval**: Requests at most 20 results across at most 10 pages with deduplication, dispatch-time pacing, adaptive delays, and bounded retry handling
- **Provider-neutral transport**: Direct Scholar traffic keeps its isolated same-origin HTTPS session; source waits do not occupy the global transport slot, while ScrapingAnt is a bounded fallback for eligible transport/server failures and empty/parse-failed pages
- **Session privacy**: Scholar cookies are created in memory for the exact Scholar origin and are never forwarded to ScrapingAnt or returned in diagnostics
- **No full-text authorization**: PDF/library links remain publisher or institutional links

> **Google Scholar access**: Google’s official help says automated software should respect `robots.txt` and that bulk access is not provided. Direct requests use the standard local proxy aliases (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, including lowercase forms) when configured. An explicit `SCHOLAR_PROXY` overrides those aliases and is parsed as a complete HTTP(S)/SOCKS proxy URL. With the default transport, the configured ScrapingAnt fetcher is used only as a bounded backup for eligible transport failures, upstream 5xx responses, or no usable/parseable results—not to bypass permission, 403/429, or CAPTCHA responses:
> ```bash
> # Optional explicit HTTP/HTTPS proxy override
> SCHOLAR_PROXY=http://user:pass@host:port
> # Optional explicit TLS-to-proxy endpoint
> SCHOLAR_PROXY=https://user:pass@host:port
> # Optional SOCKS proxy
> SCHOLAR_PROXY=socks://host:port
> ```
> Required packages are loaded lazily (`http-proxy-agent`, `https-proxy-agent`, `socks-proxy-agent`) — install the one matching your proxy type. ScrapingAnt Proxy mode is not used as a transparent substitute: `SCRAPINGANT_PROXY_TYPE` is only the provider proxy ceiling, and the legacy `SCHOLAR_PROXY` path remains independent and outside benchmark acceptance.

### Semantic Scholar Features

- **AI-Powered Search**: Semantic understanding of queries
- **Citation Networks**: Paper relationships and influence metrics
- **Open Access PDFs**: Direct links to freely available papers
- **Research Fields**: Filter by specific academic disciplines

### ScrapingAnt Public Fetch Layer

ScrapingAnt is an optional, paid public-page fallback: a key alone does not enable dispatch. Set `SCRAPINGANT_ENABLED=true` to opt in; browser and residential escalation are independent authorizations. The current Scholar `browser:datacenter`-first order is provisional and requires real provider capability validation; otherwise it retains static-first behavior. Without residential authorization, Publisher/Scholar defaults are 50 credits per operation and 10 credits per request; with `SCRAPINGANT_ALLOW_RESIDENTIAL=true`, their defaults become 500/125. Explicit valid limits always win, but residential dispatch still requires `SCRAPINGANT_PROXY_TYPE=residential`; a datacenter ceiling never sends residential traffic. Google Scholar uses the generic `/v2/general` HTML endpoint (not a dedicated Scholar API), while WoS DOI access discovery and Sci-Hub fallback use `/v2/extended`. The layer is never a Clarivate/WoS API proxy. DOI discovery rejects known login/SSO/Clarivate targets before dispatch where the local redirect chain is visible. Local DNS checks cannot prove the remote proxy's own redirect destination, so a discovered link is not an OA, authorization, or copyright determination. Actual usage is taken from response credit headers; local budgets are not provider billing balances. A known permission/security/resource/cancellation/deadline failure does not trigger paid fallback, and completed strategy scopes retain only finite cache metadata rather than raw provider documents. Persistent Scholar blocking remains an external provider limitation.

### Public-paper and Markdown tools

- `download_public_paper` is a separate, strict MCP tool for `publisher`, `googlescholar`, and `scihub`. Publisher/Sci-Hub use a DOI in `paperId`; Scholar uses a short-lived reference published by the same MCP connection's search result.
- `get_paper_markdown` is explicit opt-in only. It makes at most one static/datacenter `/v2/markdown` request and returns bounded, untrusted Markdown; Markdown is never used for Paper fields, PDF candidate extraction, or implicit search/download calls.
- Scholar references are in-memory only, capped at 256 entries per handler, TTL 300 seconds, non-sliding, and invalidated on handler disposal/restart. Missing, expired, or ambiguous references do not guess a URL or make a provider request.
- Set `SCRAPINGANT_ALLOW_AUTHORIZED_CORPUS=true` plus canonical tokens in `SCRAPINGANT_AUTHORIZED_CORPUS_PLATFORMS` only when a deployment is authorized to attempt restricted pages. This does not forward cookies, Authorization headers, institutional credentials, or MCP-supplied URLs.
- Provider HTML/Markdown is not a PDF authority. The new downloader re-checks public targets, MIME, `%PDF-`, size, cancellation, paths, symlinks, and atomic no-clobber publication. Existing `download_paper` keeps its name, eight-platform schema, and behavior; no Proxy mode or AI Extractor is enabled.
- Offline tests and the default configuration do not send live or paid requests. Live canaries require separate approval, budget, samples, and stop conditions.

### Sci-Hub Features

- **Opt-in only**: Disabled by default; accepts DOI, `doi:` and `doi.org` forms only
- **Controlled fallback**: Direct mirror lookup first, then bounded ScrapingAnt Extended HTML fallback when enabled
- **Mirror discovery and health monitoring**: Fetches mirror lists from `https://sci-hub.mobi/en/mirrors` and `https://www.ooopn.com/tool/scihub/`, merges optional `SCIHUB_MIRRORS` supplements, then performs max-three-concurrent direct checks with caching and single-flight
- **Explicit states**: Distinguishes not-found, blocked, markup-changed, unhealthy, and transport failures
- **Safe PDF handling**: Public-target redirect checks, MIME/magic/size validation, temporary files, and atomic replacement
- **Compliance notice**: Does not grant access rights or claim copyright/authorization status

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions welcome! 

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