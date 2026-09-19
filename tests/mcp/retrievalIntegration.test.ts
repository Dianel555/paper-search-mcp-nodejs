import { describe, expect, it, jest } from '@jest/globals';
import { TOOLS } from '../../src/mcp/tools.js';
import { createCallToolHandler } from '../../src/mcp/callToolHandler.js';
import { handleToolCall } from '../../src/mcp/handleToolCall.js';
import { registerMcpHandlers } from '../../src/mcp/registerHandlers.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RetrievalService } from '../../src/retrieval/RetrievalService.js';
import { DirectHttpProvider } from '../../src/retrieval/DirectHttpProvider.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { PublicAccessDiscovery } from '../../src/services/PublicAccessDiscovery.js';
import { RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';
import { parseRetrievalConfiguration, type RetrievalConfiguration } from '../../src/retrieval/Configuration.js';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalProvider, type RetrievalResponse } from '../../src/retrieval/types.js';
import { SciHubSearcher as BaseSciHubSearcher, type SciHubSearcherOptions } from '../../src/platforms/SciHubSearcher.js';
import { GoogleScholarSearcher } from '../../src/platforms/GoogleScholarSearcher.js';
import { WebOfScienceSearcher } from '../../src/platforms/WebOfScienceSearcher.js';
import { QuotaManager } from '../../src/utils/QuotaManager.js';
import { PaperFactory } from '../../src/models/Paper.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_MIRROR_DIRECTORY_HTML = `
  <main>
    <a href="https://sci-hub.se" target="_blank" title="Visit mirror">Visit mirror</a>
    <a href="https://sci-hub.st" target="_blank" title="Visit mirror">Visit mirror</a>
    <a href="https://sci-hub.ru" target="_blank" title="Visit mirror">Visit mirror</a>
    <a href="https://sci-hub.red" target="_blank" title="Visit mirror">Visit mirror</a>
  </main>`;
const TEST_OOOPN_DIRECTORY_HTML = `
  <table class="scholar-table"><tbody>
    <tr><td class="url-cell"><a href="https://sci-hub.box">https://sci-hub.box</a></td></tr>
  </tbody></table>`;

function mirrorDiscoveryRequest() {
  return {
    request: jest.fn(async (url: string) => ({
      response: {
        status: 200,
        headers: {},
        data: url.includes('ooopn.com') ? TEST_OOOPN_DIRECTORY_HTML : TEST_MIRROR_DIRECTORY_HTML
      },
      finalUrl: url
    } as any))
  };
}

class SciHubSearcher extends BaseSciHubSearcher {
  constructor(options: SciHubSearcherOptions = {}) {
    super({ mirrorDiscoveryHttpClient: mirrorDiscoveryRequest(), ...options });
  }
}

function makeOperation(signal: AbortSignal, id: string): RetrievalOperationContext & { dispose: jest.Mock } {
  return {
    operationId: id,
    signal,
    deadlineAt: Date.now() + 120_000,
    remainingMs: () => 120_000,
    cost: {} as any,
    dispose: jest.fn()
  };
}

function paidConfiguration(maxCreditsPerOperation: number, browserAllowed = false): RetrievalConfiguration {
  const base = parseRetrievalConfiguration({} as NodeJS.ProcessEnv);
  return {
    ...base,
    scrapingAnt: {
      ...base.scrapingAnt,
      apiKey: 'integration-test-key',
      configured: true,
      enabled: true,
      paidEnabled: true,
      browserAllowed,
      maxCreditsPerOperation,
      maxCreditsPerRequest: 10
    }
  };
}

function integrationSecurityPolicy(): OutboundSecurityPolicy {
  return new OutboundSecurityPolicy({
    validatePublicUrl: async url => ({
      url,
      hostname: new URL(url).hostname,
      addresses: [{ address: '93.184.216.34', family: 4 as const }]
    })
  });
}

function integrationRateLimiter() {
  return {
    waitForPermission: jest.fn(async () => undefined),
    getStatus: jest.fn(() => ({ availableTokens: 1, maxTokens: 1, requestsPerSecond: 1, pendingRequests: 0 }))
  };
}

function registeredCallHandler(searchers: any): (...args: any[]) => Promise<any> {
  const handlers = new Map<unknown, (...args: any[]) => Promise<any>>();
  const server = {
    setRequestHandler: jest.fn((schema: unknown, handler: (...args: any[]) => Promise<any>) => {
      handlers.set(schema, handler);
    })
  } as any;
  registerMcpHandlers(server, () => searchers);
  return handlers.get(CallToolRequestSchema)!;
}

// Jest evaluates the fixture in one realm while structuredClone() returns objects from another;
// restore the fixture realm prototypes so toStrictEqual checks the actual graph, not realm identity.
function structuredCloneInCurrentRealm<T>(value: T): T {
  const clone = structuredClone(value);
  return restoreClonePrototypes(value, clone) as T;
}

function restoreClonePrototypes(source: any, clone: any): any {
  if (!source || !clone || typeof source !== 'object' || typeof clone !== 'object') return clone;
  Object.setPrototypeOf(clone, Object.getPrototypeOf(source));
  for (const key of Reflect.ownKeys(source)) {
    if (Object.prototype.hasOwnProperty.call(clone, key)) restoreClonePrototypes(source[key], clone[key]);
  }
  return clone;
}

function makeSearchers(factory: { createOperation: (...args: any[]) => any; enrich?: (...args: any[]) => any } = {
  createOperation: () => undefined
}) {
  const enrich = factory.enrich || jest.fn(async (papers: any[]) => papers);
  const noOpSearcher = {
    getCapabilities: () => ({ search: true, download: false, fullText: false, citations: false, requiresApiKey: false, supportedOptions: [] }),
    hasApiKey: () => false,
    getBaseUrl: () => 'https://example.test',
    search: jest.fn(async () => []),
    downloadPdf: jest.fn(async () => ''),
    getPaperByDoi: jest.fn(async () => null),
    getRateLimiterStatus: () => ({ availableTokens: 1, maxTokens: 1 }),
    getStatus: jest.fn(async () => ({})),
    validateApiKey: jest.fn(async () => true),
    consumeComplianceNotice: jest.fn(() => undefined),
    forceHealthCheck: jest.fn(async () => undefined),
    getMirrorStatus: jest.fn(() => [])
  };
  const wos = {
    ...noOpSearcher,
    getStatus: jest.fn(async () => ({ starter: { apiKeyStatus: 'missing' }, expanded: { apiKeyStatus: 'missing' }, scrapingAnt: { configured: false } })),
    getScrapingAntStatus: jest.fn(() => ({ configured: false }))
  };
  return {
    arxiv: noOpSearcher,
    webofscience: wos,
    wos,
    pubmed: noOpSearcher,
    biorxiv: noOpSearcher,
    medrxiv: noOpSearcher,
    semantic: noOpSearcher,
    iacr: noOpSearcher,
    googlescholar: noOpSearcher,
    scholar: noOpSearcher,
    scihub: noOpSearcher,
    sciencedirect: noOpSearcher,
    springer: noOpSearcher,
    wiley: noOpSearcher,
    scopus: noOpSearcher,
    crossref: noOpSearcher,
    publicAccess: { enrich },
    platforms: { arxiv: noOpSearcher, webofscience: wos },
    retrievalService: factory
  } as any;
}

describe('MCP retrieval composition', () => {
  it('registers the tools/list and call handler on the server boundary', () => {
    const handlers = new Map<unknown, (...args: any[]) => Promise<unknown>>();
    const server = {
      setRequestHandler: jest.fn((schema: unknown, handler: (...args: any[]) => Promise<unknown>) => {
        handlers.set(schema, handler);
      })
    } as any;

    registerMcpHandlers(server, () => makeSearchers());

    expect(handlers.get(ListToolsRequestSchema)).toEqual(expect.any(Function));
    expect(handlers.get(CallToolRequestSchema)).toEqual(expect.any(Function));
    expect(server.setRequestHandler).toHaveBeenCalledTimes(4);
  });

  it('keeps the tools/list registry aligned with the public-paper handlers', () => {
    const names = new Set(TOOLS.map(tool => tool.name));
    expect(names.has('discover_paper_access')).toBe(true);
    expect(names.has('download_public_paper')).toBe(true);
    expect(names.has('get_paper_markdown')).toBe(true);
    expect(TOOLS.filter(tool => tool.name === 'download_public_paper')).toHaveLength(1);
    expect(TOOLS.filter(tool => tool.name === 'get_paper_markdown')).toHaveLength(1);
    const download = TOOLS.find(tool => tool.name === 'download_public_paper') as any;
    expect(download.inputSchema.additionalProperties).toBe(false);
    expect(download.inputSchema.properties.platform.enum).toEqual(['publisher', 'googlescholar', 'scihub']);
  });

  it('advertises the exact get_paper_by_doi platform contract through tools/list', async () => {
    const handlers = new Map<unknown, (...args: any[]) => Promise<any>>();
    const server = {
      setRequestHandler: jest.fn((schema: unknown, handler: (...args: any[]) => Promise<any>) => {
        handlers.set(schema, handler);
      })
    } as any;
    registerMcpHandlers(server, () => makeSearchers());

    const listed = await handlers.get(ListToolsRequestSchema)!({});
    const tool = listed.tools.find((entry: any) => entry.name === 'get_paper_by_doi');

    expect(tool?.inputSchema.properties.platform.enum).toEqual([
      'arxiv',
      'webofscience',
      'scihub',
      'all'
    ]);
  });

  it('routes registered DOI calls and keeps all fan-out on the canonical business registry', async () => {
    const operations: Array<RetrievalOperationContext & { dispose: jest.Mock }> = [];
    const service = {
      createOperation: jest.fn(({ signal }: { signal: AbortSignal }) => {
        const operation = makeOperation(signal, `doi-operation-${operations.length + 1}`);
        operations.push(operation);
        return operation;
      })
    };
    const base = makeSearchers(service) as any;
    const platformNames = ['arxiv', 'webofscience', 'pubmed', 'scihub', 'crossref'];
    const lookups = new Map<string, jest.Mock>();
    const platformRegistry: Record<string, any> = {};
    for (const platformName of platformNames) {
      const searcher = {
        ...base.arxiv,
        getPaperByDoi: jest.fn(async () => null)
      };
      lookups.set(platformName, searcher.getPaperByDoi);
      platformRegistry[platformName] = searcher;
      (base as any)[platformName] = searcher;
    }
    base.platforms = platformRegistry;
    const handler = registeredCallHandler(base);
    const signal = new AbortController().signal;
    const call = (platform?: string) => handler(
      { params: {
        name: 'get_paper_by_doi',
        arguments: platform === undefined
          ? { doi: 'doi:10.1000/Canonical' }
          : { doi: 'doi:10.1000/Canonical', platform }
      } },
      { signal }
    );

    await call('scihub');
    await call('arxiv');
    await call('webofscience');
    await call('all');
    await call();

    expect(lookups.get('scihub')).toHaveBeenCalledWith(
      '10.1000/Canonical',
      expect.objectContaining({ operationContext: expect.any(Object) })
    );
    expect(lookups.get('arxiv')).toHaveBeenCalledWith(
      '10.1000/Canonical',
      expect.objectContaining({ operationContext: expect.any(Object) })
    );
    expect(lookups.get('webofscience')).toHaveBeenCalledWith(
      '10.1000/Canonical',
      expect.objectContaining({ operationContext: expect.any(Object) })
    );
    expect(lookups.get('scihub')).toHaveBeenCalledTimes(3);
    expect(lookups.get('arxiv')).toHaveBeenCalledTimes(3);
    expect(lookups.get('webofscience')).toHaveBeenCalledTimes(3);
    expect(lookups.get('pubmed')).toHaveBeenCalledTimes(2);
    expect(lookups.get('crossref')).toHaveBeenCalledTimes(2);
    expect(operations).toHaveLength(5);
    expect(operations.every(operation => operation.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('rejects missing Scholar references before creating an operation or searchers', async () => {
    const searcherFactory = jest.fn(() => makeSearchers());
    const handler = createCallToolHandler(searcherFactory);
    const response = await handler(
      { params: { name: 'get_paper_markdown', arguments: { platform: 'googlescholar', paperId: 'gs_missing_ref' } } },
      { signal: new AbortController().signal }
    );
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      status: 'reference_unavailable',
      cost: { attempted: false, known: true, credits: 0 }
    });
    expect(response.isError).toBeUndefined();
    expect(searcherFactory).not.toHaveBeenCalled();
  });

  it('rejects unsupported DOI inputs before creating an operation', async () => {
    const searcherFactory = jest.fn(() => makeSearchers());
    const handler = createCallToolHandler(searcherFactory);
    const signal = new AbortController().signal;

    for (const arguments_ of [
      { doi: '10.1000/test', platform: 'unsupported' },
      { doi: '10.1000/test', platform: 'scrapingant' },
      { doi: '10.1000/test', platform: 42 },
      { platform: 'scihub' }
    ]) {
      const response = await handler(
        { params: { name: 'get_paper_by_doi', arguments: arguments_ } },
        { signal }
      );
      expect(response.isError).toBe(true);
    }
    expect(searcherFactory).not.toHaveBeenCalled();
  });

  it('keeps invalid DOI and disabled Sci-Hub calls at zero transport and download', async () => {
    const base = makeSearchers() as any;
    const lookup = jest.fn(async () => null);
    const download = jest.fn(async () => 'unexpected.pdf');
    base.scihub = {
      ...base.scihub,
      getPaperByDoi: lookup,
      downloadPdf: download
    };
    await expect(handleToolCall(
      'get_paper_by_doi',
      { doi: 'not-a-doi', platform: 'scihub' },
      base
    )).rejects.toThrow(/DOI/i);
    expect(lookup).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();

    const transport = jest.fn();
    const disabled = new SciHubSearcher({
      enabled: false,
      publicHttpClient: { request: transport } as any,
      downloadHttpClient: { request: transport } as any,
      retrievalService: {
        createOperation: jest.fn(),
        getProcessStatus: jest.fn(() => ({ enabled: false, browserAllowed: false })),
        retrieveWithStrategies: jest.fn()
      } as any
    });
    base.scihub = disabled;
    await expect(handleToolCall(
      'get_paper_by_doi',
      { doi: '10.1000/test', platform: 'scihub' },
      base
    )).rejects.toThrow(/disabled/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('passes the actual request extra.signal into one parent operation and child discovery', async () => {
    const signalController = new AbortController();
    const operation = makeOperation(signalController.signal, 'operation-1');
    const service = { createOperation: jest.fn(() => operation) };
    const enrich = jest.fn(async (papers: any[], options: any) => {
      expect(options.operation).toBe(operation);
      return papers;
    });
    const handlers = new Map<unknown, (...args: any[]) => Promise<any>>();
    const server = {
      setRequestHandler: jest.fn((schema: unknown, handler: (...args: any[]) => Promise<any>) => {
        handlers.set(schema, handler);
      })
    } as any;
    registerMcpHandlers(server, () => makeSearchers({ createOperation: service.createOperation, enrich }));
    const registeredHandler = handlers.get(CallToolRequestSchema)!;

    await registeredHandler(
      { params: { name: 'discover_paper_access', arguments: { doi: '10.1000/test' } } },
      { signal: signalController.signal }
    );

    expect(service.createOperation).toHaveBeenCalledWith({
      signal: signalController.signal,
      purpose: 'publisher_discovery'
    });
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(operation.dispose).toHaveBeenCalledTimes(1);
  });

  it('maps validated tool routes to purpose-specific operation defaults', async () => {
    const purposes: Array<string | undefined> = [];
    const service = {
      createOperation: jest.fn((options: any) => {
        purposes.push(options.purpose);
        return makeOperation(options.signal, `purpose-${purposes.length}`);
      })
    };
    const searchers = makeSearchers(service);
    const handler = createCallToolHandler(() => searchers);
    const signal = new AbortController().signal;

    await handler({ params: { name: 'search_google_scholar', arguments: { query: 'attention', maxResults: 1 } } }, { signal });
    await handler({ params: { name: 'search_papers', arguments: { query: 'attention', platform: 'scholar', maxResults: 1 } } }, { signal });
    await handler({ params: { name: 'discover_paper_access', arguments: { doi: '10.1000/purpose' } } }, { signal });
    await handler({ params: { name: 'search_webofscience', arguments: { query: 'attention', discoverAccess: true, maxResults: 1 } } }, { signal });
    await handler({ params: { name: 'search_scihub', arguments: { doiOrUrl: '10.1000/purpose' } } }, { signal });
    await handler({ params: { name: 'get_paper_by_doi', arguments: { doi: '10.1000/purpose', platform: 'scihub' } } }, { signal });
    await handler({ params: { name: 'search_papers', arguments: { query: 'attention', platform: 'all', maxResults: 1 } } }, { signal });

    expect(purposes).toEqual([
      'scholar_search', 'scholar_search', 'publisher_discovery', 'publisher_discovery',
      'scihub_lookup', 'scihub_lookup', undefined
    ]);
  });

  it('isolates operation signals and ledgers across independent MCP calls', async () => {
    const operations: Array<RetrievalOperationContext & { dispose: jest.Mock }> = [];
    const service = {
      createOperation: jest.fn(({ signal }: { signal: AbortSignal }) => {
        const operation = makeOperation(signal, `operation-${operations.length + 1}`);
        operations.push(operation);
        return operation;
      })
    };
    const enrich = jest.fn(async (papers: any[], options: any) => {
      expect(options.operation).toBe(operations[operations.length - 1]);
      return papers;
    });
    const handler = createCallToolHandler(() => makeSearchers({ createOperation: service.createOperation, enrich }));
    const first = new AbortController();
    const second = new AbortController();

    await handler({ params: { name: 'discover_paper_access', arguments: { doi: '10.1000/first' } } }, { signal: first.signal });
    await handler({ params: { name: 'discover_paper_access', arguments: { doi: '10.1000/second' } } }, { signal: second.signal });

    expect(operations).toHaveLength(2);
    expect(operations[0]).not.toBe(operations[1]);
    expect(operations[0].signal).not.toBe(operations[1].signal);
    expect(operations[0].cost).not.toBe(operations[1].cost);
    expect(operations[0].dispose).toHaveBeenCalledTimes(1);
    expect(operations[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('does not traverse retrieval infrastructure as a business platform', async () => {
    const service = { createOperation: jest.fn(({ signal }: { signal: AbortSignal }) => makeOperation(signal, 'status')) };
    const searchers = makeSearchers(service);
    const response = await createCallToolHandler(() => searchers)(
      { params: { name: 'get_platform_status', arguments: { validate: false } } },
      { signal: new AbortController().signal }
    );
    const body = JSON.parse(response.content[0].text.slice(response.content[0].text.indexOf('\n\n') + 2));

    expect(body.map((entry: any) => entry.platform)).toEqual(expect.arrayContaining(['arxiv', 'webofscience', 'scrapingant']));
    expect(body.some((entry: any) => ['publicAccess', 'retrievalService', 'platforms'].includes(entry.platform))).toBe(false);
    expect(searchers.publicAccess.enrich).not.toHaveBeenCalled();
  });

  it('exposes local retrieval diagnostics without traversing provider secrets', async () => {
    const processStatus = {
      enabled: true,
      browserAllowed: false,
      capabilities: { directHtml: true, scrapingAntHtml: true, iframeDocuments: true, browser: false },
      budgetDefaults: { maxCreditsPerOperation: 50, maxCreditsPerRequest: 10 },
      observationScope: 'process',
      requestCount: 2,
      reportedCredits: 1,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      lastRequestCredits: 1,
      lastStrategy: 'static',
      lastTargetStatus: 200
    };
    const service = {
      createOperation: jest.fn(({ signal }: { signal: AbortSignal }) => makeOperation(signal, 'diagnostics')),
      getProcessStatus: jest.fn(() => processStatus)
    };
    const wos = {
      getStatus: jest.fn(async () => ({
        starter: { apiKeyStatus: 'configured' },
        expanded: { apiKeyStatus: 'missing' },
        scrapingAnt: processStatus
      })),
      getBaseUrl: jest.fn(() => 'https://api.clarivate.com/apis/wos-starter/v2'),
      getCapabilities: jest.fn(() => ({ search: true })),
      getScrapingAntStatus: service.getProcessStatus
    };
    const searchers = {
      ...makeSearchers(service),
      webofscience: wos,
      wos,
      platforms: { arxiv: makeSearchers(service).arxiv, webofscience: wos },
      retrievalService: service
    } as any;
    const response = await createCallToolHandler(() => searchers)(
      { params: { name: 'get_platform_status', arguments: { validate: false } } },
      { signal: new AbortController().signal }
    );
    const body = JSON.parse(response.content[0].text.slice(response.content[0].text.indexOf('\n\n') + 2));
    const arxiv = body.find((entry: any) => entry.platform === 'arxiv');
    const scrapingAnt = body.find((entry: any) => entry.platform === 'scrapingant');

    expect(arxiv.capabilities.requiresApiKey).toBe(false);
    expect(scrapingAnt.budgetDefaults).toEqual({ maxCreditsPerOperation: 50, maxCreditsPerRequest: 10 });
    expect(scrapingAnt.requestCount).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/test-key|cookie|authorization/i);
    expect(service.getProcessStatus).toHaveBeenCalledTimes(1);
  });

  it('runs DOI discovery through the real direct provider without paid fallback', async () => {
    const request = jest.fn(async (config: any) => {
      if (String(config.url).startsWith('https://doi.org/')) {
        return {
          status: 302,
          headers: { location: 'https://publisher.example/article' },
          data: ''
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<html><a href="https://publisher.example/paper.pdf">PDF</a></html>'
      };
    });
    const publicHttpClient = new PublicHttpClient({
      client: { request } as any,
      purpose: 'publisher_discovery',
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const service = new RetrievalService({
      directProvider: new DirectHttpProvider({ publicHttpClient }),
      costPolicy: new RetrievalCostPolicy({ enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({
        validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      })
    });
    const publicAccess = new PublicAccessDiscovery(undefined, {
      publicHttpClient,
      retrievalService: service,
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const searchers = {
      ...makeSearchers({ createOperation: jest.fn() }),
      publicAccess,
      retrievalService: service
    } as any;
    const response = await createCallToolHandler(() => searchers)(
      { params: { name: 'discover_paper_access', arguments: { doi: 'doi:10.1000/test' } } },
      { signal: new AbortController().signal }
    );
    const body = JSON.parse(response.content[0].text);

    expect(body.doi).toBe('10.1000/test');
    expect(body.accessDiscovery.status).toBe('oa_candidate');
    expect(body.pdfUrl).toBe('https://publisher.example/paper.pdf');
    expect(request).toHaveBeenCalledTimes(3);
    expect(service.getProcessStatus().requestCount).toBe(1);
  });

  it('enriches multiple DOI items on one real discovery operation', async () => {
    const contexts: RetrievalOperationContext[] = [];
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (_request: any, context: RetrievalOperationContext) => {
        contexts.push(context);
        return {
          provider: 'direct',
          strategy: 'direct',
          targetStatus: 200,
          document: {
            kind: 'html',
            html: '<html><title>No public copy</title></html>',
            iframes: [],
            source: { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/article' },
            targetStatus: 200
          },
          cost: { known: true, credits: 0 }
        } satisfies RetrievalResponse;
      })
    };
    const service = new RetrievalService({
      directProvider,
      costPolicy: new RetrievalCostPolicy({ enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({
        validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      })
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: {
        request: async (config: any) => String(config.url).includes('doi.org')
          ? { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined }
          : { status: 200, headers: {}, data: '' }
      },
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const operation = service.createOperation();
    const papers = [
      PaperFactory.create({ paperId: 'one', title: 'One', source: 'test', doi: '10.1000/one' }),
      PaperFactory.create({ paperId: 'two', title: 'Two', source: 'test', doi: '10.1000/two' }),
      PaperFactory.create({ paperId: 'three', title: 'Three', source: 'test', doi: '10.1000/three' })
    ];
    try {
      const enriched = await discovery.enrich(papers, { operation, maxItems: 2 });
      expect(enriched).toHaveLength(3);
      expect(directProvider.retrieve).toHaveBeenCalledTimes(2);
      expect(new Set(contexts)).toEqual(new Set([operation]));
      expect(enriched[2].extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'skipped',
        reason: 'discovery_limit'
      }));
    } finally {
      operation.dispose();
    }
  });

  it('contends for one paid budget across actual multi-DOI discovery consumers', async () => {
    const directContexts: RetrievalOperationContext[] = [];
    const paidContexts: RetrievalOperationContext[] = [];
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
        directContexts.push(context);
        return {
          provider: 'direct',
          strategy: 'direct',
          targetStatus: 200,
          document: {
            kind: 'html',
            html: '<div id="pdf"></div><script src="/viewer.js"></script>',
            iframes: [],
            source: { provenance: 'trusted_direct', finalUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: 0 }
        } satisfies RetrievalResponse;
      })
    };
    const paidProvider: RetrievalProvider = {
      name: 'scrapingant',
      capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
      retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
        paidContexts.push(context);
        return {
          provider: 'scrapingant',
          strategy: 'static',
          apiStatus: 200,
          targetStatus: 200,
          document: {
            kind: 'html',
            html: '<a href="https://publisher.example/paid.pdf">PDF</a>',
            iframes: [],
            source: { provenance: 'unknown_remote', submittedUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: 1 }
        } satisfies RetrievalResponse;
      })
    };
    const service = new RetrievalService({
      directProvider,
      scrapingAntProvider: paidProvider,
      configuration: paidConfiguration(1),
      costPolicy: new RetrievalCostPolicy({ budget: 1, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy(),
      maxConcurrency: 2
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: {
        request: jest.fn(async (config: any) => String(config.url).includes('doi.org')
          ? { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined }
          : { status: 200, headers: {}, data: '' })
      },
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const operation = service.createOperation();
    const papers = [
      PaperFactory.create({ paperId: 'budget-one', title: 'One', source: 'test', doi: '10.1000/budget-one' }),
      PaperFactory.create({ paperId: 'budget-two', title: 'Two', source: 'test', doi: '10.1000/budget-two' })
    ];
    try {
      const enriched = await discovery.enrich(papers, { operation, maxItems: 2 });
      const statuses = enriched.map(paper => paper.extra?.accessDiscovery?.status);
      expect(statuses.filter(status => status === 'oa_candidate')).toHaveLength(1);
      expect(statuses.filter(status => status === 'skipped')).toHaveLength(1);
      expect(enriched.every(paper => paper.doi)).toBe(true);
      expect(directContexts).toHaveLength(2);
      expect(new Set(directContexts)).toEqual(new Set([operation]));
      expect(paidContexts).toHaveLength(1);
      expect(paidContexts[0]).toBe(operation);
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 3,
        strategyCounts: { direct: 2, static: 1, browser: 0 },
        admissionUsed: 1,
        reportedCredits: 1
      }));
    } finally {
      operation.dispose();
    }
  });

  it('replays R6 unknown-cost candidate closure through the registered WoS callback', async () => {
    const direct = jest.fn(async (request: any) => ({
      provider: 'direct',
      strategy: 'direct',
      targetStatus: 200,
      document: {
        kind: 'html',
        html: '<div id="pdf"></div><script src="/viewer.js"></script>',
        iframes: [],
        source: { provenance: 'trusted_direct', finalUrl: request.url },
        targetStatus: 200
      },
      cost: { known: true, credits: 0 }
    } satisfies RetrievalResponse));
    const paid = jest.fn(async () => ({
      provider: 'scrapingant',
      strategy: 'static',
      apiStatus: 200,
      targetStatus: 200,
      document: {
        kind: 'html',
        html: '<a href="https://publisher.example/unknown-cost.pdf">PDF</a>',
        iframes: [],
        source: { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/article' },
        targetStatus: 200
      },
      cost: { known: false as const, credits: null, reason: 'missing_billing_header' }
    } satisfies RetrievalResponse));
    const service = new RetrievalService({
      directProvider: {
        name: 'direct',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
        retrieve: direct
      },
      scrapingAntProvider: {
        name: 'scrapingant',
        capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
        retrieve: paid
      },
      configuration: paidConfiguration(1),
      costPolicy: new RetrievalCostPolicy({ budget: 1, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: {
        request: jest.fn(async (config: any) => String(config.url).includes('doi.org')
          ? { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined }
          : { status: 200, headers: {}, data: undefined })
      },
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const papers = [
      PaperFactory.create({ paperId: 'r6-one', title: 'One', source: 'wos', doi: '10.1000/r6-one' }),
      PaperFactory.create({ paperId: 'r6-two', title: 'Two', source: 'wos', doi: '10.1000/r6-two' })
    ];
    const baseSearchers = makeSearchers(service);
    const webofscience = {
      ...baseSearchers.webofscience,
      search: jest.fn(async (_query: string, options: any) => discovery.enrich(papers, {
        operation: options.operationContext,
        maxItems: 2
      }))
    };
    const searchers = {
      ...baseSearchers,
      webofscience,
      wos: webofscience,
      platforms: { ...baseSearchers.platforms, webofscience },
      retrievalService: service
    } as any;
    const handler = registeredCallHandler(searchers);
    const createOperation = jest.spyOn(service, 'createOperation');

    const result = await handler(
      { params: { name: 'search_webofscience', arguments: {
        query: 'r6',
        maxResults: 2,
        discoverAccess: true,
        discoverAccessMaxItems: 2
      } } },
      { signal: new AbortController().signal }
    );
    const body = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('\n\n') + 2));
    const operation = createOperation.mock.results[0].value as RetrievalOperationContext;
    const extras = body.map((paper: any) => JSON.parse(paper.extra));

    expect(result.isError).toBeUndefined();
    expect(extras.map((extra: any) => extra.accessDiscovery?.status)).toEqual(['oa_candidate', 'skipped']);
    expect(body[0].pdf_url).toBe('https://publisher.example/unknown-cost.pdf');
    expect(paid).toHaveBeenCalledTimes(1);
    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      requestCount: 3,
      admissionUsed: 1,
      unknownCostAttempts: 1,
      paidClosed: true,
      paidClosedReason: 'operation_budget_exceeded',
      reportedCreditsKnown: false
    }));
    expect(operation.signal.aborted).toBe(true);
  });

  it('continues a spare-budget unknown-cost paid lookup through real MCP discovery', async () => {
    let paidAttempts = 0;
    const direct = jest.fn(async (request: any) => ({
      provider: 'direct',
      strategy: 'direct',
      targetStatus: 200,
      document: {
        kind: 'html',
        html: '<div id="pdf"></div><script src="/viewer.js"></script>',
        iframes: [],
        source: { provenance: 'trusted_direct' as const, finalUrl: request.url },
        targetStatus: 200
      },
      cost: { known: true as const, credits: 0 }
    } satisfies RetrievalResponse));
    const paid = jest.fn(async (request: any) => {
      paidAttempts++;
      return {
        provider: 'scrapingant',
        strategy: 'static',
        apiStatus: 200,
        targetStatus: 200,
        document: {
          kind: 'html',
          html: `<a href="https://publisher.example/spare-${paidAttempts}.pdf">PDF</a>`,
          iframes: [],
          source: { provenance: 'unknown_remote' as const, submittedUrl: request.url },
          targetStatus: 200
        },
        cost: paidAttempts === 1
          ? { known: false as const, credits: null, reason: 'missing_billing_header' }
          : { known: true as const, credits: 1 }
      } satisfies RetrievalResponse;
    });
    const configuration = paidConfiguration(2);
    const service = new RetrievalService({
      directProvider: {
        name: 'direct',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
        retrieve: direct
      },
      scrapingAntProvider: {
        name: 'scrapingant',
        capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
        retrieve: paid
      },
      configuration,
      costPolicy: new RetrievalCostPolicy({ budget: 2, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      configuration,
      retrievalService: service,
      publicHttpRequester: {
        request: jest.fn(async (config: any) => String(config.url).includes('doi.org')
          ? { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined }
          : { status: 200, headers: {}, data: undefined })
      },
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const papers = [
      PaperFactory.create({ paperId: 'spare-one', title: 'One', source: 'wos', doi: '10.1000/spare-one' }),
      PaperFactory.create({ paperId: 'spare-two', title: 'Two', source: 'wos', doi: '10.1000/spare-two' })
    ];
    const baseSearchers = makeSearchers(service);
    const webofscience = {
      ...baseSearchers.webofscience,
      search: jest.fn(async (_query: string, options: any) => discovery.enrich(papers, {
        operation: options.operationContext,
        maxItems: 2
      }))
    };
    const searchers = {
      ...baseSearchers,
      webofscience,
      wos: webofscience,
      platforms: { ...baseSearchers.platforms, webofscience },
      retrievalService: service
    } as any;
    const handler = registeredCallHandler(searchers);
    const createOperation = jest.spyOn(service, 'createOperation');

    const result = await handler(
      { params: { name: 'search_webofscience', arguments: {
        query: 'spare-budget',
        maxResults: 2,
        discoverAccess: true,
        discoverAccessMaxItems: 2
      } } },
      { signal: new AbortController().signal }
    );
    const body = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('\n\n') + 2));
    const operation = createOperation.mock.results[0].value as RetrievalOperationContext;
    const extras = body.map((paper: any) => JSON.parse(paper.extra));

    expect(result.isError).toBeUndefined();
    expect(extras.map((extra: any) => extra.accessDiscovery?.status)).toEqual(['oa_candidate', 'oa_candidate']);
    expect(body.map((paper: any) => paper.pdf_url)).toEqual([
      'https://publisher.example/spare-1.pdf',
      'https://publisher.example/spare-2.pdf'
    ]);
    expect(direct).toHaveBeenCalledTimes(2);
    expect(paid).toHaveBeenCalledTimes(2);
    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      requestCount: 4,
      strategyCounts: { direct: 2, static: 2, browser: 0 },
      admissionUsed: 2,
      reportedCredits: 1,
      reportedCreditsKnown: false,
      unknownCostAttempts: 1,
      paidClosed: false
    }));
  });

  it.each([
    ['known target status', 200],
    ['unknown target status', undefined]
  ] as Array<[string, number | undefined]>)('replays R7 candidate truncation without closing another eligible lookup through the registered WoS callback (%s)', async (_label, targetStatus) => {
    const rejectedCandidates = Array.from({ length: 21 }, (_value, index) => `<a href="https://publisher.example/rejected-${index}.pdf">Rejected</a>`).join('');
    const validatedUrls: string[] = [];
    const validateUrl = async (url: string) => {
      validatedUrls.push(url);
      if (/\/rejected-\d+\.pdf$/i.test(url)) throw new Error('rejected candidate fixture');
      return {
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      };
    };
    const direct = jest.fn() as jest.MockedFunction<RetrievalProvider['retrieve']>;
    direct
      .mockResolvedValueOnce({
        provider: 'direct',
        strategy: 'direct',
        ...(targetStatus === undefined ? {} : { targetStatus }),
        document: {
          kind: 'html',
          html: `${rejectedCandidates}<div id="pdf"></div><script src="/viewer.js"></script>`,
          iframes: [],
          source: { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/article' },
          ...(targetStatus === undefined ? {} : { targetStatus })
        },
        cost: { known: true, credits: 0 }
      } satisfies RetrievalResponse)
      .mockResolvedValueOnce({
        provider: 'direct',
        strategy: 'direct',
        targetStatus: 200,
        document: {
          kind: 'html',
          html: '<div id="pdf"></div><script src="/viewer.js"></script>',
          iframes: [],
          source: { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/article' },
          targetStatus: 200
        },
        cost: { known: true, credits: 0 }
      } satisfies RetrievalResponse);
    const paid = jest.fn(async () => ({
      provider: 'scrapingant',
      strategy: 'static',
      apiStatus: 200,
      targetStatus: 200,
      document: {
        kind: 'html',
        html: '<a href="https://publisher.example/eligible.pdf">PDF</a>',
        iframes: [],
        source: { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/article' },
        targetStatus: 200
      },
      cost: { known: true, credits: 1 }
    } satisfies RetrievalResponse));
    const service = new RetrievalService({
      directProvider: {
        name: 'direct',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
        retrieve: direct
      },
      scrapingAntProvider: {
        name: 'scrapingant',
        capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
        retrieve: paid
      },
      configuration: paidConfiguration(10),
      costPolicy: new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: {
        request: jest.fn(async (config: any) => String(config.url).includes('doi.org')
          ? { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined }
          : { status: 200, headers: {}, data: undefined })
      },
      validateUrl
    });
    const papers = [
      PaperFactory.create({ paperId: 'r7-one', title: 'One', source: 'wos', doi: '10.1000/r7-one' }),
      PaperFactory.create({ paperId: 'r7-two', title: 'Two', source: 'wos', doi: '10.1000/r7-two' })
    ];
    const baseSearchers = makeSearchers(service);
    const webofscience = {
      ...baseSearchers.webofscience,
      search: jest.fn(async (_query: string, options: any) => discovery.enrich(papers, {
        operation: options.operationContext,
        maxItems: 2
      }))
    };
    const searchers = {
      ...baseSearchers,
      webofscience,
      wos: webofscience,
      platforms: { ...baseSearchers.platforms, webofscience },
      retrievalService: service
    } as any;
    const handler = registeredCallHandler(searchers);
    const createOperation = jest.spyOn(service, 'createOperation');

    const result = await handler(
      { params: { name: 'search_webofscience', arguments: {
        query: 'r7',
        maxResults: 2,
        discoverAccess: true,
        discoverAccessMaxItems: 2
      } } },
      { signal: new AbortController().signal }
    );
    const body = JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('\n\n') + 2));
    const operation = createOperation.mock.results[0].value as RetrievalOperationContext;
    const extras = body.map((paper: any) => JSON.parse(paper.extra));

    expect(result.isError).toBeUndefined();
    expect(extras.map((extra: any) => extra.accessDiscovery?.status)).toEqual(['skipped', 'oa_candidate']);
    expect(extras[0].accessDiscovery.reason).toBe('candidate_limit');
    expect(extras[0].accessDiscovery.targetStatus).toBe(targetStatus);
    expect(body[1].pdf_url).toBe('https://publisher.example/eligible.pdf');
    expect(paid).toHaveBeenCalledTimes(1);
    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      requestCount: 3,
      admissionUsed: 1,
      reportedCredits: 1,
      paidClosed: false
    }));
    expect(validatedUrls.filter(url => /\/rejected-\d+\.pdf$/i.test(url))).toEqual(
      Array.from({ length: 20 }, (_value, index) => `https://publisher.example/rejected-${index}.pdf`)
    );
    expect(validatedUrls).not.toContain('https://publisher.example/rejected-20.pdf');
    expect(operation.signal.aborted).toBe(true);
  });

  it('keeps one deep enrichment result stable across deadline, late billing, and a sibling operation', async () => {
    jest.useFakeTimers();
    let operation: (RetrievalOperationContext & { dispose?: () => void }) | undefined;
    let lateResolve!: (response: RetrievalResponse) => void;
    let paidStartedResolve!: () => void;
    const paidStarted = new Promise<void>(resolve => { paidStartedResolve = resolve; });
    const latePaid = new Promise<RetrievalResponse>(resolve => { lateResolve = resolve; });
    const paidContexts: RetrievalOperationContext[] = [];
    const paidStrategies: string[] = [];
    const lateResponse = {
      provider: 'scrapingant',
      strategy: 'static',
      apiStatus: 200,
      targetStatus: 200,
      document: {
        kind: 'html',
        html: '<div id="pdf"></div><script src="/viewer.js"></script>',
        iframes: [],
        source: { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/p3-stalled' },
        targetStatus: 200
      },
      cost: { known: true, credits: 1 }
    } satisfies RetrievalResponse;

    try {
      const validateUrl = async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      });
      const publicHttpRequester = {
        request: jest.fn(async (config: any) => {
          const url = String(config.url);
          if (url.includes('doi.org')) {
            const doi = decodeURIComponent(new URL(url).pathname.slice(1));
            const suffix = doi.endsWith('p3-stalled') ? 'stalled' : 'fast';
            return {
              status: 302,
              headers: { location: `https://publisher.example/p3-${suffix}` },
              data: undefined
            };
          }
          if (url.endsWith('.pdf')) {
            return {
              status: 200,
              headers: { 'content-type': 'application/pdf' },
              data: Buffer.from('%PDF-1.7\\n')
            };
          }
          return { status: 200, headers: {}, data: undefined };
        })
      };
      const directProvider: RetrievalProvider = {
        name: 'direct',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
        retrieve: jest.fn(async (request: any) => ({
            provider: 'direct',
            strategy: 'direct',
            targetStatus: 200,
            document: {
              kind: 'html',
              html: request.url.endsWith('/p3-stalled')
                ? '<div id="pdf"></div><script src="/viewer.js"></script>'
                : '<a href="https://publisher.example/p3-fast.pdf">PDF</a>',
              iframes: [],
              source: { provenance: 'trusted_direct', finalUrl: request.url },
              targetStatus: 200
            },
            cost: { known: true, credits: 0 }
          } satisfies RetrievalResponse))
      };
      const paidProvider: RetrievalProvider = {
        name: 'scrapingant',
        capabilities: {
          html: true,
          iframeDocuments: true,
          pdfCandidates: true,
          browser: true,
          paid: true,
          dispatchObservation: true,
          transportSlotManagement: false
        },
        retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
          paidContexts.push(context);
          paidStrategies.push(request.strategy);
          request.dispatchObserver?.onDispatch?.({ role: 'provider_api', origin: 'https://publisher.example', submittedAt: Date.now() });
          paidStartedResolve();
          return paidContexts.length === 1 ? latePaid : lateResponse;
        })
      };
      const service = new RetrievalService({
        directProvider,
        scrapingAntProvider: paidProvider,
        configuration: paidConfiguration(10, true),
        costPolicy: new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true }),
        securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl }),
        operationTimeoutMs: 40
      });
      const discovery = new PublicAccessDiscovery(undefined, {
        retrievalService: service,
        publicHttpRequester,
        validateUrl
      });
      operation = service.createOperation({ operationId: 'p3-primary', timeoutMs: 40 });
      const enrichmentPromise = discovery.enrich([
        PaperFactory.create({ paperId: 'p3-fast', title: 'Fast paper', source: 'integration', doi: '10.1000/p3-fast' }),
        PaperFactory.create({ paperId: 'p3-stalled', title: 'Stalled paper', source: 'integration', doi: '10.1000/p3-stalled' })
      ], { operation, maxItems: 2, verifyPdf: true });

      await paidStarted;
      await jest.advanceTimersByTimeAsync(40);
      const enriched = await enrichmentPromise;
      const returned = {
        papers: enriched,
        diagnostics: service.getOperationDiagnostics(operation),
        process: service.getProcessStatus()
      };
      const detachedBaseline = structuredCloneInCurrentRealm(returned);

      expect(enriched[0].extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'oa_candidate',
        evidence: expect.objectContaining({
          url: 'https://publisher.example/p3-fast.pdf',
          source: expect.objectContaining({ provenance: 'trusted_direct' })
        }),
        verification: expect.objectContaining({ status: 'inconclusive', reason: 'aborted_or_timeout' })
      }));
      expect(enriched[1].extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'not_found',
        reason: 'dynamic_unresolved'
      }));
      expect(service.getOperationDiagnostics(operation)).toEqual(expect.objectContaining({
        requestCount: 3,
        strategyCounts: { direct: 2, static: 1, browser: 0 },
        admissionUsed: 1,
        reportedCredits: 0,
        unknownCostAttempts: 1,
        paidClosed: false,
        reportedCreditsKnown: false
      }));
      expect(returned.diagnostics).toEqual(expect.objectContaining({ unknownCostAttempts: 1 }));
      expect(returned.process).toEqual(expect.objectContaining({
        requestCount: 3,
        browserAllowed: true,
        reportedCredits: 0,
        reportedCreditsKnown: false,
        unknownCostAttempts: 1,
        lastRequestCredits: null
      }));
      expect(paidProvider.retrieve).toHaveBeenCalledTimes(1);
      expect(paidStrategies).toEqual(['static']);
      expect(paidContexts).toHaveLength(1);
      expect(paidContexts[0]).toBe(operation);
      expect(operation.signal.aborted).toBe(true);

      lateResolve(lateResponse);
      await Promise.resolve();
      await Promise.resolve();
      await jest.runAllTimersAsync();
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 3,
        admissionUsed: 1,
        reportedCredits: 1,
        reportedCreditsKnown: true,
        unknownCostAttempts: 0
      }));
      expect(paidStrategies).toEqual(['static']);
      expect(service.getProcessStatus()).toEqual(expect.objectContaining({
        requestCount: 3,
        browserAllowed: true,
        reportedCredits: 1,
        reportedCreditsKnown: true,
        unknownCostAttempts: 0,
        lastRequestCredits: 1
      }));

      let siblingOperation: RetrievalOperationContext | undefined;
      await service.withOperation(async context => {
        siblingOperation = context;
        await service.retrieve({
          url: 'https://publisher.example/p3-sibling',
          purpose: 'publisher_discovery',
          strategy: 'static',
          documentFormat: 'html'
        }, context);
      }, { operationId: 'p3-sibling' });

      expect(paidContexts).toHaveLength(2);
      expect(paidStrategies).toEqual(['static', 'static']);
      expect(paidStrategies.filter(strategy => strategy === 'browser')).toHaveLength(0);
      expect(paidContexts[1]).toBe(siblingOperation);
      expect(paidContexts[1]).not.toBe(operation);
      expect(service.getOperationStatus(siblingOperation!)).toEqual(expect.objectContaining({
        requestCount: 1,
        admissionUsed: 1,
        reportedCredits: 1,
        unknownCostAttempts: 0,
        paidClosed: false
      }));
      expect(service.getProcessStatus()).toEqual(expect.objectContaining({
        requestCount: 4,
        reportedCredits: 2,
        reportedCreditsKnown: true,
        unknownCostAttempts: 0,
        lastRequestCredits: 1
      }));
      expect(paidContexts.filter(context => context === operation)).toHaveLength(1);
      expect(returned).toStrictEqual(detachedBaseline);
    } finally {
      operation?.dispose?.();
      lateResolve?.(lateResponse);
      await Promise.resolve();
      await Promise.resolve();
      jest.useRealTimers();
    }
  });

  it('runs the actual WebOfScienceSearcher consumer through the registered callback', async () => {
    const officialHttp = {
      request: jest.fn(async (_config: any) => ({
        status: 200,
        headers: { 'X-REC-ReqPerSec-Remaining': '49' },
        data: {
          metadata: { total: 3, page: 1, limit: 3 },
          hits: [
            {
              uid: 'WOS:integration-1',
              title: 'Integrated first result',
              types: ['Article'],
              sourceTypes: ['Article'],
              source: { sourceTitle: 'Integration Journal', publishYear: 2024 },
              names: { authors: [{ displayName: 'Author One' }] },
              links: { record: 'https://www.webofscience.com/record/integration-1' },
              citations: [{ db: 'WOS', count: 7 }],
              identifiers: { doi: '10.1000/wos-integration-1' }
            },
            {
              uid: 'WOS:integration-2',
              title: 'Integrated second result',
              types: ['Review'],
              sourceTypes: ['Article'],
              source: { sourceTitle: 'Integration Journal', publishYear: 2023 },
              names: { authors: [{ displayName: 'Author Two' }] },
              links: { record: 'https://www.webofscience.com/record/integration-2' },
              citations: [{ db: 'WOS', count: 3 }],
              identifiers: { doi: '10.1000/wos-integration-2' }
            },
            {
              uid: 'WOS:integration-3',
              title: 'Integrated third result',
              types: ['Article'],
              sourceTypes: ['Article'],
              source: { sourceTitle: 'Integration Journal', publishYear: 2022 },
              names: { authors: [{ displayName: 'Author Three' }] },
              links: { record: 'https://www.webofscience.com/record/integration-3' },
              citations: [{ db: 'WOS', count: 1 }],
              identifiers: { doi: '10.1000/wos-integration-3' }
            }
          ]
        }
      }))
    };
    const directContexts: RetrievalOperationContext[] = [];
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
        directContexts.push(context);
        return {
          provider: 'direct',
          strategy: 'direct',
          targetStatus: 200,
          document: {
            kind: 'html',
            html: '<div id="pdf"></div><script src="/viewer.js"></script>',
            iframes: [],
            source: { provenance: 'trusted_direct', finalUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: 0 }
        } satisfies RetrievalResponse;
      })
    };
    const paidContexts: RetrievalOperationContext[] = [];
    const paidStrategies: string[] = [];
    const paidProvider: RetrievalProvider = {
      name: 'scrapingant',
      capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
      retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
        paidContexts.push(context);
        paidStrategies.push(request.strategy);
        const suffix = request.url.endsWith('/wos-integration-2') ? '2' : '1';
        return {
          provider: 'scrapingant',
          strategy: request.strategy,
          apiStatus: 200,
          targetStatus: 200,
          document: {
            kind: 'html',
            html: `<a href="https://publisher.example/wos-integration-${suffix}.pdf">PDF</a>`,
            iframes: [],
            source: { provenance: 'unknown_remote', submittedUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: 1 }
        } satisfies RetrievalResponse;
      })
    };
    const service = new RetrievalService({
      directProvider,
      scrapingAntProvider: paidProvider,
      configuration: paidConfiguration(1),
      costPolicy: new RetrievalCostPolicy({ budget: 1, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: {
        request: jest.fn(async (config: any) => {
          const url = String(config.url);
          if (url.includes('doi.org')) {
            const doi = decodeURIComponent(new URL(url).pathname.slice(1));
            const suffix = doi.endsWith('wos-integration-2') ? '2' : doi.endsWith('wos-integration-3') ? '3' : '1';
            return { status: 302, headers: { location: `https://publisher.example/wos-integration-${suffix}` }, data: undefined };
          }
          return { status: 200, headers: {}, data: undefined };
        })
      },
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const quotaManager = QuotaManager.getInstance();
    (quotaManager as any).quotas.clear();
    const webofscience = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient: officialHttp as any,
      starterRateLimiter: integrationRateLimiter(),
      quotaManager,
      sleep: async () => undefined,
      random: () => 0,
      maxRetries: 0,
      retrievalService: service,
      publicAccessDiscovery: discovery
    });
    const baseSearchers = makeSearchers(service);
    const searchers = {
      ...baseSearchers,
      webofscience,
      wos: webofscience,
      platforms: { ...baseSearchers.platforms, webofscience },
      retrievalService: service
    } as any;
    const handler = registeredCallHandler(searchers);
    const createOperation = jest.spyOn(service, 'createOperation');

    const result = await handler(
      { params: { name: 'search_webofscience', arguments: {
        query: 'integration consumer',
        maxResults: 3,
        sortBy: 'date',
        sortOrder: 'asc',
        discoverAccess: true,
        discoverAccessMaxItems: 2
      } } },
      { signal: new AbortController().signal }
    );
    const text = result.content[0].text;
    const body = JSON.parse(text.slice(text.indexOf('\n\n') + 2));
    const operation = createOperation.mock.results[0].value as RetrievalOperationContext;
    const extras = body.map((paper: any) => JSON.parse(paper.extra));

    expect(result.isError).toBeUndefined();
    expect(officialHttp.request).toHaveBeenCalledTimes(1);
    expect(officialHttp.request.mock.calls[0][0]).toEqual(expect.objectContaining({
      url: 'https://api.clarivate.com/apis/wos-starter/v2/documents',
      params: expect.objectContaining({ q: 'TS=(integration consumer)', db: 'WOS', limit: 3, page: 1, sortField: 'PY+A' })
    }));
    expect(body.map((paper: any) => paper.paper_id)).toEqual(['WOS:integration-1', 'WOS:integration-2', 'WOS:integration-3']);
    expect(body).toHaveLength(3);
    expect(body[0].title).toBe('Integrated first result');
    expect(body[2].title).toBe('Integrated third result');
    expect(body[0].pdf_url).toBe('https://publisher.example/wos-integration-1.pdf');
    expect(extras.map((extra: any) => extra.accessDiscovery?.status)).toEqual(['oa_candidate', 'skipped', 'skipped']);
    expect(extras[1].accessDiscovery.reason).toBe('paid_budget_unavailable');
    expect(extras[2].accessDiscovery.reason).toBe('discovery_limit');
    expect(directContexts).toHaveLength(2);
    expect(directContexts.every(context => context === operation)).toBe(true);
    expect(paidContexts).toHaveLength(1);
    expect(paidContexts[0]).toBe(operation);
    expect(paidStrategies).toEqual(['static']);
    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      requestCount: 3,
      strategyCounts: { direct: 2, static: 1, browser: 0 },
      admissionUsed: 1,
      reportedCredits: 1,
      unknownCostAttempts: 0
    }));
    expect(operation.signal.aborted).toBe(true);
  });

  it('shares a paid ledger within one MCP call but isolates independent call ledgers', async () => {
    const paidContexts: RetrievalOperationContext[] = [];
    const paidRetrieve = jest.fn(async (_request: any, context: RetrievalOperationContext) => {
      paidContexts.push(context);
      return {
        provider: 'scrapingant',
        strategy: 'static',
        apiStatus: 200,
        targetStatus: 200,
        document: {
          kind: 'html',
          html: '<html></html>',
          iframes: [],
          source: { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/page' },
          targetStatus: 200
        },
        cost: { known: true, credits: 1 }
      } satisfies RetrievalResponse;
    });
    const paidProvider: RetrievalProvider = {
      name: 'scrapingant',
      capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
      retrieve: paidRetrieve
    };
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async () => {
        throw new Error('unexpected direct dispatch');
      })
    };
    const service = new RetrievalService({
      directProvider,
      scrapingAntProvider: paidProvider,
      costPolicy: new RetrievalCostPolicy({ budget: 1, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({
        validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      }),
      maxConcurrency: 2
    });
    const scholar = {
      search: jest.fn(async (_query: string, options: any) => {
        let requestNumber = 0;
        const request = (): any => ({
          url: `https://example.com/page?attempt=${requestNumber++}`,
          purpose: 'publisher_discovery',
          strategy: 'static',
          documentFormat: 'html',
          signal: options.operationContext.signal
        });
        await service.retrieveWithRetry(request(), options.operationContext);
        await expect(service.retrieveWithRetry(request(), options.operationContext)).rejects.toMatchObject({ code: 'budget' });
        return [];
      })
    };
    const searchers = { ...makeSearchers(service), googlescholar: scholar, retrievalService: service } as any;
    const handler = createCallToolHandler(() => searchers);

    const [first, second] = await Promise.all([
      handler({ params: { name: 'search_google_scholar', arguments: { query: 'first', maxResults: 1 } } }, { signal: new AbortController().signal }),
      handler({ params: { name: 'search_google_scholar', arguments: { query: 'second', maxResults: 1 } } }, { signal: new AbortController().signal })
    ]);

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(paidRetrieve).toHaveBeenCalledTimes(2);
    expect(new Set(paidContexts.map(context => context.cost)).size).toBe(2);
    expect(paidContexts.every(context => context.cost.snapshot().admissionUsed === 1)).toBe(true);
  });

  it('runs a paginated Scholar consumer through the real direct provider', async () => {
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (request: any) => {
        const start = new URL(request.url).searchParams.get('start') || '0';
        const title = start === '0' ? 'Scholar page one' : 'Scholar page two';
        return {
          provider: 'direct',
          strategy: 'direct',
          targetStatus: 200,
          document: {
            kind: 'html',
            html: `<div class="gs_ri"><h3 class="gs_rt"><a href="https://example.com/${start}">${title}</a></h3><div class="gs_a">Alice - Journal, 2024</div><div class="gs_rs">Abstract</div></div>`,
            iframes: [],
            source: { provenance: 'trusted_direct', finalUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: 0 }
        } satisfies RetrievalResponse;
      })
    };
    const service = new RetrievalService({
      directProvider,
      costPolicy: new RetrievalCostPolicy({ enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({
        validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      })
    });
    const scholarHttpClient = {
      request: jest.fn(async (url: string) => ({
        response: { status: 200, headers: {}, data: '' },
        finalUrl: url
      } as any))
    };
    const scholar = new GoogleScholarSearcher(undefined, {
      transport: 'direct',
      retrievalService: service,
      publicHttpClient: scholarHttpClient as any
    });
    (scholar as any).adaptiveDelay = jest.fn(async () => undefined);
    const operation = service.createOperation();
    try {
      await expect(scholar.search('open science', { maxResults: 2, operationContext: operation })).resolves.toEqual([
        expect.objectContaining({ title: 'Scholar page one' }),
        expect.objectContaining({ title: 'Scholar page two' })
      ]);
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 2,
        strategyCounts: { direct: 2, static: 0, browser: 0 }
      }));
      expect(directProvider.retrieve).toHaveBeenCalledTimes(2);
    } finally {
      operation.dispose();
    }
  });

  it('runs the actual Scholar consumer through the registered callback and stops at its paid budget', async () => {
    const directRetrieve = jest.fn(async (request: any) => ({
      provider: 'direct',
      strategy: 'direct',
      targetStatus: 503,
      document: {
        kind: 'html',
        html: '<html>upstream unavailable</html>',
        iframes: [],
        source: { provenance: 'trusted_direct', finalUrl: request.url },
        targetStatus: 503
      },
      cost: { known: true, credits: 0 }
    } satisfies RetrievalResponse));
    const paidContexts: RetrievalOperationContext[] = [];
    const paidRetrieve = jest.fn(async (request: any, context: RetrievalOperationContext) => {
      paidContexts.push(context);
      const start = new URL(request.url).searchParams.get('start') || '0';
      return {
        provider: 'scrapingant',
        strategy: 'static',
        apiStatus: 200,
        targetStatus: 200,
        document: {
          kind: 'html',
          html: `<div class="gs_ri"><h3 class="gs_rt"><a href="https://example.com/${start}">Paid Scholar ${start}</a></h3><div class="gs_a">Alice - Journal, 2024</div><div class="gs_rs">Abstract</div></div>`,
          iframes: [],
          source: { provenance: 'unknown_remote', submittedUrl: request.url },
          targetStatus: 200
        },
        cost: { known: true, credits: 1 }
      } satisfies RetrievalResponse;
    });
    const service = new RetrievalService({
      directProvider: {
        name: 'direct',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
        retrieve: directRetrieve
      },
      scrapingAntProvider: {
        name: 'scrapingant',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: true },
        retrieve: paidRetrieve
      },
      configuration: paidConfiguration(10),
      costPolicy: new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const scholar = new GoogleScholarSearcher(undefined, {
      transport: 'auto',
      retrievalService: service,
      publicHttpClient: {
        request: jest.fn(async (url: string) => ({
          response: { status: 200, headers: {}, data: '' },
          finalUrl: url
        }))
      } as any
    });
    (scholar as any).adaptiveDelay = jest.fn(async () => undefined);
    const searchers = { ...makeSearchers(service), googlescholar: scholar, retrievalService: service } as any;
    const handler = createCallToolHandler(() => searchers);

    const result = await handler(
      { params: { name: 'search_google_scholar', arguments: { query: 'budgeted query', maxResults: 2 } } },
      { signal: new AbortController().signal }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Paid Scholar 0');
    expect(directRetrieve).toHaveBeenCalledTimes(6);
    expect(paidRetrieve).toHaveBeenCalledTimes(1);
    expect(paidContexts).toHaveLength(1);
    expect(paidContexts[0].cost.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 10,
      reportedCredits: 1,
      paidClosed: true,
      paidClosedReason: 'operation_budget_exceeded'
    }));
  });

  it('runs a Sci-Hub search-to-download trace on one real operation context', async () => {
    const pdfUrl = 'https://cdn.example/integration.pdf';
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (request: any, _context: RetrievalOperationContext) => ({
        provider: 'direct',
        strategy: 'direct',
        targetStatus: 200,
        document: {
          kind: 'html',
          html: `<html><title>Integration paper</title><a href="${pdfUrl}">PDF</a></html>`,
          iframes: [],
          source: { provenance: 'trusted_direct', finalUrl: request.url },
          targetStatus: 200
        },
        cost: { known: true, credits: 0 }
      } satisfies RetrievalResponse))
    };
    const service = new RetrievalService({
      directProvider,
      costPolicy: new RetrievalCostPolicy({ enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({
        validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      })
    });
    const healthHttpClient = {
      request: jest.fn(async (url: string) => ({
        response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
        finalUrl: url
      } as any))
    };
    const download = jest.fn(async (_url: string, _config: any) => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-integration') },
      finalUrl: pdfUrl
    } as any));
    const scihub = new SciHubSearcher({
      enabled: true,
      fetchMode: 'direct',
      retrievalService: service,
      healthHttpClient,
      downloadHttpClient: { request: download },
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const operation = service.createOperation();
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'mcp-scihub-trace-'));
    try {
      await expect(scihub.search('10.1000/integration', { operationContext: operation })).resolves.toEqual([
        expect.objectContaining({ pdfUrl })
      ]);
      await expect(scihub.downloadPdf('10.1000/integration', {
        savePath: directory,
        operationContext: operation
      })).resolves.toBe(path.join(directory, '10.1000_integration.pdf'));
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 1,
        strategyCounts: { direct: 1, static: 0, browser: 0 }
      }));
      expect(healthHttpClient.request).toHaveBeenCalledTimes(5);
      expect(download).toHaveBeenCalledWith(pdfUrl, expect.objectContaining({ signal: operation.signal }));
    } finally {
      operation.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs actual Sci-Hub fallback lookup and download within one paid operation budget', async () => {
    const pdfUrl = 'https://cdn.example/paid-integration.pdf';
    const paidContexts: RetrievalOperationContext[] = [];
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (request: any) => ({
        provider: 'direct',
        strategy: 'direct',
        targetStatus: 500,
        document: {
          kind: 'html',
          html: '<html>temporary mirror failure</html>',
          iframes: [],
          source: { provenance: 'trusted_direct', finalUrl: request.url },
          targetStatus: 500
        },
        cost: { known: true, credits: 0 }
      } satisfies RetrievalResponse))
    };
    const paidProvider: RetrievalProvider = {
      name: 'scrapingant',
      capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
      retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
        paidContexts.push(context);
        return {
          provider: 'scrapingant',
          strategy: 'static',
          apiStatus: 200,
          targetStatus: 200,
          document: {
            kind: 'html',
            html: `<html><a href="${pdfUrl}">PDF</a></html>`,
            iframes: [],
            source: { provenance: 'unknown_remote', submittedUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: 1 }
        } satisfies RetrievalResponse;
      })
    };
    const service = new RetrievalService({
      directProvider,
      scrapingAntProvider: paidProvider,
      configuration: paidConfiguration(2),
      costPolicy: new RetrievalCostPolicy({ budget: 2, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const healthHttpClient = {
      request: jest.fn(async (url: string) => ({
        response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
        finalUrl: url
      } as any))
    };
    const download = jest.fn(async (_url: string, _config: any) => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-paid-integration') },
      finalUrl: pdfUrl
    } as any));
    const scihub = new SciHubSearcher({
      enabled: true,
      fetchMode: 'fallback',
      retrievalService: service,
      healthHttpClient,
      downloadHttpClient: { request: download },
      securityPolicy: integrationSecurityPolicy(),
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const operation = service.createOperation();
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'mcp-scihub-paid-'));
    try {
      await expect(scihub.search('10.1000/paid-integration', { operationContext: operation })).resolves.toEqual([
        expect.objectContaining({ pdfUrl })
      ]);
      await expect(scihub.downloadPdf('10.1000/paid-integration', {
        savePath: directory,
        operationContext: operation
      })).resolves.toBe(path.join(directory, '10.1000_paid-integration.pdf'));
      expect(paidProvider.retrieve).toHaveBeenCalledTimes(1);
      expect(new Set(paidContexts)).toEqual(new Set([operation]));
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 4,
        strategyCounts: { direct: 3, static: 1, browser: 0 },
        admissionUsed: 1,
        reportedCredits: 1,
        paidClosed: false
      }));
      expect(healthHttpClient.request).toHaveBeenCalledTimes(5);
      expect(download).toHaveBeenCalledWith(pdfUrl, expect.objectContaining({ signal: operation.signal }));
    } finally {
      operation.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reuses a browser-discovered Sci-Hub candidate for same-operation download', async () => {
    const pdfUrl = 'https://cdn.example/browser-only.pdf';
    const paidContexts: RetrievalOperationContext[] = [];
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: jest.fn(async (request: any) => ({
        provider: 'direct',
        strategy: 'direct',
        targetStatus: 200,
        document: {
          kind: 'html',
          html: '<div id="pdf"></div><script src="/viewer.js"></script>',
          iframes: [],
          source: { provenance: 'trusted_direct', finalUrl: request.url },
          targetStatus: 200
        },
        cost: { known: true, credits: 0 }
      } satisfies RetrievalResponse))
    };
    const paidProvider: RetrievalProvider = {
      name: 'scrapingant',
      capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
      retrieve: jest.fn(async (request: any, context: RetrievalOperationContext) => {
        paidContexts.push(context);
        return {
          provider: 'scrapingant',
          strategy: request.strategy,
          targetStatus: 200,
          document: {
            kind: 'html',
            html: request.strategy === 'browser'
              ? `<a href="${pdfUrl}">PDF</a>`
              : '<div id="pdf"></div><script src="/viewer.js"></script>',
            iframes: [],
            source: { provenance: 'unknown_remote', submittedUrl: request.url },
            targetStatus: 200
          },
          cost: { known: true, credits: request.strategy === 'browser' ? 10 : 1 }
        } satisfies RetrievalResponse;
      })
    };
    const service = new RetrievalService({
      directProvider,
      scrapingAntProvider: paidProvider,
      configuration: paidConfiguration(20, true),
      costPolicy: new RetrievalCostPolicy({ budget: 20, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const scihub = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: {
        request: jest.fn(async (url: string) => ({
          response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
          finalUrl: url
        } as any))
      },
      downloadHttpClient: {
        request: jest.fn(async () => ({
          response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-browser-only') },
          finalUrl: pdfUrl
        } as any))
      },
      securityPolicy: integrationSecurityPolicy(),
      validateUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const operation = service.createOperation();
    const callbackService = { createOperation: jest.fn(() => operation) };
    const searchers = { ...makeSearchers(callbackService), scihub, retrievalService: callbackService } as any;
    const handler = registeredCallHandler(searchers);
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'mcp-scihub-browser-only-'));
    try {
      const result = await handler(
        { params: { name: 'search_scihub', arguments: {
          doiOrUrl: '10.1000/browser-only',
          downloadPdf: true,
          savePath: directory
        } } },
        { signal: new AbortController().signal }
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(pdfUrl);
      expect(result.content[0].text).toContain('PDF downloaded successfully');
      expect(paidProvider.retrieve).toHaveBeenCalledTimes(2);
      expect(paidContexts).toHaveLength(2);
      expect(new Set(paidContexts)).toEqual(new Set([operation]));
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 3,
        strategyCounts: { direct: 1, static: 1, browser: 1 },
        admissionUsed: 11,
        reportedCredits: 11,
        paidClosed: false
      }));
      expect(operation.signal.aborted).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels the actual Scholar consumer through the registered MCP callback', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const directRetrieve = jest.fn(async (_request: any, context: RetrievalOperationContext) => {
      resolveStarted();
      await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new RetrievalError({
          code: 'cancelled',
          message: 'Retrieval operation was cancelled',
          provider: 'direct'
        })), { once: true });
      });
      throw new Error('unreachable');
    });
    const paidRetrieve = jest.fn(async () => {
      throw new Error('unexpected paid fallback');
    });
    const service = new RetrievalService({
      directProvider: {
        name: 'direct',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
        retrieve: directRetrieve
      },
      scrapingAntProvider: {
        name: 'scrapingant',
        capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: true },
        retrieve: paidRetrieve
      },
      configuration: paidConfiguration(10),
      costPolicy: new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: integrationSecurityPolicy()
    });
    const scholar = new GoogleScholarSearcher(undefined, {
      transport: 'direct',
      retrievalService: service,
      publicHttpClient: {
        request: jest.fn(async (url: string) => ({
          response: { status: 200, headers: {}, data: '' },
          finalUrl: url
        }))
      } as any
    });
    (scholar as any).adaptiveDelay = jest.fn(async () => undefined);
    const searchers = { ...makeSearchers(service), googlescholar: scholar, retrievalService: service } as any;
    const handlers = new Map<unknown, (...args: any[]) => Promise<any>>();
    const server = {
      setRequestHandler: jest.fn((schema: unknown, handler: (...args: any[]) => Promise<any>) => {
        handlers.set(schema, handler);
      })
    } as any;
    registerMcpHandlers(server, () => searchers);
    const controller = new AbortController();
    const call = handlers.get(CallToolRequestSchema)!({
      params: { name: 'search_google_scholar', arguments: { query: 'cancelled query', maxResults: 1 } }
    }, { signal: controller.signal });
    await started;
    controller.abort();
    const result = await call;

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Found 0 Google Scholar papers.');
    expect(directRetrieve).toHaveBeenCalledTimes(1);
    expect(paidRetrieve).not.toHaveBeenCalled();
  });

  it('cancels one real retrieval operation without fallback and leaves its sibling progressing', async () => {
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    let releaseSecond!: () => void;
    const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
    const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
    const secondRelease = new Promise<void>(resolve => { releaseSecond = resolve; });
    const contexts: RetrievalOperationContext[] = [];
    let providerCalls = 0;
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: { html: true, iframeDocuments: false, pdfCandidates: false, browser: false, paid: false },
      retrieve: async (_request, context) => {
        contexts.push(context);
        providerCalls++;
        if (providerCalls === 1) {
          firstStarted();
          await new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new RetrievalError({
              code: 'cancelled',
              message: 'Retrieval operation was cancelled',
              provider: 'direct'
            })), { once: true });
          });
        } else if (providerCalls === 2) {
          secondStarted();
          await secondRelease;
        }
        return {
          provider: 'direct',
          strategy: 'direct',
          targetStatus: 200,
          document: {
            kind: 'html',
            html: '<html></html>',
            iframes: [],
            source: { provenance: 'trusted_direct', finalUrl: 'https://scholar.google.com/scholar' },
            targetStatus: 200
          },
          cost: { known: true, credits: 0 }
        } satisfies RetrievalResponse;
      }
    };
    const staticRetrieve = jest.fn(async () => {
      throw new Error('unexpected fallback');
    });
    const staticProvider: RetrievalProvider = {
      name: 'scrapingant',
      capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
      retrieve: staticRetrieve
    };
    const service = new RetrievalService({
      directProvider,
      scrapingAntProvider: staticProvider,
      costPolicy: new RetrievalCostPolicy({ enabled: true, budget: 50, maxCreditsPerRequest: 10 }),
      securityPolicy: new OutboundSecurityPolicy({
        validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      }),
      maxConcurrency: 2,
      operationTimeoutMs: 5_000
    });
    const scholar = {
      search: jest.fn(async (_query: string, options: any) => {
        await service.retrieveWithStrategies([
          {
            request: {
              url: 'https://scholar.google.com/scholar?q=public',
              purpose: 'scholar_search',
              strategy: 'direct',
              documentFormat: 'html',
              signal: options.operationContext.signal
            },
            isTerminalResponse: response => response.targetStatus !== 503
          },
          {
            request: {
              url: 'https://scholar.google.com/scholar?q=public',
              purpose: 'scholar_search',
              strategy: 'static',
              documentFormat: 'html',
              signal: options.operationContext.signal
            },
            shouldAttempt: () => !options.operationContext.signal.aborted
          }
        ], options.operationContext, { scopeId: 'scholar-search', maxPaidStrategySelections: 3, maxBrowserDispatches: 0 });
        return [];
      })
    };
    const searchers = { ...makeSearchers(service), googlescholar: scholar, retrievalService: service } as any;
    const handler = createCallToolHandler(() => searchers);
    const cancelled = new AbortController();
    const sibling = new AbortController();

    const cancelledCall = handler(
      { params: { name: 'search_google_scholar', arguments: { query: 'first', maxResults: 1 } } },
      { signal: cancelled.signal }
    );
    await firstReady;
    const siblingCall = handler(
      { params: { name: 'search_google_scholar', arguments: { query: 'second', maxResults: 1 } } },
      { signal: sibling.signal }
    );
    await secondReady;
    cancelled.abort();

    const cancelledResult = await cancelledCall;
    expect(contexts[1].signal.aborted).toBe(false);
    releaseSecond();
    const siblingResult = await siblingCall;
    expect(cancelledResult.isError).toBe(true);
    expect(siblingResult.isError).toBeUndefined();
    expect(providerCalls).toBe(2);
    expect(staticRetrieve).not.toHaveBeenCalled();
    expect(contexts[0].cost).not.toBe(contexts[1].cost);
    expect(contexts[0].signal.aborted).toBe(true);
    expect(contexts[1].signal.aborted).toBe(true);
  });
});
