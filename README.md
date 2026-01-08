# Paper Search MCP (Node.js)

## English|[中文](README-sc.md)

A Node.js Model Context Protocol (MCP) server for searching and downloading academic papers from multiple sources, including arXiv, Web of Science, PubMed, Google Scholar, Sci-Hub, ScienceDirect, Springer, Wiley, Scopus, Crossref, and **14 academic platforms** in total.

![Node.js](https://img.shields.io/badge/node.js->=18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-^5.5.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platforms](https://img.shields.io/badge/platforms-14-brightgreen.svg)
![Version](https://img.shields.io/badge/version-0.2.5-blue.svg)
[![MCP Badge](https://lobehub.com/badge/mcp/dianel555-paper-search-nodejs)](https://lobehub.com/mcp/dianel555-paper-search-nodejs)
## ✨ Key Features

- **🌍 14 Academic Platforms**: arXiv, Web of Science, PubMed, Google Scholar, bioRxiv, medRxiv, Semantic Scholar, IACR ePrint, Sci-Hub, ScienceDirect, Springer Nature, Wiley, Scopus, Crossref
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
| **Web of Science** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Multi-topic search, date sorting, year ranges |
| **PubMed** | ✅ | ❌ | ❌ | ❌ | 🟡 Optional | Biomedical literature |
| **Google Scholar** | ✅ | ❌ | ❌ | ✅ | ❌ | Comprehensive academic search |
| **bioRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Biology preprints |
| **medRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Medical preprints |
| **Semantic Scholar** | ✅ | ✅ | ❌ | ✅ | 🟡 Optional | AI semantic search |
| **IACR ePrint** | ✅ | ✅ | ✅ | ❌ | ❌ | Cryptography papers |
| **Sci-Hub** | ✅ | ✅ | ❌ | ❌ | ❌ | Universal paper access via DOI |
| **ScienceDirect** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Elsevier's full-text database |
| **Springer Nature** | ✅ | ✅* | ❌ | ❌ | ✅ Required | Dual API: Meta v2 & OpenAccess |
| **Wiley** | ❌ | ✅ | ✅ | ❌ | ✅ Required | TDM API: DOI-based PDF download only |
| **Scopus** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Largest citation database |

✅ Supported | ❌ Not supported | 🟡 Optional | ✅* Open Access only

> **Note**: Wiley TDM API does not support keyword search. Use `search_crossref` to find Wiley articles, then use `download_paper` with `platform="wiley"` to download PDFs by DOI.

## ⚖️ Compliance & Ethical Use (Sci-Hub / Google Scholar)

This project includes integrations that may have **legal, contractual (ToS), and ethical** constraints. You are responsible for ensuring your usage complies with applicable laws, institutional policies, and third‑party terms.

- **Sci-Hub**: May provide access to copyrighted works without authorization in many jurisdictions. Use only when you have the legal right to access the content (e.g., open access, author‑provided copies, or licensed institutional access).
- **Google Scholar**: This integration relies on automated fetching/parsing and may violate Google's Terms of Service or trigger blocking/rate limits. Prefer official APIs or metadata sources (e.g., Crossref, Semantic Scholar) when ToS compliance is required.

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
   WOS_API_KEY=your_actual_api_key_here
   WOS_API_VERSION=v1
   
   # PubMed API key (optional, recommended for better performance)
   PUBMED_API_KEY=your_ncbi_api_key_here
   
   # Semantic Scholar API key (optional, increases rate limits)
   SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_api_key
   
   # Elsevier API key (required for ScienceDirect and Scopus)
   ELSEVIER_API_KEY=your_elsevier_api_key
   
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

#### NPX Configuration (Recommended)
```json
{
  "mcpServers": {
    "paper-search-nodejs": {
      "command": "npx",
      "args": ["-y", "paper-search-mcp-nodejs"],
      "env": {
        "WOS_API_KEY": "your_web_of_science_api_key"
      }
    }
  }
}
```

#### Local Installation Configuration
```json
{
  "mcpServers": {
    "paper_search_nodejs": {
      "command": "node",
      "args": ["/path/to/paper-search-mcp-nodejs/dist/server.js"],
      "env": {
        "WOS_API_KEY": "your_web_of_science_api_key"
      }
    }
  }
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
  maxResults: 15,
  year: "2022",
  journal: "Nature"
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
Search and download papers from Sci-Hub using DOI or paper URL

```typescript
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
├── utils/
│   └── RateLimiter.ts        # Token bucket rate limiter
└── server.ts                 # MCP server main file
```

### Adding New Platforms

1. Create new searcher class extending `PaperSource`
2. Implement required abstract methods
3. Register new searcher in `server.ts`
4. Add corresponding MCP tool

### Security Features (v0.2.5)

The codebase includes comprehensive security utilities:

```
src/utils/
├── SecurityUtils.ts      # Security utilities
│   ├── sanitizeDoi()     # DOI format validation
│   ├── escapeQueryValue() # Query injection prevention
│   ├── validateQueryComplexity() # DoS prevention
│   ├── withTimeout()     # Request timeout protection
│   ├── sanitizeRequest() # Sensitive data removal
│   └── maskSensitiveData() # API key masking
├── ErrorHandler.ts       # Unified error handling
│   ├── ApiError class    # Custom error with metadata
│   ├── HTTP error codes  # 400-504 handling
│   └── Retry logic       # Exponential backoff
└── RateLimiter.ts        # Token bucket rate limiting
```

**Security Best Practices:**
- All DOIs are validated before use in URLs
- Query parameters are escaped to prevent injection
- API keys are masked in all log output
- Request timeouts prevent hanging connections
- Query complexity limits prevent DoS attacks

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
- 15 test suites, 144 test cases
- All 13 platform searchers tested
- Security utilities (DOI validation, query sanitization)
- ErrorHandler (error classification, retry logic)

| Test Suite | Coverage |
|------------|----------|
| Platform Searchers | 13/13 ✅ |
| SecurityUtils | ✅ |
| ErrorHandler | ✅ |

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

🎯 **WoS Starter API v1/v2 Support**: Uses Clarivate's WoS Starter API with full field tag support.

**API Version Configuration:**
```bash
# In .env file (default: v1)
WOS_API_VERSION=v1   # Stable, recommended
# WOS_API_VERSION=v2  # Newer version, same endpoints
```

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

**🔧 v0.2.5 Improvements:**

- ✅ **18 Field Tags**: Full support for all WoS Starter API field tags
- ✅ **API Version Selection**: Support for both v1 and v2 endpoints
- ✅ **Enhanced Filtering**: ISSN, Volume, Page, Issue, DocType, PMID filters
- ✅ **Query Validation**: Security checks for query complexity and injection prevention

**Supported Search Options:**
- `query`: Search terms (supports multi-topic)
- `year`: Single year "2023" or range "2020-2023"
- `author`: Author name filtering
- `journal`: Journal/source filtering
- `sortBy`: Sort field (`date`, `citations`, `relevance`, `title`, `author`, `journal`)
- `sortOrder`: Sort direction (`asc`, `desc`)
- `maxResults`: Maximum results (1-50 per page)

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

- **Academic Paper Priority**: Automatically filters out books, prioritizes peer-reviewed papers
- **Citation Data**: Provides citation counts and academic metrics
- **Anti-Detection**: Smart request patterns to avoid blocking
- **Comprehensive Coverage**: Searches across all academic publishers

### Semantic Scholar Features

- **AI-Powered Search**: Semantic understanding of queries
- **Citation Networks**: Paper relationships and influence metrics
- **Open Access PDFs**: Direct links to freely available papers
- **Research Fields**: Filter by specific academic disciplines

### Sci-Hub Features

- **Universal Access**: Access papers using DOI or direct URLs
- **Mirror Network**: Automatic detection and use of fastest available mirror (11+ mirrors)
- **Health Monitoring**: Continuous monitoring of mirror site availability
- **Automatic Failover**: Seamless switching between mirrors when one fails
- **Smart Retry**: Automatic retry with different mirrors on failure
- **Response Time Optimization**: Mirrors sorted by response time for best performance

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
