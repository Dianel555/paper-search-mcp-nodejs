/**
 * handleToolCall Security Tests
 * Verifies savePath path-traversal guard prevents writing outside the downloads dir
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as path from 'node:path';
import { handleToolCall } from '../../src/mcp/handleToolCall.js';
import { PaperFactory, type Paper } from '../../src/models/Paper.js';
import { CitationService } from '../../src/services/CitationService.js';

interface SearcherLike {
  getCapabilities: () => { download: boolean; search: boolean; fullText: boolean; citations: boolean; requiresApiKey: boolean; supportedOptions: string[] };
  downloadPdf: (paperId: string, options?: any) => Promise<string>;
  search: (query: string, options?: any) => Promise<any[]>;
  getPaperByDoi: (doi: string) => Promise<any | null>;
}

function makeSearcher(download: boolean = true): SearcherLike {
  return {
    getCapabilities: () => ({
      download,
      search: true,
      fullText: false,
      citations: false,
      requiresApiKey: false,
      supportedOptions: []
    }),
    downloadPdf: jest.fn(async (_paperId: string, _options?: any) => '/safe/downloads/paper.pdf'),
    search: jest.fn(async () => []),
    getPaperByDoi: jest.fn(async () => null)
  };
}

function makeSearchers(overrides: Record<string, any> = {}) {
  return {
    arxiv: makeSearcher(),
    ...overrides
  } as Record<string, SearcherLike>;
}

describe('handleToolCall savePath guard', () => {
  it('should reject a path traversal savePath in download_paper', async () => {
    const searchers = makeSearchers() as any;

    await expect(
      handleToolCall('download_paper', { paperId: '2301.00123', platform: 'arxiv', savePath: '../../etc' }, searchers)
    ).rejects.toThrow(/traversal/i);
  });

  it('should reject an absolute path outside the downloads dir', async () => {
    const searchers = makeSearchers() as any;
    await expect(
      handleToolCall('download_paper', { paperId: '2301.00123', platform: 'arxiv', savePath: '/etc/passwd' }, searchers)
    ).rejects.toThrow(/traversal/i);
  });

  it('should allow a safe relative savePath', async () => {
    const searchers = makeSearchers() as any;
    const response = await handleToolCall(
      'download_paper',
      { paperId: '2301.00123', platform: 'arxiv', savePath: 'sub' },
      searchers
    );
    expect(response.content[0].text).toContain('downloaded');
  });

  it('passes the MCP operation context into downloads', async () => {
    const searcher = makeSearcher();
    const operation = {
      operationId: 'download-operation',
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      remainingMs: () => 60_000,
      cost: {} as any
    };
    await handleToolCall(
      'download_paper',
      { paperId: '2301.00123', platform: 'arxiv', savePath: 'sub' },
      makeSearchers({ arxiv: searcher }) as any,
      operation
    );
    expect(searcher.downloadPdf).toHaveBeenCalledWith('2301.00123', expect.objectContaining({
      operationContext: operation
    }));
  });

  it('routes the independent public-paper and Markdown tools through one business service', async () => {
    const publicPaper = {
      download: jest.fn(async (input: any) => ({
        platform: input.platform,
        normalizedPaperId: input.paperId,
        status: 'downloaded',
        diagnostics: { phase: 'download', reason: 'downloaded', apiStatus: null, targetStatus: null, strategy: null, candidateCount: 1 },
        cost: { attempted: false, known: true, credits: 0 },
        filePath: '/safe/paper.pdf'
      })),
      markdown: jest.fn(async (input: any) => ({
        platform: input.platform,
        normalizedPaperId: input.paperId,
        status: 'ok',
        diagnostics: { phase: 'markdown', reason: 'ok', apiStatus: 200, targetStatus: 200, strategy: 'static', candidateCount: 0 },
        cost: { attempted: true, known: true, credits: 1 },
        markdown: '# untrusted',
        untrusted: true
      }))
    };
    const operation = {
      operationId: 'public-paper-operation',
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000,
      remainingMs: () => 60_000,
      cost: {} as any
    };
    const searchers = makeSearchers({ publicPaper }) as any;
    const download = await handleToolCall('download_public_paper', {
      platform: 'publisher', paperId: '10.1000/test', savePath: 'public-tool-test'
    }, searchers, operation);
    const markdown = await handleToolCall('get_paper_markdown', {
      platform: 'publisher', paperId: '10.1000/test'
    }, searchers, operation);

    expect(JSON.parse(download.content[0].text).status).toBe('downloaded');
    expect(JSON.parse(markdown.content[0].text).markdown).toBe('# untrusted');
    expect(publicPaper.download).toHaveBeenCalledWith(expect.objectContaining({ operation }));
    expect(publicPaper.markdown).toHaveBeenCalledWith(expect.objectContaining({ operation }));
  });

  it('resolves the public-paper default save directory exactly once', async () => {
    const publicPaper = {
      download: jest.fn(async () => ({
        platform: 'publisher', normalizedPaperId: '10.1000/test', status: 'downloaded',
        diagnostics: { phase: 'download', reason: 'downloaded', apiStatus: null, targetStatus: null, strategy: null, candidateCount: 1 },
        cost: { attempted: false, known: true, credits: 0 }, filePath: '/safe/paper.pdf'
      }))
    };
    const operation = {
      operationId: 'public-default-path', signal: new AbortController().signal,
      deadlineAt: Date.now() + 60_000, remainingMs: () => 60_000, cost: {} as any
    };
    await handleToolCall('download_public_paper', { platform: 'publisher', paperId: '10.1000/test' }, makeSearchers({ publicPaper }) as any, operation);
    expect(publicPaper.download).toHaveBeenCalledWith(expect.objectContaining({ saveDirectory: path.resolve('./downloads') }));
  });

  it('should reject an unsupported platform in download_paper', async () => {
    const searchers: any = {};
    // Schema validation rejects unknown enum values before reaching tool dispatch.
    await expect(
      handleToolCall('download_paper', { paperId: 'x', platform: 'nope' }, searchers)
    ).rejects.toThrow();
  });

  it('should reject an invalid DOI in get_paper_by_doi', async () => {
    const searchers = makeSearchers() as any;
    await expect(
      handleToolCall('get_paper_by_doi', { doi: 'not-a-doi' }, searchers)
    ).rejects.toThrow(/DOI/i);
  });

  it('dispatches DOI access discovery with verification disabled by default', async () => {
    const access = {
      enrich: jest.fn(async (papers: Paper[], _options: { verifyPdf: boolean }) => [{
        ...papers[0],
        pdfUrl: 'https://publisher.example/paper.pdf',
        extra: {
          accessDiscovery: {
            status: 'oa_candidate',
            reason: 'safe_candidate'
          }
        }
      }])
    };
    const response = await handleToolCall(
      'discover_paper_access',
      { doi: 'doi:10.1000/test' },
      makeSearchers({ publicAccess: access }) as any
    );
    const body = JSON.parse(response.content[0].text);
    expect(body.doi).toBe('10.1000/test');
    expect(body.accessDiscovery.status).toBe('oa_candidate');
    expect(body.pdfUrl).toBe('https://publisher.example/paper.pdf');
    expect(access.enrich).toHaveBeenCalledWith(
      [expect.objectContaining({ doi: '10.1000/test' })],
      { verifyPdf: false }
    );
  });

  it('rejects arbitrary URLs before DOI access discovery dispatch', async () => {
    const access = { enrich: jest.fn() };
    await expect(handleToolCall(
      'discover_paper_access',
      { doi: 'https://publisher.example/article' },
      makeSearchers({ publicAccess: access }) as any
    )).rejects.toThrow(/DOI/i);
    expect(access.enrich).not.toHaveBeenCalled();
  });

  it('keeps sanitized JSON responses parseable when paper text contains escapes', async () => {
    const paper = PaperFactory.create({
      paperId: 'paper-1',
      title: 'Basic "concept" with \\slashes',
      source: 'arxiv',
      url: 'https://example.com/?token=secret-token',
      extra: {
        title: 'Basic "inner" with \\slashes',
        authors: ['Alice', 'Bob'],
        identifier: '1234567890abcdef1234567890abcdef12345678',
        authorization: 'Bearer extra-secret'
      }
    });
    const arxiv = makeSearcher();
    arxiv.search = jest.fn(async () => [paper]);
    const response = await handleToolCall('search_papers', { query: 'test', platform: 'arxiv' }, makeSearchers({ arxiv }) as any);
    const body = JSON.parse(response.content[0].text.slice(response.content[0].text.indexOf('\n\n') + 2));
    expect(body[0].title).toBe('Basic "concept" with \\slashes');
    expect(body[0].url).not.toContain('secret-token');
    const extra = JSON.parse(body[0].extra);
    expect(extra.title).toBe('Basic "inner" with \\slashes');
    expect(extra.authors).toEqual(['Alice', 'Bob']);
    expect(extra.identifier).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(extra.authorization).toBe('***REDACTED***');
  });

  it('keeps MCP citation metadata typed while redacting genuine credentials', async () => {
    const lookup = jest.spyOn(CitationService.prototype, 'getCitationDataByDoi').mockResolvedValue({
      paperId: '1234567890abcdef1234567890abcdef12345678',
      title: 'Basic "concept" with \\slashes',
      citationCount: 3,
      referenceCount: 2,
      year: 2024,
      venue: 'Journal',
      doi: '10.1000/test',
      url: 'https://example.com/article?session=session-secret',
      authors: [{ name: 'Alice "A"', authorId: 'author\\1' }]
    });
    try {
      const response = await handleToolCall('get_citations', { doi: '10.1000/test' }, makeSearchers() as any);
      const body = JSON.parse(response.content[0].text.slice(response.content[0].text.indexOf('\n\n') + 2));
      expect(body.paper_id).toBe('1234567890abcdef1234567890abcdef12345678');
      expect(body.doi).toBe('10.1000/test');
      expect(body.title).toBe('Basic "concept" with \\slashes');
      expect(body.authors).toEqual(['Alice "A" (author\\1)']);
      expect(Array.isArray(body.authors)).toBe(true);
      expect(typeof body.citation_count).toBe('number');
      expect(body.url).not.toContain('session-secret');
    } finally {
      lookup.mockRestore();
    }
  });

  it('does not treat ScrapingAnt as a DOI search platform', async () => {
    const scraperLookup = jest.fn(async () => null);
    const searchers = makeSearchers({ scrapingAnt: { getPaperByDoi: scraperLookup } }) as any;
    await handleToolCall('get_paper_by_doi', { doi: '10.1000/test', platform: 'all' }, searchers);
    expect(scraperLookup).not.toHaveBeenCalled();
  });

  it('uses an injected Scopus searcher without requiring process environment keys', async () => {
    const originalElsevierApiKey = process.env.ELSEVIER_API_KEY;
    const originalScopusSearchApiKey = process.env.SCOPUS_SEARCH_API_KEY;
    delete process.env.ELSEVIER_API_KEY;
    delete process.env.SCOPUS_SEARCH_API_KEY;

    try {
      const scopus = makeSearcher();
      scopus.search = jest.fn(async () => []);
      const response = await handleToolCall(
        'search_scopus',
        { query: 'machine learning', maxResults: 1 },
        makeSearchers({ scopus }) as any
      );

      expect(scopus.search).toHaveBeenCalledWith(
        'machine learning',
        expect.objectContaining({ maxResults: 1 })
      );
      expect(response.content[0].text).toContain('Found 0 Scopus papers');
    } finally {
      if (originalElsevierApiKey === undefined) delete process.env.ELSEVIER_API_KEY;
      else process.env.ELSEVIER_API_KEY = originalElsevierApiKey;
      if (originalScopusSearchApiKey === undefined) delete process.env.SCOPUS_SEARCH_API_KEY;
      else process.env.SCOPUS_SEARCH_API_KEY = originalScopusSearchApiKey;
    }
  });

  it('serializes related WoS papers through the unified Paper dictionary', async () => {
    const paper = PaperFactory.create({ paperId: 'WOS:2', title: 'Related', source: 'webofscience' });
    const searchers = makeSearchers({
      webofscience: { getRelatedRecords: jest.fn(async () => ({ queryResult: { queryId: '1' }, items: [paper] })) }
    }) as any;
    const response = await handleToolCall('get_webofscience_related_records', { uid: 'WOS:1', relation: 'citing' }, searchers);
    const body = JSON.parse(response.content[0].text);
    expect(body.items[0].paper_id).toBe('WOS:2');
  });

  it('preserves Web of Science API key status metadata in platform status', async () => {
    const status = {
      starter: { apiKeyStatus: 'valid' },
      expanded: { apiKeyStatus: 'configured' },
      scrapingAnt: { configured: false }
    };
    const searchers = {
      webofscience: {
        getStatus: jest.fn(async () => status),
        getBaseUrl: jest.fn(() => 'https://api.clarivate.com/apis/wos-starter/v2'),
        getCapabilities: jest.fn(() => ({ search: true })),
        getScrapingAntStatus: jest.fn(() => ({ configured: false }))
      },
      scrapingAnt: { getStatus: jest.fn(() => ({ configured: false })) }
    } as any;
    const response = await handleToolCall('get_platform_status', { validate: false }, searchers);
    const body = JSON.parse(response.content[0].text.slice(response.content[0].text.indexOf('\n\n') + 2));
    const wos = body.find((entry: any) => entry.platform === 'webofscience');
    expect(wos.apiKeyStatus).toBe('valid');
    expect(wos.starter.apiKeyStatus).toBe('valid');
    expect(wos.expanded.apiKeyStatus).toBe('configured');
  });

  it('includes the controlled Sci-Hub compliance notice once per enabled searcher', async () => {
    const paper = PaperFactory.create({ paperId: '10.1000/test', title: 'Paper', source: 'scihub' });
    const searchers = makeSearchers({
      scihub: {
        search: jest.fn(async () => [paper]),
        consumeComplianceNotice: jest.fn(() => 'Compliance notice')
      }
    }) as any;
    const response = await handleToolCall('search_scihub', { doiOrUrl: '10.1000/test' }, searchers);
    expect(response.content[0].text).toContain('Compliance notice');
  });
});