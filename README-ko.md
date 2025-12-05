# Paper Search MCP (Node.js) - SSE Transport

## 한국어 | [English](README.md) | [中文](README-sc.md)

**Server-Sent Events (SSE)** 전송 방식을 사용하는 Node.js 기반 Model Context Protocol (MCP) 서버입니다. arXiv, Web of Science, PubMed, Google Scholar, Sci-Hub, ScienceDirect, Springer, Wiley, Scopus 등 **13개 학술 플랫폼**에서 논문을 검색하고 다운로드할 수 있습니다.

![Node.js](https://img.shields.io/badge/node.js->=18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-^5.5.3-blue.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platforms](https://img.shields.io/badge/platforms-13-brightgreen.svg)
![Transport](https://img.shields.io/badge/transport-SSE-orange.svg)

## ✨ 주요 기능

- **📡 SSE Transport**: HTTP를 통한 실시간 Server-Sent Events 통신
- **🌍 13개 학술 플랫폼**: arXiv, Web of Science, PubMed, Google Scholar, bioRxiv, medRxiv, Semantic Scholar, IACR ePrint, Sci-Hub, ScienceDirect, Springer Nature, Wiley, Scopus
- **🔗 MCP 프로토콜 통합**: Claude Desktop 및 기타 AI 어시스턴트와 원활한 연동
- **📊 통합 데이터 모델**: 모든 플랫폼에서 표준화된 논문 형식
- **⚡ 고성능 검색**: 지능형 속도 제한이 적용된 동시 검색
- **🛡️ 타입 안전성**: 완전한 TypeScript 지원
- **🐳 Docker 지원**: 프로덕션 환경을 위한 컨테이너화 지원

## 📚 지원 플랫폼

| 플랫폼 | 검색 | 다운로드 | 전문 | 인용 수 | API 키 | 특징 |
|--------|------|----------|------|---------|--------|------|
| **arXiv** | ✅ | ✅ | ✅ | ❌ | ❌ | 물리학/컴퓨터 과학 프리프린트 |
| **Web of Science** | ✅ | ❌ | ❌ | ✅ | ✅ 필수 | 고품질 저널 색인 |
| **PubMed** | ✅ | ❌ | ❌ | ❌ | 🟡 선택 | 생의학 문헌 |
| **Google Scholar** | ✅ | ❌ | ❌ | ✅ | ❌ | 종합 학술 검색 |
| **bioRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | 생물학 프리프린트 |
| **medRxiv** | ✅ | ✅ | ✅ | ❌ | ❌ | 의학 프리프린트 |
| **Semantic Scholar** | ✅ | ✅ | ❌ | ✅ | 🟡 선택 | AI 시맨틱 검색 |
| **IACR ePrint** | ✅ | ✅ | ✅ | ❌ | ❌ | 암호학 논문 |
| **Sci-Hub** | ✅ | ✅ | ❌ | ❌ | ❌ | DOI를 통한 논문 접근 |
| **ScienceDirect** | ✅ | ❌ | ❌ | ✅ | ✅ 필수 | Elsevier 전문 데이터베이스 |
| **Springer Nature** | ✅ | ✅* | ❌ | ❌ | ✅ 필수 | 듀얼 API: Meta v2 & OpenAccess |
| **Wiley** | ✅ | ✅ | ❌ | ❌ | ✅ 필수 | 텍스트 데이터 마이닝 API |
| **Scopus** | ✅ | ❌ | ❌ | ✅ | ✅ 필수 | 최대 인용 데이터베이스 |

✅ 지원 | ❌ 미지원 | 🟡 선택사항 | ✅* Open Access만

## 🚀 빠른 시작

### 시스템 요구사항

- Node.js >= 18.0.0
- npm 또는 yarn
- Docker (선택사항)

### 설치

```bash
# 저장소 복제
git clone https://github.com/jhleee/paper-search-mcp-nodejs-sse.git
cd paper-search-mcp-nodejs-sse

# 의존성 설치
npm install

# 환경 변수 템플릿 복사
cp .env.example .env
```

### 환경 변수 설정

```bash
# .env 파일 편집
WOS_API_KEY=your_web_of_science_api_key
WOS_API_VERSION=v1

# PubMed API 키 (선택, 성능 향상에 권장)
PUBMED_API_KEY=your_ncbi_api_key

# Semantic Scholar API 키 (선택, 속도 제한 향상)
SEMANTIC_SCHOLAR_API_KEY=your_semantic_scholar_api_key

# Elsevier API 키 (ScienceDirect, Scopus 필수)
ELSEVIER_API_KEY=your_elsevier_api_key

# Springer Nature API 키 (Springer 필수)
SPRINGER_API_KEY=your_springer_api_key

# Wiley TDM 토큰 (Wiley 필수)
WILEY_TDM_TOKEN=your_wiley_tdm_token
```

### 빌드 및 실행

#### 방법 1: 로컬 개발
```bash
# TypeScript 빌드
npm run build

# SSE 서버 시작 (http://localhost:3000)
npm start

# 또는 개발 모드로 실행
npm run dev

# 커스텀 포트와 호스트 사용
PORT=8080 HOST=0.0.0.0 npm start
```

#### 방법 2: Docker (프로덕션 권장)
```bash
# Docker Compose로 빌드 및 실행
docker-compose up -d

# 또는 수동 빌드
docker build -t paper-search-mcp-sse .
docker run -d -p 3000:3000 \
  -e WOS_API_KEY=your_key \
  -e PUBMED_API_KEY=your_key \
  paper-search-mcp-sse

# 로그 확인
docker-compose logs -f

# 중지
docker-compose down
```

### 서버 엔드포인트

서버가 시작되면 다음 엔드포인트를 사용할 수 있습니다:
- **SSE 엔드포인트**: `http://localhost:3000/sse` - MCP 프로토콜 통신용
- **메시지 엔드포인트**: `http://localhost:3000/messages` - 클라이언트→서버 메시지 (sessionId 포함)
- **상태 확인**: `http://localhost:3000/health` - 서버 상태

### MCP 클라이언트 설정

SSE transport를 지원하는 MCP 클라이언트에서 다음과 같이 설정합니다:

```json
{
  "mcpServers": {
    "paper-search-nodejs-sse": {
      "url": "http://localhost:3000/sse",
      "transport": "sse",
      "env": {
        "WOS_API_KEY": "your_web_of_science_api_key",
        "PUBMED_API_KEY": "your_ncbi_api_key"
      }
    }
  }
}
```

### 연결 테스트

```bash
# 서버 상태 확인
curl http://localhost:3000/health

# SSE 연결 테스트
curl -N http://localhost:3000/sse
```

## 🛠️ MCP 도구

### `search_papers`
여러 플랫폼에서 학술 논문 검색

```typescript
search_papers({
  query: "machine learning",
  platform: "arxiv",      // 또는 "all"로 랜덤 플랫폼 선택
  maxResults: 10,
  year: "2023",
  sortBy: "date"
})
```

### `search_arxiv`
arXiv 프리프린트 검색

```typescript
search_arxiv({
  query: "transformer neural networks",
  maxResults: 10,
  category: "cs.AI"
})
```

### `search_pubmed`
PubMed/MEDLINE 생의학 문헌 검색

```typescript
search_pubmed({
  query: "COVID-19 vaccine",
  maxResults: 20,
  year: "2023"
})
```

### `search_scihub`
DOI를 사용하여 Sci-Hub에서 논문 검색 및 다운로드

```typescript
search_scihub({
  doiOrUrl: "10.1038/nature12373",
  downloadPdf: true,
  savePath: "./downloads"
})
```

### `download_paper`
논문 PDF 다운로드

```typescript
download_paper({
  paperId: "2106.12345",
  platform: "arxiv",
  savePath: "./downloads"
})
```

### `get_platform_status`
플랫폼 상태 및 API 키 확인

```typescript
get_platform_status({})
```

## 📊 데이터 모델

모든 플랫폼의 논문 데이터는 통합된 형식으로 변환됩니다:

```typescript
interface Paper {
  paperId: string;        // 고유 식별자
  title: string;          // 논문 제목
  authors: string[];      // 저자 목록
  abstract: string;       // 초록
  doi: string;            // DOI
  publishedDate: Date;    // 발행일
  pdfUrl: string;         // PDF 링크
  url: string;            // 논문 페이지 URL
  source: string;         // 출처 플랫폼
  citationCount?: number; // 인용 수
  journal?: string;       // 저널명
  year?: number;          // 발행 연도
}
```

## 🔧 개발

### 프로젝트 구조

```
src/
├── models/
│   └── Paper.ts              # 논문 데이터 모델
├── platforms/
│   ├── PaperSource.ts        # 추상 기본 클래스
│   ├── ArxivSearcher.ts      # arXiv 검색기
│   ├── PubMedSearcher.ts     # PubMed 검색기
│   ├── SciHubSearcher.ts     # Sci-Hub 검색기
│   └── ...                   # 기타 플랫폼
├── utils/
│   └── RateLimiter.ts        # 토큰 버킷 속도 제한기
└── server.ts                 # MCP 서버 메인 파일
```

### 테스트

```bash
# 테스트 실행
npm test

# 린트 검사
npm run lint

# 코드 포맷팅
npm run format
```

## 🐳 Docker 배포

### Docker Compose 사용

```yaml
# docker-compose.yml
version: '3.8'
services:
  paper-search-mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - WOS_API_KEY=${WOS_API_KEY}
      - PUBMED_API_KEY=${PUBMED_API_KEY}
    restart: unless-stopped
```

```bash
# .env 파일에 API 키 설정 후 실행
docker-compose up -d
```

### 수동 Docker 빌드

```bash
# 이미지 빌드
docker build -t paper-search-mcp-sse .

# 컨테이너 실행
docker run -d \
  --name paper-search-mcp \
  -p 3000:3000 \
  -e WOS_API_KEY=your_key \
  paper-search-mcp-sse
```

## 📝 라이선스

MIT License - 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.

## 🤝 기여

기여를 환영합니다!

1. 프로젝트 Fork
2. 기능 브랜치 생성 (`git checkout -b feature/amazing-feature`)
3. 변경사항 커밋 (`git commit -m 'Add amazing feature'`)
4. 브랜치에 푸시 (`git push origin feature/amazing-feature`)
5. Pull Request 열기

## 🐛 문제 보고

문제가 발생하면 [GitHub Issues](https://github.com/jhleee/paper-search-mcp-nodejs-sse/issues)에 보고해 주세요.

## 🙏 감사의 말

- 기반이 된 원본 [paper-search-mcp](https://github.com/openags/paper-search-mcp)
- MCP 프로토콜 표준을 위한 MCP 커뮤니티

---

⭐ 이 프로젝트가 도움이 되었다면 별을 눌러주세요!
