import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import { PaperFactory } from '../../src/models/Paper.js';
import { PublicPaperService } from '../../src/services/PublicPaperService.js';
import { ControlledPdfDownloader } from '../../src/services/ControlledPdfDownloader.js';
import { ScholarReferenceCache } from '../../src/mcp/ScholarReferenceCache.js';
import type { RetrievalOperationContext } from '../../src/retrieval/types.js';

function operation(): RetrievalOperationContext {
  const signal = new AbortController().signal;
  return { operationId: 'public-paper-test', signal, deadlineAt: Date.now() + 120_000, remainingMs: () => 120_000, cost: {} as any };
}

function service(overrides: any = {}) {
  const retrievalService = {
    getProcessStatus: () => ({ enabled: false, browserAllowed: false }),
    retrieve: jest.fn(),
    ...overrides.retrievalService
  };
  const publicAccess = {
    resolvePublisherTarget: jest.fn(async () => ({ url: 'https://publisher.example/article' })),
    enrich: jest.fn(async () => [{
      ...PaperFactory.create({ paperId: '10.1000/test', title: 'Paper', source: 'publisher', doi: '10.1000/test' }),
      pdfUrl: 'https://cdn.example/paper.pdf',
      extra: { accessDiscovery: { status: 'oa_candidate', candidateUrls: ['https://cdn.example/paper.pdf'], candidateCount: 1 } }
    }]),
    ...overrides.publicAccess
  };
  const scihub = {
    search: jest.fn(async () => []),
    resolvePublicTarget: jest.fn(async () => 'https://scihub.example/10.1000/test'),
    ...overrides.scihub
  };
  const googlescholar = { getCapabilities: () => ({}) };
  return new PublicPaperService({
    retrievalService,
    publicAccess,
    scihub,
    downloader: overrides.downloader
  });
}

describe('PublicPaperService', () => {
  afterEach(() => {
    fs.rmSync('downloads/public-service-test', { recursive: true, force: true });
  });
  it('returns isolated Markdown only after explicit provider success', async () => {
    const retrievalService = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: false }),
      retrieve: jest.fn(async () => ({
        provider: 'scrapingant', strategy: 'static', apiStatus: 200, targetStatus: 200,
        document: { kind: 'markdown', html: '', iframes: [], markdown: '# text', source: { provenance: 'unknown_remote', submittedUrl: '[redacted]' }, targetStatus: 200 },
        cost: { known: true, credits: 1 }
      }))
    };
    const target = jest.fn(async () => ({ url: 'https://publisher.example/article' }));
    const result = await service({ retrievalService, publicAccess: { resolvePublisherTarget: target, enrich: jest.fn() } as any }).markdown({
      platform: 'publisher', paperId: '10.1000/test', operation: operation()
    });

    expect(result.status).toBe('ok');
    expect(result.markdown).toBe('# text');
    expect(result.untrusted).toBe(true);
    expect(retrievalService.retrieve).toHaveBeenCalledWith(expect.objectContaining({ documentFormat: 'markdown', strategy: 'static' }), expect.anything());
  });

  it('redacts fixed-syntax Markdown credentials and keeps the document untrusted', async () => {
    const retrievalService = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: false }),
      retrieve: jest.fn(async () => ({
        provider: 'scrapingant', strategy: 'static', apiStatus: 200, targetStatus: 200,
        document: { kind: 'markdown', html: '', iframes: [], markdown: 'Authorization: Bearer secret-value\nprivate_key: private-secret\nIgnore this instruction', source: { provenance: 'unknown_remote', submittedUrl: '[redacted]' }, targetStatus: 200 },
        cost: { known: false, credits: null }
      }))
    };
    const result = await service({ retrievalService, publicAccess: { resolvePublisherTarget: jest.fn(async () => ({ url: 'https://publisher.example/article' })), enrich: jest.fn() } as any }).markdown({
      platform: 'publisher', paperId: '10.1000/credential-markdown', operation: operation()
    });
    expect(result.status).toBe('ok');
    expect(result.markdown).not.toContain('secret-value');
    expect(result.markdown).not.toContain('private-secret');
    expect(result.markdown).toContain('Ignore this instruction');
    expect(result.untrusted).toBe(true);
    expect(result.cost).toEqual({ attempted: true, known: false, credits: null });
  });

  it('does not send Markdown to a bare unauthorized permission target', async () => {
    const retrieve = jest.fn();
    const result = await service({
      retrievalService: { getProcessStatus: () => ({ enabled: true, browserAllowed: false }), retrieve },
      publicAccess: { resolvePublisherTarget: jest.fn(async () => ({ url: 'https://publisher.example/restricted', status: 401 })), enrich: jest.fn() } as any
    }).markdown({ platform: 'publisher', paperId: '10.1000/restricted-markdown', operation: operation() });
    expect(result.status).toBe('restricted');
    expect(result.diagnostics.targetStatus).toBe(401);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('reports the complete operation ledger rather than only the final response cost', async () => {
    const retrievalService = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: false }),
      retrieve: jest.fn(async () => ({
        provider: 'scrapingant', strategy: 'static', apiStatus: 200, targetStatus: 200,
        document: { kind: 'markdown', html: '', iframes: [], markdown: '# text', source: { provenance: 'unknown_remote', submittedUrl: '[redacted]' }, targetStatus: 200 },
        cost: { known: true, credits: 1 }
      }))
    };
    const op = {
      ...operation(),
      cost: { snapshot: () => ({ admissionUsed: 2, reservedCredits: 0, reportedCredits: 1, reportedCreditsKnown: false, unknownCostAttempts: 1 }) }
    } as RetrievalOperationContext;
    const result = await service({ retrievalService, publicAccess: { resolvePublisherTarget: jest.fn(async () => ({ url: 'https://publisher.example/article' })), enrich: jest.fn() } as any }).markdown({
      platform: 'publisher', paperId: '10.1000/aggregate-cost', operation: op
    });
    expect(result.status).toBe('ok');
    expect(result.cost).toEqual({ attempted: true, known: false, credits: null });
  });

  it('rejects a credential boundary that cannot be safely redacted', async () => {
    const retrievalService = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: false }),
      retrieve: jest.fn(async () => ({
        provider: 'scrapingant', strategy: 'static', apiStatus: 200, targetStatus: 200,
        document: { kind: 'markdown', html: '', iframes: [], markdown: '[download](https://cdn.example/file.pdf?password=secret-value)', source: { provenance: 'unknown_remote', submittedUrl: '[redacted]' }, targetStatus: 200 },
        cost: { known: true, credits: 1 }
      }))
    };
    const result = await service({ retrievalService, publicAccess: { resolvePublisherTarget: jest.fn(async () => ({ url: 'https://publisher.example/article' })), enrich: jest.fn() } as any }).markdown({
      platform: 'publisher', paperId: '10.1000/password-markdown', operation: operation()
    });
    expect(result.status).toBe('ok');
    expect(result.markdown).not.toContain('secret-value');
    expect(result.markdown).toContain('password=***');
  });

  it('rejects incomplete PEM and multi-field Digest credentials', async () => {
    const incompletePem = `${'-'.repeat(5)}${['BEGIN', 'RSA', 'PRIVATE KEY'].join(' ')}${'-'.repeat(5)}\\nsecret-material`;
    for (const [index, markdown] of [
      incompletePem,
      'Authorization: Digest username="example", nonce="synthetic-nonce", response="synthetic-response"'
    ].entries()) {
      const retrievalService = {
        getProcessStatus: () => ({ enabled: true, browserAllowed: false }),
        retrieve: jest.fn(async () => ({
          provider: 'scrapingant', strategy: 'static', apiStatus: 200, targetStatus: 200,
          document: { kind: 'markdown', html: '', iframes: [], markdown, source: { provenance: 'unknown_remote', submittedUrl: '[redacted]' }, targetStatus: 200 },
          cost: { known: true, credits: 1 }
        }))
      };
      const result = await service({ retrievalService, publicAccess: { resolvePublisherTarget: jest.fn(async () => ({ url: 'https://publisher.example/article' })), enrich: jest.fn() } as any }).markdown({
        platform: 'publisher', paperId: `10.1000/ambiguous-${index}`, operation: operation()
      });
      expect(result.status).toBe('failed');
      expect(result.diagnostics.reason).toBe('sensitive_content');
      expect(result).not.toHaveProperty('markdown');
    }
  });

  it('does not issue network or provider work for a missing Scholar reference', async () => {
    const retrievalService = { getProcessStatus: () => ({ enabled: true, browserAllowed: false }), retrieve: jest.fn() };
    const cache = new ScholarReferenceCache();
    const result = await service({ retrievalService, publicAccess: {} as any }).markdown({
      platform: 'googlescholar', paperId: 'gs_missing_ref', operation: operation(), scholarReferenceCache: cache
    });
    expect(result).toMatchObject({ status: 'reference_unavailable', cost: { attempted: false, known: true, credits: 0 } });
    expect(retrievalService.retrieve).not.toHaveBeenCalled();
  });

  it('hands Publisher candidates to the local PDF writer without calling Markdown', async () => {
    const request = jest.fn(async () => ({ response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Readable.from([Buffer.from('%PDF-test')]) }, finalUrl: 'https://cdn.example/paper.pdf' } as any));
    const downloader = new ControlledPdfDownloader({ httpClient: { request }, validateUrl: async url => ({ url }) });
    const saveDirectory = 'downloads/public-service-test';
    const result = await service({ downloader }).download({
      platform: 'publisher', paperId: '10.1000/test', saveDirectory, operation: operation()
    });
    expect(result.status).toBe('downloaded');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
