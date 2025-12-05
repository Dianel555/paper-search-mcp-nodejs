# Paper Search MCP (Node.js) with SSE Transport

## English | [中文](README-sc.md) | [한국어](README-ko.md)

A Node.js Model Context Protocol (MCP) server with **Server-Sent Events (SSE)** transport for searching and downloading academic papers from multiple sources, including arXiv, Web of Science, PubMed, Google Scholar, Sci-Hub, ScienceDirect, Springer, Wiley, Scopus, and **13 academic platforms** in total.

![Node.js](https://img.shields.io/badge/node.js->=18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-^5.5.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platforms](https://img.shields.io/badge/platforms-13-brightgreen.svg)
![Transport](https://img.shields.io/badge/transport-SSE-orange.svg)

## ✨ Key Features

- **📡 SSE Transport**: Server-Sent Events for real-time communication over HTTP
- **🌍 13 Academic Platforms**: arXiv, Web of Science, PubMed, Google Scholar, bioRxiv, medRxiv, Semantic Scholar, IACR ePrint, Sci-Hub, ScienceDirect, Springer Nature, Wiley, Scopus
- **🔗 MCP Protocol Integration**: Seamless integration with Claude Desktop and other AI assistants
- **📊 Unified Data Model**: Standardized paper format across all platforms
- **⚡ High-Performance Search**: Concurrent search with intelligent rate limiting
- **🛡️ Type Safety**: Complete TypeScript support
- **🎯 Academic Papers First**: Smart filtering prioritizing academic papers over books
- **🔄 Smart Error Handling**: Platform fallback and auto-retry mechanisms

## 📚 Supported Platforms

| Platform | Search | Download | Full Text | Citations | API Key | Special Features |
|----------|--------|----------|-----------|-----------|---------|------------------|
| **arXiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Physics/CS preprints |
| **Web of Science** | ✅ | ❌ | ❌ | ✅ | ✅ Required | High-quality journal index |
| **PubMed** | ✅ | ❌ | ❌ | ❌ | 🟡 Optional | Biomedical literature |
| **Google Scholar** | ✅ | ❌ | ❌ | ✅ | ❌ | Comprehensive academic search |
| **bioRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Biology preprints |
| **medRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | Medical preprints |
| **Semantic Scholar** | ✅ | ✅ | ❌ | ✅ | 🟡 Optional | AI semantic search |
| **IACR ePrint** | ✅ | ✅ | ✅ | ❌ | ❌ | Cryptography papers |
| **Sci-Hub** | ✅ | ✅ | ❌ | ❌ | ❌ | Universal paper access via DOI |
| **ScienceDirect** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Elsevier's full-text database |
| **Springer Nature** | ✅ | ✅* | ❌ | ❌ | ✅ Required | Dual API: Meta v2 & OpenAccess |
| **Wiley** | ✅ | ✅ | ❌ | ❌ | ✅ Required | Text and Data Mining API |
| **Scopus** | ✅ | ❌ | ❌ | ✅ | ✅ Required | Largest citation database |

✅ Supported | ❌ Not supported | 🟡 Optional | ✅* Open Access only

## 🚀 Quick Start

### System Requirements

- Node.js >= 18.0.0
- npm or yarn

### Installation

```bash
# Clone repository
git clone https://github.com/jhleee/paper-search-mcp-nodejs-sse.git
cd paper-search-mcp-nodejs-sse

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

#### Method 1: SSE Server (Recommended)
```bash
# Build TypeScript code
npm run build

# Start SSE server (listens on http://localhost:3000)
npm start

# Or run in development mode
npm run dev

# Or with custom port and host
PORT=8080 HOST=0.0.0.0 npm start
```

The server will start with the following endpoints:
- **SSE endpoint**: `http://localhost:3000/sse` - For MCP protocol communication
- **Message endpoint**: `http://localhost:3000/messages` - For client-to-server messages (with sessionId)
- **Health check**: `http://localhost:3000/health` - Server health status

#### Method 2: Environment Variables
```bash
# Configure port and host
export PORT=3000          # Default: 3000
export HOST=localhost     # Default: localhost

# Start the server
npm start
```

#### Method 3: Docker (Recommended for Production)
```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t paper-search-mcp-sse .
docker run -d -p 3000:3000 \
  -e WOS_API_KEY=your_key \
  -e PUBMED_API_KEY=your_key \
  paper-search-mcp-sse

# Check logs
docker-compose logs -f

# Stop
docker-compose down
```

### MCP Server Configuration

#### SSE Transport Configuration
For MCP clients that support SSE transport, use the following configuration:

```json
{
  "mcpServers": {
    "paper-search-nodejs-sse": {
      "url": "http://localhost:3000/sse",
      "transport": "sse",
      "env": {
        "WOS_API_KEY": "your_web_of_science_api_key",
        "PUBMED_API_KEY": "your_ncbi_api_key_here",
        "SEMANTIC_SCHOLAR_API_KEY": "your_semantic_scholar_api_key",
        "ELSEVIER_API_KEY": "your_elsevier_api_key",
        "SPRINGER_API_KEY": "your_springer_api_key",
        "WILEY_TDM_TOKEN": "your_wiley_tdm_token"
      }
    }
  }
}
```

#### Testing the SSE Connection
```bash
# Check server health
curl http://localhost:3000/health

# Connect to SSE endpoint (should keep connection open)
curl -N http://localhost:3000/sse
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
- `platform: "all"` - Randomly selects one platform for efficient, focused results
- Specific platform - Searches only that platform
- Available platforms: `arxiv`, `webofscience`/`wos`, `pubmed`, `biorxiv`, `medrxiv`, `semantic`, `iacr`, `googlescholar`/`scholar`, `scihub`, `sciencedirect`, `springer`, `wiley`, `scopus`
### `search_arxiv`
Search arXiv preprints specifically

```typescript
search_arxiv({
  query: "transformer neural networks",
  maxResults: 10,
  category: "cs.AI",
  author: "Attention"
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
  publicationType: ["Journal Article", "Clinical Trial"]
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
  days: 30
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
|   ├── SemanticScholarSearcher.ts # Semantic Scholar searcher
|   ├── IACRSearcher.ts       # IACR ePrint searcher
|   ├── SciHubSearcher.ts     # Sci-Hub searcher with mirror management
|   ├── ScienceDirectSearcher.ts # ScienceDirect (Elsevier) searcher
│   ├── SpringerSearcher.ts   # Springer Nature searcher (Meta v2 & OpenAccess APIs)
|   ├── WileySearcher.ts      # Wiley TDM API searcher
|   └── ScopusSearcher.ts     # Scopus citation database searcher
├── utils/
│   └── RateLimiter.ts        # Token bucket rate limiter
└── server.ts                 # MCP server main file
```

### Adding New Platforms

1. Create new searcher class extending `PaperSource`
2. Implement required abstract methods
3. Register new searcher in `server.ts`
4. Add corresponding MCP tool

### Testing

```bash
# Run tests
npm test

# Run linting
npm run lint

# Code formatting
npm run format
```

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

```typescript
// Use Web of Science query syntax
search_webofscience({
  query: 'TS="machine learning" AND PY=2023',
  maxResults: 20
})

// Author search
search_webofscience({
  query: 'AU="Smith, J*"',
  maxResults: 10
})

// Journal search
search_webofscience({
  query: 'SO="Nature" AND PY=2022-2023',
  maxResults: 15
})
```

**Supported Fields:**
- `TS`: Topic search
- `AU`: Author
- `SO`: Source journal
- `PY`: Publication year
- `DO`: DOI
- `TI`: Title

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

If you encounter issues, please report them at [GitHub Issues](https://github.com/jhleee/paper-search-mcp-nodejs-sse/issues).

## 🙏 Acknowledgments

- Original [paper-search-mcp](https://github.com/openags/paper-search-mcp) for the foundation
- MCP community for the protocol standards

---

⭐ If this project helps you, please give it a star!