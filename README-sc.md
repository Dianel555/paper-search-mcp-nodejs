# Paper Search MCP (Node.js)

##  中文|[English](README.md)
一个基于Node.js的模型上下文协议(MCP)服务器，用于搜索和下载多个学术数据库的论文，包括arXiv、Web of Science、PubMed、Google Scholar、Sci-Hub、ScienceDirect、Springer、Wiley、Scopus、Crossref等**14个学术平台**。

![Node.js](https://img.shields.io/badge/node.js-20.18.1%2B%20%2F%2022%2B-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-^5.5.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platforms](https://img.shields.io/badge/platforms-14-brightgreen.svg)
![Version](https://img.shields.io/badge/version-0.3.3-blue.svg)

## 💖 赞助商

<p>
  <a href="https://scrapingant.com/">
    <img src="assets/scrapingant.png" alt="ScrapingAnt" width="60" height="60">
  </a>
</p>

<a href="https://scrapingant.com/">
  <img src="assets/scrapingant-banner.png" alt="ScrapingAnt web scraping service" width="640">
</a>

本项目由 [ScrapingAnt](https://scrapingant.com/) 赞助，为访问公开网页数据提供网页抓取服务。

**项目用户优惠：** 使用优惠码 `ENTHUSIAST_50`，可享受 Enthusiast 套餐**首月五折**。该优惠仅适用于首月。

## ✨ 核心特性

- **🌍 14个学术平台**: arXiv, Web of Science, PubMed, Google Scholar, bioRxiv, medRxiv, Semantic Scholar, IACR ePrint, Sci-Hub, ScienceDirect, Springer Nature, Wiley, Scopus, Crossref
- **🧭 WoS Starter + Expanded**：默认 Starter v2；Expanded 的 SR/FR 与引用关系必须显式选择
- **🌐 公共页面访问发现**：可选使用 ScrapingAnt Extended 抓取 DOI 出版商页面；不会代理 Clarivate API 或机构登录页面
- **🔗 MCP协议集成**: 与Claude Desktop和其他AI助手无缝集成
- **📊 统一数据模型**: 标准化的论文数据格式，支持所有平台
- **⚡ 高性能搜索**: 并发搜索和智能速率限制
- **🛡️ 安全优先**: DOI验证、查询清理、注入防护、敏感数据脱敏
- **📝 类型安全**: 完整的TypeScript支持和扩展接口
- **🎯 学术论文优先**: 智能过滤，优先显示学术论文而非书籍
- **🔄 智能错误处理**: 统一ErrorHandler，支持重试逻辑和平台降级

## 📚 支持的平台

| 平台 | 搜索 | 下载 | 全文 | 被引统计 | API密钥 | 特色功能 |
|------|------|------|------|----------|---------|----------|
| **Crossref** | ✅ | ❌ | ❌ | ✅ | ❌ | 默认搜索平台，广泛的元数据覆盖 |
| **arXiv** | ✅ | ✅ | ✅ | ❌ | ❌ | 物理/计算机科学预印本 |
| **Web of Science** | ✅ | ❌ | ❌ | ✅ | ✅ 必需 | 默认 Starter v2；Expanded SR/FR 与关系查询需显式启用 |
| **PubMed** | ✅ | ❌ | ❌ | ❌ | 🟡 可选 | 生物医学文献 |
| **Google Scholar** | ✅ | ❌ | ❌ | ✅ | ❌ | 直接解析或可选 ScrapingAnt General |
| **bioRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | 生物学预印本 |
| **medRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | 医学预印本 |
| **Semantic Scholar** | ✅ | ✅ | ❌ | ✅ | 🟡 可选 | AI语义搜索 |
| **IACR ePrint** | ✅ | ✅ | ✅ | ❌ | ❌ | 密码学论文 |
| **Sci-Hub** | 需启用 | 需启用 | ❌ | ❌ | ❌ | 仅 DOI 的受控 HTML 适配器，默认关闭 |
| **ScienceDirect** | ✅ | ❌ | ❌ | ✅ | ✅ 必需 | 爱思唯尔全文数据库 |
| **Springer Nature** | ✅ | ✅* | ❌ | ❌ | ✅ 必需 | 双API：Meta v2 & OpenAccess |
| **Wiley** | ❌ | ✅ | ✅ | ❌ | ✅ 必需 | TDM API：仅支持DOI下载PDF |
| **Scopus** | ✅ | ❌ | ❌ | ✅ | ✅ 必需 | 最大引文数据库 |

✅ 已支持 | ❌ 不支持 | 🟡 可选 | ✅* 仅开放获取

> **注意**: Wiley TDM API不支持关键词搜索。请使用`search_crossref`搜索Wiley文章获取DOI，然后使用`download_paper`配合`platform="wiley"`通过DOI下载PDF。

## ⚖️ 合规与伦理使用（Sci-Hub / Google Scholar）

本项目包含的部分集成可能涉及**法律、第三方服务条款（ToS）与伦理**风险。你需要自行确保使用方式符合当地法律、机构政策以及第三方平台条款。

- **Sci-Hub**：默认关闭且仅提供不稳定的 DOI/镜像适配器，不授予访问权。只有在你对内容拥有合法访问授权时才应显式启用。
- **Google Scholar/ScrapingAnt**：自动抓取可能触发封禁或违反服务条款。ScrapingAnt 仅在配置后用于公共 Scholar/出版社页面，不用于 WoS 登录、SSO、MFA 或机构订阅页面。

## 🚀 快速开始

### 系统要求

- Node.js 20.18.1+（Node.js 21 受依赖包 engine 约束不支持）
- npm 或 yarn

### 安装

```bash
# 克隆仓库
git clone https://github.com/Dianel555/paper-search-mcp-nodejs.git
cd paper-search-mcp-nodejs

# 安装依赖
npm install

# 复制环境变量模板
cp .env.example .env
```

### 配置

1. **获取Web of Science API密钥**
   - 访问 [Clarivate Developer Portal](https://developer.clarivate.com/apis)
   - 注册并申请Web of Science API访问权限
   - 将API密钥添加到 `.env` 文件

2. **获取PubMed API密钥（可选）**
   - 无API密钥：免费使用，限制每秒3次请求
   - 有API密钥：每秒10次请求，更稳定的服务
   - 获取密钥：参考 [NCBI API Keys](https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/)

3. **配置环境变量**
   ```bash
   # 编辑 .env 文件
   # Web of Science 默认使用 Starter v2 和 WOS_API_KEY。
   WOS_API_KEY=your_web_of_science_api_key
   # Expanded 产品密钥（可选）。
   WOS_EXPANDED_API_KEY=your_expanded_key
   WOS_STARTER_VERSION=v2
   WOS_STARTER_RPS=1
   WOS_STARTER_DAILY_LIMIT=50
   WOS_EXPANDED_RPS=2
   # 每日 Full Record 条数；0 表示本地配额不限。
   WOS_EXPANDED_FULL_RECORD_BUDGET=0
   WOS_EXPANDED_BASE_URL=https://api.clarivate.com/api/wos
   
   # 可选的公共页面 HTML 后备；不会代理 WoS/API
   # 仅有 key 不会授权付费请求；browser 和 residential 后备分别显式授权。
   # 未授权 residential 时 Publisher/Scholar 默认为每操作 50、每请求 10 credits。
   # SCRAPINGANT_ALLOW_RESIDENTIAL=true 后默认为 500/125；显式有效限制优先，
   # 但 residential 请求仍必须满足 residential 上限。
   SCRAPINGANT_API_KEY=
   SCRAPINGANT_ENABLED=false
   SCRAPINGANT_ALLOW_BROWSER_ESCALATION=false
   SCRAPINGANT_ALLOW_RESIDENTIAL=false
   SCRAPINGANT_MAX_CREDITS_PER_OPERATION=50
   SCRAPINGANT_MAX_CREDITS_PER_REQUEST=10
   SCRAPINGANT_MAX_CONCURRENCY=1
   SCRAPINGANT_PROXY_TYPE=datacenter
   
   # 受控 Sci-Hub 适配器；除非显式开启，否则关闭
   # 镜像地址会在查询时从 Sci-Hub 和 ooopn 镜像目录页动态获取。
   # SCIHUB_MIRRORS 可选，支持逗号分隔的补充网址。
   SCIHUB_ENABLED=false
   SCIHUB_FETCH_MODE=fallback
   SCIHUB_MIRRORS=
   SCIHUB_HEALTHCHECK_CONCURRENCY=3
   
   # PubMed API密钥（可选，建议配置以获得更好性能）
   PUBMED_API_KEY=your_ncbi_api_key_here
   
   # Semantic Scholar API密钥（可选，提升请求限制）
   SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_api_key
   
   # Elsevier API密钥：ScienceDirect Search v2 和 Scopus 详情接口
   ELSEVIER_API_KEY=your_elsevier_api_key
   # 可选：Scopus Search API 专用密钥；未配置时回退到 ELSEVIER_API_KEY
   SCOPUS_SEARCH_API_KEY=
   
   # Springer Nature API密钥（Springer必需）
   SPRINGER_API_KEY=your_springer_api_key  # Meta v2 API
   # 可选：OpenAccess API单独密钥（如果与主密钥不同）
   SPRINGER_OPENACCESS_API_KEY=your_openaccess_api_key
   
   # Wiley TDM令牌（Wiley必需）
   WILEY_TDM_TOKEN=your_wiley_tdm_token
   ```

### 构建和运行

#### 方法1: NPX部署 (推荐用于MCP)
```bash
# 使用npx直接运行 (最常见的MCP部署方式)
npx -y paper-search-mcp-nodejs

# 或全局安装
npm install -g paper-search-mcp-nodejs
paper-search-mcp
```

#### 方法2: 本地开发
```bash
# 构建TypeScript代码
npm run build

# 运行服务器
npm start

# 或者在开发模式下运行
npm run dev
```

### MCP服务器配置

在Claude Desktop配置文件中添加以下配置：

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

#### 最简 NPX 配置（建议从这里开始）
使用下面的最简配置即可立即通过 Crossref、arXiv 等公开来源开始使用。不需要 API 密钥或可选环境变量；只有在需要特定平台时再添加对应密钥。

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

#### 完整 NPX 配置（高级/可选）
只有在需要带密钥的平台、可选后备或自定义限制时才使用下面的完整配置。`env` 中的值必须都是字符串；请替换所有占位符为你自己的环境变量，不要将真实密钥提交到仓库。

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

`SCHOLAR_PROXY` 是 Scholar 直连传输的可选显式覆盖项。为空时，Scholar 在已配置的情况下使用运行环境中的标准本地代理别名（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，含小写形式）；设置后它优先于这些别名，并按完整的 HTTP(S)/SOCKS 代理 URL 解析。它不会选择 ScrapingAnt 付费后备。检索 benchmark 不会启用或替换它。`WOS_EXPANDED_API_KEY`、`SCRAPINGANT_API_KEY` 及其他可选密钥可以保持为空。

#### 本地安装配置
本地构建时保留上方完整的 `env` 对象，只需替换服务器命令：

```json
{
  "command": "node",
  "args": ["/path/to/paper-search-mcp-nodejs/dist/server.js"]
}
```

## 🛠️ MCP工具

### `search_papers`
搜索多个平台的学术论文

```typescript
// 随机平台选择（默认行为）
search_papers({
  query: "machine learning",
  platform: "all",      // 随机选择一个平台，提供高效聚焦的结果
  maxResults: 10,
  year: "2023",
  sortBy: "date"
})

// 搜索特定平台
search_papers({
  query: "quantum computing",
  platform: "webofscience",  // 指定特定平台
  maxResults: 5
})
```

**平台选择行为：**
- `platform: "crossref"` (默认) - 免费API，广泛的学术元数据覆盖
- `platform: "all"` - 随机选择一个平台进行高效、聚焦的搜索
- 特定平台 - 仅搜索指定平台
- 可用平台: `crossref`, `arxiv`, `webofscience`/`wos`, `pubmed`, `biorxiv`, `medrxiv`, `semantic`, `iacr`, `googlescholar`/`scholar`, `scihub`, `sciencedirect`, `springer`, `scopus`
- 注意: `wiley`仅支持通过DOI下载PDF，不支持关键词搜索

### `search_crossref`
搜索Crossref学术数据库（默认搜索平台）

```typescript
search_crossref({
  query: "machine learning",
  maxResults: 10,
  year: "2023",
  author: "Smith",
  sortBy: "relevance",  // 或 "date", "citations"
  sortOrder: "desc"
})
```

### `search_arxiv`
专门搜索arXiv预印本

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
专门搜索Web of Science数据库

```typescript
search_webofscience({
  query: "CRISPR gene editing",
  maxResults: 5,
  year: "2022",
  journal: "Nature",
  apiProduct: "expanded",   // 省略则使用 Starter v2
  recordView: "short",      // 仅 Expanded；full 需显式选择
  discoverAccess: true,      // 可选出版社公共页面发现
  discoverAccessMaxItems: 5  // 范围 1-100；默认 5
})

get_webofscience_related_records({
  uid: "WOS:000000000000001",
  relation: "citing",       // references、citing 或 related
  maxResults: 50
})
```

### `search_pubmed`
专门搜索PubMed/MEDLINE生物医学文献数据库

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
专门搜索Google Scholar学术数据库

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
搜索生物学和医学预印本

```typescript
search_biorxiv({
  query: "CRISPR",
  maxResults: 15,
  days: 30,
  category: "genomics"  // neuroscience, genomics等
})

search_medrxiv({
  query: "COVID-19",
  maxResults: 10,
  days: 30,
  category: "infectious_diseases"
})
```

### `search_semantic_scholar`
搜索Semantic Scholar AI语义数据库

```typescript
search_semantic_scholar({
  query: "deep learning",
  maxResults: 10,
  fieldsOfStudy: ["Computer Science"],
  year: "2023"
})
```

### `search_iacr`
搜索IACR ePrint密码学论文档案

```typescript
search_iacr({
  query: "zero knowledge proof",
  maxResults: 5,
  fetchDetails: true
})
```

### `search_scihub`
受控、需显式启用的 Sci-Hub DOI 查询/下载；默认关闭且不是官方 API

```typescript
// 需要设置 SCIHUB_ENABLED=true；仅接受 DOI/doi.org URL。
// 默认从 https://sci-hub.mobi/en/mirrors 和
// https://www.ooopn.com/tool/scihub/ 获取镜像；SCIHUB_MIRRORS 可补充多个逗号分隔的网址。
search_scihub({
  doiOrUrl: "10.1038/nature12373",
  downloadPdf: true,
  savePath: "./downloads"
})
```

### `search_sciencedirect`
搜索爱思唯尔ScienceDirect数据库

```typescript
search_sciencedirect({
  query: "artificial intelligence",
  maxResults: 10,
  year: "2023",
  author: "Smith",
  openAccess: true  // 仅搜索开放获取论文
})
```

### `search_springer`
搜索Springer Nature数据库（Metadata API v2 或 OpenAccess API）

```typescript
search_springer({
  query: "machine learning",
  maxResults: 10,
  year: "2023",
  openAccess: true,  // 使用OpenAccess API获取可下载PDF
  type: "Journal"    // 过滤类型: Journal, Book, Chapter
})
```

### `search_wiley` (已废弃)
> **注意**: Wiley TDM API不支持关键词搜索。请使用`search_crossref`搜索Wiley文章，然后使用`download_paper`通过DOI下载PDF。

```typescript
// 正确的Wiley使用方式：
// 1. 使用Crossref搜索Wiley文章
search_crossref({
  query: "cancer research",
  maxResults: 10
})

// 2. 使用download_paper通过DOI下载PDF
download_paper({
  paperId: "10.1111/xxx.12345",
  platform: "wiley",
  savePath: "./downloads"
})
```

### `search_scopus`
搜索Scopus引文数据库

```typescript
search_scopus({
  query: "renewable energy",
  maxResults: 10,
  affiliation: "MIT",
  documentType: "ar"  // ar=文章, cp=会议论文, re=综述
})
```

Scopus 搜索默认请求 `COMPLETE`。如果 Elsevier 明确返回当前 API key 没有 `COMPLETE` view 权限，程序会有界地进入一次 `STANDARD` 后备策略；其中的临时错误重试仍遵循现有重试策略。该后备不携带 `field` 覆盖项，以便 API 返回标准字段。其他认证、查询、限流、网络或服务端错误不会被转换为 view 回退。`STANDARD` 可能不包含完整作者、摘要、关键词、机构和资助等扩展元数据；使用 Scopus 仍然需要有效的 API 密钥。各 view 支持的字段请参阅 [Scopus Search API views](https://dev.elsevier.com/sc_search_views.html)。

### `check_scihub_mirrors`
检查Sci-Hub镜像站点健康状态

```typescript
check_scihub_mirrors({
  forceCheck: true  // 强制刷新健康检查
})
```

### `download_paper`
下载论文PDF文件

```typescript
download_paper({
  paperId: "2106.12345",
  platform: "arxiv",
  savePath: "./downloads"
})
```

### `get_paper_by_doi`
通过DOI获取论文信息

```typescript
get_paper_by_doi({
  doi: "10.1038/s41586-023-12345-6",
  platform: "all"
})
```

### `discover_paper_access`
按 DOI 发现一个出版社公共 PDF 候选。它不声称开放许可或完整下载成功；PDF 验证是可选且有界的。

```typescript
discover_paper_access({
  doi: "https://doi.org/10.1038/s41586-023-12345-6",
  verifyPdf: false
})
```

### `get_platform_status`
检查本地平台能力和 API 密钥状态。这是本地诊断，不会验证 ScrapingAnt 账户余额，也不会发起付费请求。

```typescript
get_platform_status({})
```

### 公共访问与成本边界

`discover_paper_access` 只接受 DOI，返回 `oa_candidate`、`pdf_verified`、`not_found`、`restricted`、`failed` 或 `skipped` 等有界状态；候选链接不代表开放许可或完整下载成功。`verifyPdf` 为显式选择项，只读取有界的 PDF 前缀。候选顺序、来源 provenance、HTTP/API 状态、后备尝试和已知本地成本是彼此独立的证据字段。

付费检索始终 Direct-first 且有界。空页面/解析失败可以在获得明确授权后消耗后备尝试；已知权限限制、不安全目标、资源限制、取消、截止时间、未知价格或已关闭 ledger 都会停止付费工作。已发送请求的账单缺失/无效只记录为 unknown 并消费本地估算，不单独停止仍受预算约束的 retry/fallback；对账前报告费用保持未知。显式允许 browser 时，Scholar 生产先发送一次 ScrapingAnt `browser:datacenter` 后备请求；browser 不重试。诊断不会返回 Cookie、Authorization、查询词、原始 HTML 或敏感 URL。Scholar 会话 Cookie 只保留在内存中的 Scholar HTTPS 同源会话，不会发送给 ScrapingAnt。

只有获得部署授权后才设置 `SCRAPINGANT_ENABLED=true`。Scholar 的 browser-first 后备需要 `SCRAPINGANT_ALLOW_BROWSER_ESCALATION=true`；`SCRAPINGANT_ALLOW_BROWSER_ESCALATION` 与 `SCRAPINGANT_ALLOW_RESIDENTIAL` 相互独立。关闭任一开关并重启会回滚对应组合，但不会抹除已经记录的本地成本；不会同步供应商余额，也不会清除正在运行的 ledger。

### 离线 benchmark

固定 corpus 与策略计划可在无网络下校验；完整 360-cell live 指标属于另行授权的外部 qualification，不是每次工程修复的完成门：

```bash
# 账务/报告模拟（不运行生产检索 workflow）
npm run --silent benchmark:offline -- --json
# 在固定 raw fixture 下运行经过审查的离线生产 workflow（虚拟时钟）
npm run --silent benchmark:offline -- --workflow --json
# 可选：写入经过编码的 run-id .json/.md artifact，且不会覆盖已有文件。
npm run --silent benchmark:offline -- --workflow --output-dir ./benchmark-artifacts
```

默认命令通过仅响应的离线 accounting simulator 校验冻结的 20 个 DOI、10 个 Scholar 查询和确定性的 360-cell 计划。加上 `--workflow` 后，命令改为运行经过审查的 `createProductionBenchmarkCellExecutor`：在独立固定 raw fixture 下调用真实 Publisher/Scholar 业务入口、provider、解析、会话、后备、调度、计费桥和 PDF 前缀路径；使用虚拟时钟，但保留生产节流规则。两种模式都明确是 offline-only，不会初始化线上 provider 或使用凭据，也不能产生 `live_passed`；workflow 报告必须与 simulator 的统计分开识别。线上评估使用独立的 live 命令，不会恢复旧 run 或隐式消耗 credits。计划包含 60 个生产 cell 与 300 个独立对照 cell；未执行的线上 cell 保持 `not_run` 并保留在分母中。artifact 路径采用独占创建，不会静默覆盖旧 run。

```bash
# 已完成评审并获得明确授权后，运行一次有界 live campaign。
npm run --silent benchmark:live -- --authorize-live --authorize-scholar-proxy --run-id live-YYYYMMDD-01 --output-dir ./live-benchmark-artifacts --json
```

live 命令要求冻结 corpus、完整的 paid/browser/residential 配置、公开目标 preflight 和固定安全上限（15,000 credits、1,500 HTTP dispatches、7,200,000ms）。preflight 失败会生成 privacy-safe 的 `blocked` 报告且零 dispatch，不会缩小固定矩阵、追加预算或绕过配置；对照 cell 仍是单一 strategy、无 retry/fallback，Publisher 对照不探测 PDF。不要将 `--authorize-live` 当作供应商余额或 capability 授权；显式 `SCHOLAR_PROXY` 端点完成独立 TLS/所有权审查后，才可额外传入 `--authorize-scholar-proxy`，仅有 ambient 代理别名仍会被阻断。

## 📊 数据模型

所有平台的论文数据都转换为统一的格式：

```typescript
interface Paper {
  paperId: string;           // 唯一标识符
  title: string;            // 论文标题
  authors: string[];        // 作者列表
  abstract: string;         // 摘要
  doi: string;             // DOI
  publishedDate: Date;     // 发布日期
  pdfUrl: string;          // PDF链接
  url: string;             // 论文页面URL
  source: string;          // 来源平台
  citationCount?: number;   // 被引次数
  journal?: string;         // 期刊名称
  year?: number;           // 年份
  categories?: string[];    // 学科分类
  keywords?: string[];      // 关键词
  // ... 更多字段
}
```

## 🔧 开发

### 项目结构

```
src/
├── models/
│   └── Paper.ts              # 论文数据模型
├── platforms/
│   ├── PaperSource.ts        # 抽象基类
│   ├── ArxivSearcher.ts      # arXiv搜索器
│   ├── WebOfScienceSearcher.ts # Web of Science搜索器
│   ├── PubMedSearcher.ts     # PubMed搜索器
│   ├── GoogleScholarSearcher.ts # Google Scholar搜索器
│   ├── BioRxivSearcher.ts    # bioRxiv/medRxiv搜索器
│   ├── SemanticScholarSearcher.ts # Semantic Scholar搜索器
│   ├── IACRSearcher.ts       # IACR ePrint搜索器
│   ├── SciHubSearcher.ts     # Sci-Hub搜索器（带镜像管理）
│   ├── ScienceDirectSearcher.ts # ScienceDirect（爱思唯尔）搜索器
│   ├── SpringerSearcher.ts   # Springer Nature搜索器（Meta v2 & OpenAccess API）
│   ├── WileySearcher.ts      # Wiley TDM API（仅DOI下载）
│   ├── ScopusSearcher.ts     # Scopus引文数据库搜索器
│   └── CrossrefSearcher.ts   # Crossref API搜索器（默认平台）
├── mcp/
│   ├── tools.ts              # MCP工具定义
│   ├── schemas.ts            # Zod参数校验
│   ├── handleToolCall.ts     # 工具调用分发
│   └── searchers.ts          # 搜索器初始化
├── utils/
│   ├── SecurityUtils.ts      # DOI验证、查询清理、注入防护
│   ├── PublicNetwork.ts      # 公网目标DNS/重定向与SSRF校验
│   ├── ConcurrencyLimiter.ts # 无依赖的并发限制
│   ├── ErrorHandler.ts       # 统一错误处理与重试逻辑
│   ├── RateLimiter.ts        # 令牌桶速率限制
│   ├── QuotaManager.ts       # 每日配额追踪
│   ├── RequestCache.ts       # 请求LRU缓存
│   ├── PDFExtractor.ts       # PDF文本提取
│   └── Logger.ts             # 调试日志
├── config/
│   └── constants.ts          # 超时、端点、限制配置
├── services/
│   ├── CitationService.ts            # 引文获取服务
│   ├── WebOfScienceParser.ts         # Starter/Expanded响应解析
│   ├── WebOfScienceRequestService.ts # WoS请求、重试、限流、配额
│   ├── PublicHttpClient.ts           # 检查重定向的公网HTTP
│   ├── ScrapingAntFetcher.ts         # General/Extended HTML封装
│   └── PublicAccessDiscovery.ts      # DOI出版社页面PDF发现
└── server.ts                 # MCP服务器主文件
```

### 添加新平台

1. 创建新的搜索器类继承 `PaperSource`
2. 实现必需的抽象方法
3. 在 `searchers.ts` 中注册新的搜索器
4. 在 `tools.ts` 中添加相应的MCP工具

### 安全最佳实践

- 所有DOI在使用前都经过验证
- 查询参数经过转义以防止注入
- 所有日志输出中的API密钥都已脱敏
- 请求超时防止连接挂起
- 查询复杂度限制防止DoS攻击
- 速率限制和配额管理防止API滥用
- 缓存减少外部API调用

### 测试

```bash
# 运行测试
npm test

# 运行代码检查
npm run lint

# 代码格式化
npm run format
```

**测试覆盖：**
- 包含 WoS HTTP 契约、ScrapingAnt 状态/计费、公网 SSRF 校验、访问发现、Sci-Hub 后备/PDF 校验和 MCP schema 回归测试。
- 各平台搜索器均有单元或契约测试覆盖
- 安全工具（DOI验证、查询清理）
- 错误处理器（错误分类、重试逻辑）
- 速率限制集成、配额管理、请求缓存

| 测试套件 | 覆盖状态 |
|----------|----------|
| 平台搜索器 | ✅ |
| SecurityUtils | ✅ |
| ErrorHandler | ✅ |
| RateLimiter & Integration | ✅ |
| QuotaManager | ✅ |
| RequestCache | ✅ |

## 🌟 平台特性

### Springer Nature 双API系统

Springer Nature提供两个API：

1. **Metadata API v2**（主API）
   - 端点：`https://api.springernature.com/meta/v2/json`
   - 搜索所有Springer内容（订阅 + 开放获取）
   - 需要从http://dev.springernature.com/获取API密钥

2. **OpenAccess API**（可选）
   - 端点：`https://api.springernature.com/openaccess/json`  
   - 仅搜索开放获取内容
   - 可能需要单独的API密钥或特殊权限
   - 更适合查找可下载的PDF

### Web of Science 特性

🎯 **WoS Starter + Expanded**：Starter API v2 为默认版本，v1 仍可显式选择。Expanded 必须显式选择。

**API版本与产品配置：**
```bash
# Starter版本（默认v2；进程内固定）
WOS_STARTER_VERSION=v2
# WOS_STARTER_VERSION=v1

# Web of Science 默认使用 Starter v2。
WOS_API_KEY=...
# Expanded 产品密钥（可选）。
WOS_EXPANDED_API_KEY=...
```

Starter 使用文档规定的 `/documents` 端点，每页最多 50 条；未知被引次数序列化为 `null`。Expanded 使用独立的 `/api/wos` 契约，默认 Short Record，并仅在显式请求时使用 Full Record、references、citing 或 related。默认地址采用当前 Swagger 服务器 `https://api.clarivate.com/api/wos`，不使用旧的 `wos-api.clarivate.com` 指引。

### 高级搜索语法

```typescript
// 多主题搜索
search_webofscience({
  query: 'oriented structure',
  year: '2023-2025',
  sortBy: 'date',
  sortOrder: 'desc',
  maxResults: 10
})

// 年份范围过滤
search_webofscience({
  query: 'machine learning',
  year: '2020-2024',  // 支持范围格式
  sortBy: 'citations',
  sortOrder: 'desc'
})

// 高级查询与过滤器
search_webofscience({
  query: 'blockchain',
  author: 'zhang',
  journal: 'Nature',
  year: '2023',
  sortBy: 'date',
  sortOrder: 'desc'
})

// 带字段标签的传统WOS查询语法
search_webofscience({
  query: 'TS="machine learning" AND PY=2023 AND DT="Article"',
  maxResults: 20
})
```

**支持的搜索选项:**
- `query`: 搜索词 (支持多主题)
- `year`: 单个年份"2023"或范围"2020-2023"
- `author`: 作者名过滤
- `journal`: 期刊/来源过滤
- `sortBy`: 支持的排序字段 (`date`, `citations`, `relevance`)
- `sortOrder`: 排序方向 (`asc`, `desc`)
- `maxResults`: 最大结果数 (1-100；Starter每页抓取50条)
- `apiProduct`: `starter`（默认）或显式选择 `expanded`
- `recordView`: Expanded 的 `short`（默认）或显式选择 `full`
- `discoverAccess`: 可选出版社公共页面发现
- `discoverAccessMaxItems`: 发现上限（1-100；显式值、部署默认值，最后为 5）

**支持的WOS字段标签 (共18个):**
| 标签 | 描述 | 标签 | 描述 |
|------|------|------|------|
| `TS` | 主题 (标题、摘要、关键词) | `TI` | 标题 |
| `AU` | 作者 | `AI` | 作者标识符 |
| `SO` | 来源/期刊 | `IS` | ISSN/ISBN |
| `PY` | 发表年份 | `FPY` | 最终发表年份 |
| `DO` | DOI | `DOP` | 发表日期 |
| `VL` | 卷号 | `PG` | 页码 |
| `CS` | 期号 | `DT` | 文档类型 |
| `PMID` | PubMed ID | `UT` | 入藏号 |
| `OG` | 机构 | `SUR` | 来源URL |

**字段标签示例:**
```typescript
// 通过PMID搜索
search_webofscience({ query: 'PMID=12345678' })

// 通过DOI搜索
search_webofscience({ query: 'DO="10.1038/nature12373"' })

// 按文档类型过滤
search_webofscience({ query: 'TS="CRISPR" AND DT="Review"' })

// 搜索特定卷/期
search_webofscience({ query: 'SO="Nature" AND VL=580 AND CS=7805' })
```

**🔧 调试WOS问题:**
```bash
# 启用调试日志
export NODE_ENV=development

# 在CI环境中，当 CI=true 时，会自动启用 logDebug 输出
```

### Sci-Hub 特性

- **仅显式启用**：默认关闭；只接受 DOI、`doi:` 和 `doi.org` URL
- **受控后备**：先直连镜像，受阻时才在已配置 ScrapingAnt 后使用 Extended HTML 后备
- **镜像发现与健康检查**：查询时从 `https://sci-hub.mobi/en/mirrors` 和 `https://www.ooopn.com/tool/scihub/` 获取镜像，合并可选的 `SCIHUB_MIRRORS` 补充项，再以最多三个并发直连检查，并带缓存和 single-flight
- **明确状态**：区分未收录、受阻、DOM变化、镜像不健康和传输失败
- **安全 PDF 处理**：公网目标重定向校验、MIME/魔数/大小校验、临时文件和原子替换
- **合规提示**：不授予访问权，也不声称内容具有版权或授权状态

### ScrapingAnt 公共抓取层

ScrapingAnt 是可选的付费公共页面后备：仅配置 key 不会发起付费请求，必须设置 `SCRAPINGANT_ENABLED=true`；browser 和 residential 后备分别显式授权。当前 Scholar 的 `browser:datacenter` 优先顺序仍是待真实能力验证的临时策略，不代表供应商可用性；未启用 browser 时保持 static-first。未授权 residential 时 Publisher/Scholar 默认为每操作 50、每请求 10 credits；设置 `SCRAPINGANT_ALLOW_RESIDENTIAL=true` 后默认为 500/125。显式有效限制优先，但 residential dispatch 仍必须设置 `SCRAPINGANT_PROXY_TYPE=residential`，datacenter 上限不会发送 residential 流量。Google Scholar 使用通用 `/v2/general` HTML 接口而非专用 Scholar API，WoS DOI 发现和 Sci-Hub 后备使用 `/v2/extended`；绝不代理 Clarivate/WoS API。ScrapingAnt Proxy mode 不作为透明替代方案；`SCRAPINGANT_PROXY_TYPE` 只是 provider 的代理上限，`SCHOLAR_PROXY` 是独立的 Scholar 直连显式覆盖。DOI 发现会在本地可见的重定向链中先拒绝已知登录、SSO 和 Clarivate 目标。本地 DNS 校验无法证明远程代理自己的重定向目标安全，因此发现到的链接不是 OA、授权或版权结论；真实 credits 以响应头为准，本地预算不等于供应商账单余额。已知权限、安全、资源、取消或截止时间错误不会触发付费后备，已发送请求的费用缺失只记录为 unknown 并消费本地估算，不单独停止有界后备；完成的策略 scope 只保留有限缓存元数据，不保留原始 provider 文档。持续性的 Scholar 封锁仍属于供应商能力边界。

### 公共论文与 Markdown 工具

- `download_public_paper` 是独立且 strict 的 MCP 工具，仅支持 `publisher`、`googlescholar`、`scihub`。Publisher/Sci-Hub 的 `paperId` 是 DOI；Scholar 必须使用同一 MCP 连接搜索结果发布的短期引用。
- `get_paper_markdown` 只有显式调用才启用，最多发送一次 static/datacenter `/v2/markdown` 请求，返回有界且不可信的 Markdown；Markdown 不会写入 Paper、提取 PDF 候选，也不会被搜索/发现/下载隐式调用。
- Scholar 引用只保存在内存中，每个 handler 最多 256 条，TTL 300 秒且读取不续期；handler dispose/重启即失效。缺失、过期或歧义引用不会猜测 URL 或请求 provider。
- 只有部署明确获准尝试受限页面时，才设置 `SCRAPINGANT_ALLOW_AUTHORIZED_CORPUS=true` 并配置 `SCRAPINGANT_AUTHORIZED_CORPUS_PLATFORMS` 的 canonical token。系统不会转发 Cookie、Authorization、机构凭据，也不接受 MCP 传入的任意 URL。
- provider HTML/Markdown 不是 PDF 权威。新下载器会重新检查公网目标、MIME、`%PDF-`、大小、取消、路径、符号链接和原子 no-clobber 发布。现有 `download_paper` 的名称、八个平台 schema 和行为保持不变；不启用 Proxy mode 或 AI Extractor。
- 离线测试和默认配置不会发送 live/paid 请求。live canary 必须另行批准样本、预算、停止条件和报告字段。

## 🔑 API密钥需求

### 必需的API密钥
- **Web of Science**: 默认使用 `WOS_API_KEY` 的 Starter v2；Expanded 必须使用 `WOS_EXPANDED_API_KEY`，从[Clarivate Developer Portal](https://developer.clarivate.com/apis)获取
- **ScienceDirect**: 使用 `ELSEVIER_API_KEY`，调用 ScienceDirect Search API v2 的 PUT 接口
- **Scopus Search**: 推荐使用专用 `SCOPUS_SEARCH_API_KEY`；未配置时回退到 `ELSEVIER_API_KEY`
- **Scopus 详情/引用**: 使用 `ELSEVIER_API_KEY`，且仍受 Scopus entitlement 限制
- **Springer Nature**: Meta API v2必需，OpenAccess API可选，从[Springer Developer Portal](https://dev.springernature.com/)获取
- **Wiley**: 需要TDM令牌，从[Wiley TDM](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)获取

### 可选的API密钥
- **PubMed**: 提高速率限制（从3次/秒到10次/秒）
- **Semantic Scholar**: 提高速率限制（从20次/分钟到180次/分钟）

## 📝 许可证

MIT License - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🤝 贡献

欢迎贡献！

1. Fork项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开Pull Request

## 🐛 问题报告

如果遇到问题，请在 [GitHub Issues](https://github.com/your-username/paper-search-mcp-nodejs/issues) 中报告。

---

⭐ 如果这个项目对你有帮助，请给它一个星标！