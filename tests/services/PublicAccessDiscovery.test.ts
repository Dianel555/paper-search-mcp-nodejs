import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { TIMEOUTS } from '../../src/config/constants.js';
import { PaperFactory } from '../../src/models/Paper.js';
import { PublicAccessDiscovery } from '../../src/services/PublicAccessDiscovery.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { globalPublicSourceDispatchScheduler, PublicSourceDispatchScheduler } from '../../src/services/PublicSourceDispatchScheduler.js';

import { parseRetrievalConfiguration, type RetrievalConfiguration } from '../../src/retrieval/Configuration.js';
import { RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';
import { ScrapingAntProvider } from '../../src/retrieval/ScrapingAntProvider.js';
import { RETRIEVAL_OPERATION_TIMEOUT_MS, RetrievalService } from '../../src/retrieval/RetrievalService.js';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import { RetrievalError } from '../../src/retrieval/types.js';
import type {
  RetrievalOperationContext,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalDispatchSlot
} from '../../src/retrieval/types.js';

const validateUrl = async (url: string) => {
  if (new URL(url).hostname === 'private.example') throw new Error('private target');
  return {
    url,
    hostname: new URL(url).hostname,
    addresses: [{ address: '93.184.216.34', family: 4 as const }]
  };
};

const directCapabilities = {
  html: true,
  iframeDocuments: false,
  pdfCandidates: false,
  browser: false,
  paid: false
} as const;
const paidCapabilities = {
  html: true,
  iframeDocuments: true,
  pdfCandidates: true,
  browser: true,
  paid: true
} as const;

function configuration(paidEnabled: boolean, browserAllowed = false): RetrievalConfiguration {
  const base = parseRetrievalConfiguration({} as NodeJS.ProcessEnv);
  return {
    ...base,
    scrapingAnt: {
      ...base.scrapingAnt,
      apiKey: paidEnabled ? 'test-key' : undefined,
      configured: paidEnabled,
      enabled: paidEnabled,
      paidEnabled,
      browserAllowed: paidEnabled && browserAllowed
    }
  };
}

function response(
  provider: 'direct' | 'paid',
  strategy: 'direct' | 'static' | 'browser',
  html: string,
  targetStatus = 200,
  credits = provider === 'direct' ? 0 : 1
): RetrievalResponse {
  return {
    provider,
    strategy,
    targetStatus,
    document: {
      kind: 'html',
      html,
      iframes: [],
      source: provider === 'direct'
        ? { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/article' }
        : { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/article' },
      targetStatus
    },
    cost: { known: true, credits }
  };
}

function provider(
  name: 'direct' | 'paid',
  retrieve: RetrievalProvider['retrieve']
): RetrievalProvider {
  return {
    name,
    capabilities: name === 'direct' ? directCapabilities : paidCapabilities,
    retrieve
  };
}

function makeService(
  directRetrieve: RetrievalProvider['retrieve'],
  paidRetrieve?: RetrievalProvider['retrieve'],
  config = configuration(Boolean(paidRetrieve), false),
  validator: typeof validateUrl = validateUrl
): RetrievalService {
  const securityPolicy = new OutboundSecurityPolicy({ validatePublicUrl: validator });
  return new RetrievalService({
    directProvider: provider('direct', directRetrieve),
    scrapingAntProvider: paidRetrieve ? provider('paid', paidRetrieve) : undefined,
    configuration: config,
    costPolicy: new RetrievalCostPolicy({ enabled: config.scrapingAnt.paidEnabled }),
    securityPolicy
  });
}

interface TestDoiRequestConfig {
  url?: string;
  method?: string;
  headers?: unknown;
}

interface TestDoiResponse {
  status: number;
  headers?: unknown;
  data: unknown;
}

function makeDoiRequester(landing = 'https://publisher.example/article', pdfBody?: AsyncIterable<Uint8Array>): {
  request: jest.MockedFunction<(config: TestDoiRequestConfig) => Promise<TestDoiResponse>>;
} {
  return {
    request: jest.fn(async (config: TestDoiRequestConfig): Promise<TestDoiResponse> => {
      const url = config.url || '';
      if (/\.pdf(?:$|[?#])/i.test(url)) {
        return {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
          data: pdfBody || (async function* () { yield Buffer.from('%PDF-1.7'); })()
        };
      }
      if (url.includes('doi.org')) {
        return { status: 302, headers: { location: landing }, data: undefined };
      }
      return { status: 200, headers: {}, data: undefined };
    })
  };
}

type RetrieveMock = jest.MockedFunction<RetrievalProvider['retrieve']>;

function makeDiscovery(
  directRetrieve: RetrievalProvider['retrieve'],
  paidRetrieve?: RetrievalProvider['retrieve'],
  config = configuration(Boolean(paidRetrieve), false),
  requester = makeDoiRequester(),
  discoveryTimeoutMs = 60000,
  validator: typeof validateUrl = validateUrl
): { discovery: PublicAccessDiscovery; requester: ReturnType<typeof makeDoiRequester>; direct: RetrieveMock; paid: RetrieveMock; service: RetrievalService } {
  const direct = jest.fn(directRetrieve) as RetrieveMock;
  const paid = jest.fn(paidRetrieve || (async () => response('paid', 'static', '<html />'))) as RetrieveMock;
  const service = makeService(direct, paidRetrieve ? paid : undefined, config, validator);
  const discovery = new PublicAccessDiscovery(service, {
    discoveryTimeoutMs,
    retrievalService: service,
    publicHttpRequester: requester,
    validateUrl: validator
  });
  return { discovery, requester, direct, paid, service };
}

function paper(doi = '10.1000/example', extra: Partial<Parameters<typeof PaperFactory.create>[0]> = {}) {
  return PaperFactory.create({
    paperId: 'WOS:1',
    title: 'Example paper',
    source: 'webofscience',
    doi,
    ...extra
  });
}

describe('PublicAccessDiscovery', () => {
  afterEach(() => {
    globalPublicSourceDispatchScheduler.reset();
  });
  it('rejects an invalid DOI without making a request', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/paper.pdf">PDF</a>'));
    const { discovery, requester } = makeDiscovery(direct);
    const [enriched] = await discovery.enrich([paper('https://publisher.example/article')]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'skipped', reason: 'invalid_doi' }));
    expect(direct).not.toHaveBeenCalled();
    expect(requester.request).not.toHaveBeenCalled();
  });

  it('uses the shared 120-second operation ceiling by default', async () => {
    const service = makeService(async () => response('direct', 'direct', '<html />'));
    const createOperation = jest.spyOn(service, 'createOperation');
    const discovery = new PublicAccessDiscovery(service, {
      retrievalService: service,
      publicHttpRequester: makeDoiRequester(),
      validateUrl
    });

    await discovery.enrich([paper()]);
    expect(createOperation).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: RETRIEVAL_OPERATION_TIMEOUT_MS,
      purpose: 'publisher_discovery'
    }));
  });

  it('keeps a safely reached Publisher error available for the bounded paid chain', async () => {
    const requester = makeDoiRequester('https://publisher.example/article');
    requester.request.mockImplementation(async (config: TestDoiRequestConfig) => {
      if ((config.url || '').includes('doi.org')) {
        return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
      }
      return { status: 403, headers: {}, data: undefined };
    });
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/fallback.pdf">PDF</a>'));
    const { discovery, direct: directSpy, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true), requester);

    const [enriched] = await discovery.enrich([paper()]);

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(paidSpy).toHaveBeenCalledTimes(1);
    expect(enriched.pdfUrl).toBe('https://publisher.example/fallback.pdf');
  });

  it.each([403, 404, 410, 500])('retains a safely reached Publisher status %s for fallback', async targetStatus => {
    const requester = makeDoiRequester('https://publisher.example/article');
    requester.request.mockImplementation(async (config: TestDoiRequestConfig) => {
      if ((config.url || '').includes('doi.org')) {
        return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
      }
      return { status: targetStatus, headers: {}, data: undefined };
    });
    const direct = jest.fn(async () => response('direct', 'direct', '<html><p>temporary target result</p></html>'));
    const paid = jest.fn(async () => response('paid', 'static', `<a href="https://publisher.example/status-${targetStatus}.pdf">PDF</a>`));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true), requester);

    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe(`https://publisher.example/status-${targetStatus}.pdf`);
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('does not hand a resolver error to a paid provider', async () => {
    const requester = {
      request: jest.fn(async (config: TestDoiRequestConfig) => {
        if ((config.url || '').includes('doi.org')) return { status: 404, headers: {}, data: undefined };
        return { status: 200, headers: {}, data: undefined };
      })
    };
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/paper.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, direct: directSpy, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true), requester as any);

    await discovery.enrich([paper()]);

    expect(requester.request).toHaveBeenCalledTimes(1);
    expect(directSpy).not.toHaveBeenCalled();
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('does not send a paid comparison request after a restricted HEAD fallback page', async () => {
    const requester = makeDoiRequester('https://publisher.example/article');
    requester.request.mockImplementation(async (config: TestDoiRequestConfig) => {
      if (config.method === 'HEAD') return { status: 405, headers: {}, data: undefined };
      if ((config.url || '').includes('doi.org')) {
        return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<html><body>subscription required</body></html>'
      };
    });
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/unexpected.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true), requester);

    const [enriched] = await discovery.enrich([paper()], {
      strategy: { strategy: 'static', proxyType: 'datacenter' }
    });

    expect(paidSpy).not.toHaveBeenCalled();
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted' }));
  });

  it.each([429, 500])('attributes a selected paid comparison failure after a clean HEAD fallback page (%s)', async targetStatus => {
    const requester = makeDoiRequester('https://publisher.example/article');
    requester.request.mockImplementation(async (config: TestDoiRequestConfig) => {
      if (config.method === 'HEAD') return { status: 405, headers: {}, data: undefined };
      if ((config.url || '').includes('doi.org')) {
        return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<html><body>clean publisher page</body></html>'
      };
    });
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/unexpected.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<html><body>selected paid failure</body></html>', targetStatus));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true), requester);

    const [enriched] = await discovery.enrich([paper()], {
      strategy: { strategy: 'static', proxyType: 'datacenter' }
    });

    expect(paidSpy).toHaveBeenCalledTimes(1);
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      targetStatus,
      ...(targetStatus === 429 ? { status: 'failed', reason: 'target_rate_limited' } : { status: 'failed' })
    }));
  });

  it('reuses the bounded GET page used for HEAD method fallback', async () => {
    const requester = {
      request: jest.fn(async (config: TestDoiRequestConfig) => {
        if ((config as any).method === 'HEAD') {
          return { status: 405, headers: {}, data: undefined };
        }
        if ((config.url || '').includes('doi.org')) {
          return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
        }
        const body = Readable.from(['<meta name="citation_pdf_url" ', 'content="https://publisher.example/head-fallback.pdf">']);
        jest.spyOn(body, 'destroy');
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: body
        };
      })
    };
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/unexpected.pdf">PDF</a>'));
    const { discovery, direct: directSpy } = makeDiscovery(direct, undefined, configuration(false), requester as any);

    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/head-fallback.pdf');
    expect(directSpy).not.toHaveBeenCalled();
    expect(requester.request).toHaveBeenCalledTimes(3);
  });

  it('holds a DOI fallback source lease until its body is consumed', async () => {
    let resolveBody!: () => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const body = {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          next: () => {
            if (done) return Promise.resolve({ done: true, value: undefined });
            return new Promise<{ done: boolean; value?: Uint8Array }>(resolve => {
              resolveBody = () => {
                done = true;
                resolve({ done: true, value: undefined });
              };
              bodyStarted();
            });
          },
          return: async () => {
            done = true;
            return { done: true, value: undefined };
          }
        };
      }
    };
    const requester = jest.fn(async (config: any) => {
      if (config.url.includes('doi.org') && config.method === 'HEAD') return { status: 405, headers: {}, data: undefined };
      if (config.url.includes('doi.org')) return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
      if (config.url.includes('/article')) return { status: 200, headers: {}, data: body };
      return { status: 200, headers: {}, data: 'other' };
    });
    const scheduler = new PublicSourceDispatchScheduler();
    const publicClient = new PublicHttpClient({ client: { request: requester }, sourceScheduler: scheduler, validateUrl });
    const service = {
      createOperation: jest.fn(),
      retrieveWithRetry: jest.fn(),
      getProcessStatus: jest.fn(() => ({ enabled: false, browserAllowed: false }))
    } as any;
    const discovery = new PublicAccessDiscovery(service, {
      retrievalService: service,
      publicHttpClient: publicClient,
      validateUrl
    });
    const operation = {
      operationId: 'doi-lease-operation',
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 120_000,
      remainingMs: () => 120_000,
      cost: {} as any
    } as RetrievalOperationContext;

    const pending = discovery.enrich([paper()], { operation });
    await started;
    const other = publicClient.request('https://publisher.example/other', { method: 'GET' });
    await Promise.resolve();
    expect(requester).toHaveBeenCalledTimes(3);
    resolveBody();
    await pending;
    await expect(other).resolves.toBeDefined();
    expect(requester).toHaveBeenCalledTimes(4);
  });

  it('passes the operation transport slot to DOI and PDF auxiliary requests', async () => {
    const controller = new AbortController();
    const dispatchSlot: RetrievalDispatchSlot = jest.fn(async <T>(task: () => Promise<T>) => task()) as unknown as RetrievalDispatchSlot;
    const operation: RetrievalOperationContext = {
      operationId: 'auxiliary-slot-operation',
      signal: controller.signal,
      deadlineAt: Date.now() + 120_000,
      remainingMs: () => 120_000,
      withDispatchSlot: dispatchSlot,
      cost: {} as any
    };
    const publicClient: any = {
      request: jest.fn(async (url: string, config: any) => {
        if (url.includes('doi.org')) {
          return {
            response: { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined },
            finalUrl: 'https://publisher.example/article'
          };
        }
        return {
          response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-1.7') },
          finalUrl: url
        };
      }),
      withPurpose: jest.fn(() => publicClient)
    };
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://cdn.example/auxiliary.pdf">PDF</a>'));
    const service = {
      createOperation: jest.fn(),
      retrieveWithRetry: jest.fn(async () => response('direct', 'direct', '<a href="https://cdn.example/auxiliary.pdf">PDF</a>')),
      getProcessStatus: jest.fn(() => ({ enabled: false, browserAllowed: false }))
    } as any;
    const discovery = new PublicAccessDiscovery(service, {
      retrievalService: service,
      publicHttpClient: publicClient,
      validateUrl
    });

    const [enriched] = await discovery.enrich([paper()], { operation, verifyPdf: true });
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'pdf_verified' }));
    expect(publicClient.request).toHaveBeenCalledTimes(2);
    expect(publicClient.request.mock.calls.every((call: any[]) => call[1].dispatchSlot === dispatchSlot)).toBe(true);
    expect(dispatchSlot).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it('uses controlled direct retrieval first and records a candidate without paid dispatch', async () => {
    const direct = jest.fn(async (_request: RetrievalRequest, _context: RetrievalOperationContext) =>
      response('direct', 'direct', '<meta name="citation_pdf_url" content="/public/paper.pdf">'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, direct: directSpy, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/public/paper.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      method: 'citation_pdf_url',
      candidateUrl: 'https://publisher.example/public/paper.pdf'
    }));
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('does not classify a paper as a challenge because a non-visible script mentions Cloudflare', async () => {
    const direct = jest.fn(async (_request: RetrievalRequest, _context: RetrievalOperationContext) =>
      response('direct', 'direct', '<meta name="citation_pdf_url" content="/public/paper.pdf"><script>const provider = "cloudflare";</script>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      candidateUrl: 'https://publisher.example/public/paper.pdf'
    }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('retains a noscript permission message as restriction evidence', async () => {
    const direct = jest.fn(async (_request: RetrievalRequest, _context: RetrievalOperationContext) =>
      response('direct', 'direct', '<noscript><p>Please sign in to access the full text</p></noscript><a href="https://publisher.example/paper.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper('10.1000/noscript-restriction')]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['visible', '<p>Sign in to access the full text</p>'],
    ['noscript', '<noscript><p>Sign in to access the full text</p></noscript>']
  ] as Array<[string, string]>)('does not retry a 503 permission page before paid fallback (%s)', async (_label, restrictionMarkup) => {
    const direct = jest.fn(async () => response(
      'direct',
      'direct',
      `${restrictionMarkup}<a href="https://publisher.example/restricted.pdf">PDF</a>`,
      503
    ));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, direct: directSpy, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true));
    const [enriched] = await discovery.enrich([paper(`10.1000/restricted-503-${_label}`)]);

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(paidSpy).not.toHaveBeenCalled();
    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'restricted',
      targetStatus: 503
    }));
    expect(enriched.extra?.accessDiscovery).not.toHaveProperty('candidateUrl');
  });

  it('does not expose a signed iframe source alongside a safe absolute candidate', async () => {
    const signedSource = 'https://viewer.example/frame?X-Amz-Signature=sentinel';
    const safeCandidate = 'https://cdn.example/paper.pdf';
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => ({
      provider: 'paid',
      strategy: 'static',
      targetStatus: 200,
      document: {
        kind: 'html',
        html: '<html></html>',
        iframes: [{
          src: signedSource,
          html: `<a href="${safeCandidate}">PDF</a>`,
          source: { provenance: 'unknown_remote' as const, submittedUrl: signedSource }
        }],
        source: { provenance: 'unknown_remote' as const, submittedUrl: 'https://publisher.example/article' },
        targetStatus: 200
      },
      cost: { known: true, credits: 1 }
    } satisfies RetrievalResponse));
    const { discovery } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe(safeCandidate);
    expect(JSON.stringify(enriched)).not.toContain('sentinel');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      evidence: expect.objectContaining({
        source: { provenance: 'unknown_remote', submittedUrl: 'https://viewer.example/frame' }
      })
    }));
  });

  it.each([
    'https://publisher.example/paper.pdf?access_token=sentinel',
    'https://publisher.example/paper.pdf?X-Amz-Signature=sentinel',
    'https://publisher.example/paper.pdf#access_token=sentinel'
  ])('rejects credential-bearing candidate %s without exposing it', async candidateUrl => {
    const direct = jest.fn(async () => response('direct', 'direct', `<a href="${candidateUrl}">PDF</a>`));
    const { discovery } = makeDiscovery(direct);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(JSON.stringify(enriched)).not.toContain('sentinel');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found' }));
  });

  it('does not forward public provider cookies while using the real single-attempt provider', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const scraperRequest = jest.fn(async (_config: any) => ({
      status: 200,
      headers: { 'Ant-credits-cost': '2' },
      data: { status_code: 200, html: '<a href="https://publisher.example/provider.pdf">PDF</a>' }
    }));
    const paidProvider = new ScrapingAntProvider({
      apiKey: 'test-key',
      client: { request: scraperRequest }
    });
    const config = configuration(true);
    const service = new RetrievalService({
      directProvider: provider('direct', direct),
      scrapingAntProvider: paidProvider,
      configuration: config,
      costPolicy: new RetrievalCostPolicy({ enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const requester = makeDoiRequester();
    const discovery = new PublicAccessDiscovery(service, {
      retrievalService: service,
      publicHttpRequester: requester,
      validateUrl
    });
    process.env.SCRAPINGANT_PUBLIC_COOKIES_BY_HOST_JSON = JSON.stringify({
      'publisher.example': 'session=must-not-forward'
    });
    try {
      const [enriched] = await discovery.enrich([paper()]);
      expect(enriched.pdfUrl).toBe('https://publisher.example/provider.pdf');
      expect(scraperRequest).toHaveBeenCalledTimes(1);
      expect(scraperRequest.mock.calls[0][0].params.cookies).toBeUndefined();
      expect(JSON.stringify(scraperRequest.mock.calls[0][0])).not.toContain('must-not-forward');
    } finally {
      delete process.env.SCRAPINGANT_PUBLIC_COOKIES_BY_HOST_JSON;
    }
  });

  it('does not escalate a terminal direct response resource failure', async () => {
    const direct = jest.fn(async () => {
      throw new RetrievalError({ code: 'response_too_large', message: 'bounded response rejected', provider: 'direct' });
    });
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed', reason: 'response_too_large' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('preserves a candidate after unknown cost and keeps the Paper snapshot stable', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => ({
      ...response('paid', 'static', '<a href="https://publisher.example/unknown-cost.pdf">PDF</a>'),
      cost: { known: false as const, credits: null, reason: 'missing_billing_header' }
    }));
    const requester = makeDoiRequester();
    const { discovery, paid: paidSpy, service } = makeDiscovery(direct, paid, configuration(true), requester);
    const operation = service.createOperation();
    try {
      const [enriched] = await discovery.enrich([paper()], { operation, verifyPdf: true });
      expect(enriched.pdfUrl).toBe('https://publisher.example/unknown-cost.pdf');
      expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'pdf_verified',
        evidence: expect.any(Object),
        verification: expect.objectContaining({ status: 'verified' })
      }));
      const snapshot = JSON.stringify(enriched);
      const reservation = service.getOperationReservation(operation, 'retrieval-attempt-1');
      expect(reservation).toBeDefined();
      await new Promise<void>(resolve => queueMicrotask(() => {
        service.reconcileCost(operation, reservation!, { known: true, credits: 3 });
        resolve();
      }));
      const reconciledStatus = service.getOperationStatus(operation);
      service.reconcileCost(operation, reservation!, { known: true, credits: 3 });
      expect(service.getOperationStatus(operation)).toEqual(reconciledStatus);
      const otherOperation = service.createOperation();
      try {
        await service.retrieve({
          url: 'https://publisher.example/other-operation',
          purpose: 'publisher_discovery',
          strategy: 'direct',
          documentFormat: 'html'
        }, otherOperation);
      } finally {
        otherOperation.dispose();
      }
      expect(JSON.stringify(enriched)).toBe(snapshot);
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        admissionUsed: 3,
        reportedCredits: 3,
        reportedCreditsKnown: true,
        paidClosed: false
      }));

      const [later] = await discovery.enrich([paper('10.1000/later')], { operation });
      expect(later.extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'oa_candidate',
        provider: 'paid',
        strategy: 'static'
      }));
      expect(paidSpy).toHaveBeenCalledTimes(2);
    } finally {
      operation.dispose();
    }
  });

  it('preserves completed dynamic-page evidence when paid fallback is disabled', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, undefined, configuration(false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'not_found',
      reason: 'dynamic_unresolved'
    }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('uses the bounded paid chain for a clean page with no candidate', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<html><p>Abstract only</p></html>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/paid.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate', strategy: 'static' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves a complete clean not-found observation after ordinary paid failure', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<html><p>Abstract only</p></html>'));
    const paid = jest.fn(async () => {
      throw new RetrievalError({
        code: 'network',
        message: 'temporary provider failure',
        provider: 'paid',
        retryable: true,
        cost: { known: true, credits: 1 }
      });
    });
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'not_found',
      reason: 'no_candidate',
      fallback: expect.objectContaining({ attempted: true })
    }));
    expect(paidSpy).toHaveBeenCalledTimes(3);
  });

  it('stops the paid chain after explicit 2xx absence', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<html><p>Abstract only</p></html>'));
    const paid = jest.fn(async (request: RetrievalRequest) => request.strategy === 'static'
      ? response('paid', 'static', '<html><p>Article not found</p></html>')
      : response('paid', 'browser', '<a href="https://publisher.example/should-not-run.pdf">PDF</a>'));
    const config = configuration(true, true);
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, config);
    const [enriched] = await discovery.enrich([paper('10.1000/explicit-absence')]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found', reason: 'target_not_found' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
    expect(paidSpy.mock.calls[0][0]?.strategy).toBe('static');
  });

  it('lets later permission or resource termination override clean evidence', async () => {
    for (const [code, expectedStatus] of [
      ['security', 'restricted'],
      ['response_too_large', 'failed']
    ] as const) {
      const direct = jest.fn(async () => response('direct', 'direct', '<html><p>Abstract only</p></html>'));
      const paid = jest.fn(async () => {
        throw new RetrievalError({ code: code as any, message: 'terminal', provider: 'paid' });
      });
      const { discovery } = makeDiscovery(direct, paid, configuration(true, false));
      const [enriched] = await discovery.enrich([paper(`10.1000/${code}`)]);
      expect(enriched.extra?.accessDiscovery?.status).toBe(expectedStatus);
    }
  });

  it('switches from dynamic direct HTML to static retrieval only when enabled', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/static.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/static.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate', strategy: 'static' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it.each([401, 407, 423])('keeps terminal permission status %s ahead of challenge text', async targetStatus => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>CAPTCHA verification required</p>', targetStatus));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/should-not-run.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper(`10.1000/terminal-${targetStatus}`)]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted', targetStatus }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it.each([404, 410])('keeps explicit target absence ahead of challenge text after fallback exhaustion (%s)', async targetStatus => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>CAPTCHA verification required</p>', targetStatus));
    const paid = jest.fn(async () => response('paid', 'static', '<p>CAPTCHA verification required</p>', targetStatus));
    const { discovery } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper(`10.1000/absence-${targetStatus}`)]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found', reason: 'target_not_found' }));
  });

  it('keeps target 429 ahead of challenge text without switching providers', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>Checking your browser</p>', 429));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/should-not-run.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper('10.1000/rate-challenge')]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed', reason: 'target_rate_limited' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('does not classify access-policy or CAPTCHA research text as a page gate', async () => {
    const direct = jest.fn(async () => response(
      'direct',
      'direct',
      '<article><p>This study evaluates paywall policy and CAPTCHA attacks.</p><a href="https://publisher.example/research.pdf">PDF</a></article>'
    ));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/should-not-run.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true));
    const [enriched] = await discovery.enrich([paper('10.1000/research-text')]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/research.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('retries an ordinary direct 5xx response before paid fallback', async () => {
    const direct = jest.fn() as RetrieveMock;
    direct
      .mockResolvedValueOnce(response('direct', 'direct', '<p>Temporary failure</p>', 503))
      .mockResolvedValueOnce(response('direct', 'direct', '<a href="https://publisher.example/recovered.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const base = configuration(true);
    const service = new RetrievalService({
      directProvider: provider('direct', direct),
      scrapingAntProvider: provider('paid', paid),
      configuration: base,
      costPolicy: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl }),
      retrySleep: async () => undefined
    });
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: makeDoiRequester(),
      validateUrl
    });
    const [enriched] = await discovery.enrich([paper('10.1000/direct-retry')]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/recovered.pdf');
    expect(direct).toHaveBeenCalledTimes(2);
    expect(paid).not.toHaveBeenCalled();
  });

  it('allows an explicitly extended discovery scope up to the operation bound', async () => {
    jest.useFakeTimers();
    try {
      const direct = jest.fn(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, TIMEOUTS.EXTENDED + 70));
        return response('direct', 'direct', '<a href="https://publisher.example/extended.pdf">PDF</a>');
      });
      const { discovery, service } = makeDiscovery(
        direct,
        undefined,
        configuration(false),
        makeDoiRequester(),
        RETRIEVAL_OPERATION_TIMEOUT_MS
      );
      const operation = service.createOperation({ timeoutMs: RETRIEVAL_OPERATION_TIMEOUT_MS });
      try {
        const pending = discovery.enrich([paper('10.1000/extended-discovery')], { operation });
        await jest.advanceTimersByTimeAsync(TIMEOUTS.EXTENDED + 70);
        const [enriched] = await pending;

        expect(enriched.pdfUrl).toBe('https://publisher.example/extended.pdf');
        expect(direct).toHaveBeenCalledTimes(1);
      } finally {
        operation.dispose();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a completed discovery scope deadline for later verification calls', async () => {
    jest.useFakeTimers();
    try {
      const requester = makeDoiRequester();
      const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/scope.pdf">PDF</a>'));
      const { discovery, service } = makeDiscovery(direct, undefined, configuration(false), requester, 10);
      const operation = service.createOperation({ timeoutMs: 100 });
      try {
        const [base] = await discovery.enrich([paper('10.1000/scope')], { operation, verifyPdf: false });
        await jest.advanceTimersByTimeAsync(11);
        const [verified] = await discovery.enrich([paper('10.1000/scope')], { operation, verifyPdf: true });

        expect(base.extra?.accessDiscovery?.verification).toBeUndefined();
        expect(verified.pdfUrl).toBe('https://publisher.example/scope.pdf');
        expect(verified.extra?.accessDiscovery).toEqual(expect.objectContaining({
          status: 'oa_candidate',
          verification: { status: 'inconclusive', reason: 'aborted_or_timeout' }
        }));
        expect(direct).toHaveBeenCalledTimes(1);
        expect(requester.request.mock.calls.some(call => String(call[0]?.url).endsWith('.pdf'))).toBe(false);
      } finally {
        operation.dispose();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a candidate when optional verification reaches the discovery deadline first', async () => {
    jest.useFakeTimers();
    try {
      const stalled: AsyncIterable<Uint8Array> & { destroy: jest.Mock } = {
        destroy: jest.fn(),
        [Symbol.asyncIterator]: () => ({
          next: async () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => ({ done: true, value: undefined })
        })
      };
      const requester = makeDoiRequester('https://publisher.example/article', stalled);
      const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/deadline.pdf">PDF</a>'));
      const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester, 10);
      const pending = discovery.enrich([paper('10.1000/verify-deadline')], { verifyPdf: true });
      await jest.advanceTimersByTimeAsync(10);
      const [enriched] = await pending;

      expect(enriched.pdfUrl).toBe('https://publisher.example/deadline.pdf');
      expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'oa_candidate',
        verification: expect.objectContaining({ status: 'inconclusive' })
      }));
      expect(stalled.destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('isolates verification snapshots for repeated true callers', async () => {
    const requester = makeDoiRequester();
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/snapshot.pdf">PDF</a>'));
    const { discovery, service } = makeDiscovery(direct, undefined, configuration(false), requester);
    const operation = service.createOperation();
    try {
      const [first] = await discovery.enrich([paper('10.1000/snapshot')], { operation, verifyPdf: true });
      const [second] = await discovery.enrich([paper('10.1000/snapshot')], { operation, verifyPdf: true });
      (first.extra!.accessDiscovery!.verification as any).status = 'failed';
      const [third] = await discovery.enrich([paper('10.1000/snapshot')], { operation, verifyPdf: true });

      expect(second.extra?.accessDiscovery?.verification?.status).toBe('verified');
      expect(third.extra?.accessDiscovery?.verification?.status).toBe('verified');
      expect(requester.request.mock.calls.filter(call => String(call[0]?.url).endsWith('.pdf'))).toHaveLength(1);
    } finally {
      operation.dispose();
    }
  });

  it('prioritizes a target server error over a PDF-looking link', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/error.pdf">PDF</a>', 500));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed', reason: 'direct_failed', targetStatus: 500 }));
  });

  it('allows an ordinary challenge page to reach the bounded paid chain without promoting its link', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>CAPTCHA verification required</p><a href="https://publisher.example/direct.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/challenge-fallback.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/challenge-fallback.pdf');
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a target server error with challenge evidence as a fallback trigger', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>CAPTCHA verification required</p><a href="https://publisher.example/error.pdf">PDF</a>', 503));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/paid.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate', strategy: 'static' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('prioritizes body restriction over a target not-found status', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>Access denied: sign in required</p><a href="https://publisher.example/paper.pdf">PDF</a>', 404));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted', targetStatus: 404 }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it.each([302, 400])('allows an ordinary non-success target status %s to use the bounded fallback', async targetStatus => {
    const dynamic = '<div id="pdf"></div><script src="/app.js"></script>';
    const direct = jest.fn(async () => response('direct', 'direct', dynamic, targetStatus));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/paid.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate', strategy: 'static' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a login redirect before contacting the redirected target', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/paper.pdf">PDF</a>'));
    const requester = makeDoiRequester('https://login.publisher.example/sso');
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester);
    const [enriched] = await discovery.enrich([paper()]);

    expect(requester.request).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted' }));
  });

  it('does not treat restricted pages or apparent PDF links as public access', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>Sign in to access the full text</p><a href="/paper.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it.each([407, 423])('treats target status %s as restricted before paid fallback', async targetStatus => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/target.pdf">PDF</a>', targetStatus));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted', targetStatus }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('stops at a target rate limit without switching providers', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/target.pdf">PDF</a>', 429));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed', reason: 'target_rate_limited', targetStatus: 429 }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('preserves restriction evidence in a linked or button body gate', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<p>Please <a href="/login">sign in</a> to continue</p><button>Sign in</button><a href="https://publisher.example/public.pdf">PDF</a>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('does not treat an ordinary login navigation link as page restriction', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<nav><a href="/login">Login</a></nav><a href="https://publisher.example/public.pdf">PDF</a>'));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/public.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate' }));
  });

  it('does not treat an ordinary iframe source as PDF evidence', async () => {
    const direct = jest.fn(async () => ({
      ...response('direct', 'direct', '<html>viewer</html>'),
      document: {
        ...response('direct', 'direct', '<html>viewer</html>').document!,
        iframes: [{
          src: 'https://viewer.example/frame',
          html: '<html>viewer document</html>',
          source: { provenance: 'unknown_remote' as const, submittedUrl: 'https://publisher.example/article' }
        }]
      }
    }));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/paid.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found', reason: 'no_candidate' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('does not resolve relative links from an unknown ScrapingAnt provenance', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="/relative.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('allows an unknown-status page to use the bounded fallback', async () => {
    const direct = jest.fn(async () => ({
      ...response('direct', 'direct', '<p>Enable JavaScript</p>'),
      targetStatus: undefined,
      document: {
        ...response('direct', 'direct', '<p>Enable JavaScript</p>').document!,
        targetStatus: undefined
      }
    }));
    const paid = jest.fn(async () => response('paid', 'browser', '<a href="https://publisher.example/browser.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/browser.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate', strategy: 'static' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('reports a browser-stage security rejection as restricted', async () => {
    const dynamic = '<div id="pdf"></div><script src="/app.js"></script>';
    const direct = jest.fn(async () => response('direct', 'direct', dynamic));
    const paid = jest.fn(async (request: RetrievalRequest) => {
      if (request.strategy === 'static') return response('paid', 'static', dynamic);
      throw new RetrievalError({
        code: 'security',
        message: 'target rejected',
        provider: 'paid'
      });
    });
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'restricted', reason: 'restricted_target' }));
    expect(paidSpy.mock.calls.map(call => call[0]?.strategy)).toEqual(['static', 'browser']);
  });

  it('allows one browser escalation for the approved empty PDF container shape', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async (request: RetrievalRequest) => request.strategy === 'static'
      ? response('paid', 'static', '<div id="pdf"></div><script src="/app.js"></script>')
      : response('paid', 'browser', '<a href="https://publisher.example/browser.pdf">PDF</a>'));
    const config = configuration(true, true);
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, config);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/browser.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate', strategy: 'browser' }));
    expect(paidSpy.mock.calls.map(call => call[0]?.strategy)).toEqual(['static', 'browser']);
  });

  it('advances through each authorised paid combination without restarting the scope', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/viewer.js"></script>'));
    const paid = jest.fn(async (request: RetrievalRequest) => {
      if (request.proxyType === 'datacenter' && request.strategy === 'static') {
        throw new RetrievalError({ code: 'network', message: 'temporary static failure', provider: 'paid', retryable: true, cost: { known: true, credits: 1 } });
      }
      if (request.proxyType === 'datacenter' && request.strategy === 'browser') {
        throw new RetrievalError({ code: 'network', message: 'temporary browser failure', provider: 'paid', retryable: true, cost: { known: true, credits: 1 } });
      }
      return response('paid', 'static', '<a href="https://publisher.example/residential.pdf">PDF</a>');
    });
    const base = configuration(true, true);
    const config: RetrievalConfiguration = {
      ...base,
      scrapingAnt: {
        ...base.scrapingAnt,
        residentialAllowed: true,
        proxyType: 'residential',
        availableProxyTypes: ['datacenter', 'residential'],
        maxCreditsPerOperation: 500,
        maxCreditsPerRequest: 125
      }
    };
    const service = new RetrievalService({
      directProvider: provider('direct', direct),
      scrapingAntProvider: {
        name: 'paid',
        capabilities: {
          ...paidCapabilities,
          proxyTypes: ['datacenter', 'residential'],
          combinations: ['static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential']
        },
        retrieve: paid
      },
      configuration: config,
      costPolicy: new RetrievalCostPolicy({ budget: 500, maxCreditsPerRequest: 125, enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl }),
      retrySleep: async () => undefined
    });
    const requester = makeDoiRequester();
    const discovery = new PublicAccessDiscovery(undefined, {
      retrievalService: service,
      publicHttpRequester: requester,
      validateUrl
    });

    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/residential.pdf');
    expect(paid.mock.calls.map(([request]) => `${request.proxyType}:${request.strategy}`)).toEqual([
      'datacenter:static', 'datacenter:static', 'datacenter:static',
      'datacenter:browser', 'residential:static'
    ]);
  });

  it('allows one browser escalation for the approved PDF iframe shape', async () => {
    const dynamic = '<iframe class="pdf-viewer" data-src="https://cdn.publisher.example/view"></iframe>';
    const direct = jest.fn(async () => response('direct', 'direct', dynamic));
    const paid = jest.fn(async (request: RetrievalRequest) => request.strategy === 'static'
      ? response('paid', 'static', dynamic)
      : response('paid', 'browser', '<a href="https://publisher.example/browser.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/browser.pdf');
    expect(paidSpy.mock.calls.map(call => call[0]?.strategy)).toEqual(['static', 'browser']);
  });

  it('allows a trusted-direct relative dynamic data source only after policy validation', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<iframe class="pdf-viewer" data-src="/viewer"></iframe>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/static.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/static.pdf');
    expect(paidSpy).toHaveBeenCalledTimes(1);
  });

  it('does not authorize a relative dynamic data source from unknown remote HTML', async () => {
    const dynamic = '<iframe class="pdf-viewer" data-src="/viewer"></iframe>';
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => response('paid', 'static', dynamic));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found', reason: 'no_candidate' }));
    expect(paidSpy).toHaveBeenCalledTimes(1);
    expect(paidSpy.mock.calls.map(call => call[0]?.strategy)).toEqual(['static']);
  });

  it.each([
    'http://127.0.0.1/view',
    'https://private.example/view',
    'https://publisher.example/sso/view'
  ])('does not promote an unsafe PDF iframe data source %s when paid fallback is disabled', async dataSrc => {
    const direct = jest.fn(async () => response('direct', 'direct', `<iframe class="pdf-viewer" data-src="${dataSrc}"></iframe>`));
    const paid = jest.fn(async () => response('paid', 'browser', '<a href="https://publisher.example/browser.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(false));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'not_found', reason: 'no_candidate' }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('keeps a provider authentication failure distinct from target restriction', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => {
      throw new RetrievalError({
        code: 'auth_or_credits_unknown',
        message: 'safe',
        provider: 'paid',
        status: 403,
        cost: { known: true, credits: 1 }
      });
    });
    const { discovery } = makeDiscovery(direct, paid, configuration(true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'skipped', reason: 'provider_auth_or_credits' }));
  });

  it('stops candidate evaluation at twenty rejected candidates', async () => {
    const links = Array.from({ length: 20 }, (_value, index) => `<a href="https://private.example/${index}.pdf">PDF</a>`).join('');
    const direct = jest.fn(async () => response('direct', 'direct', `${links}<a href="https://publisher.example/21.pdf">PDF</a>`));
    const { discovery, paid } = makeDiscovery(direct);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'skipped',
      reason: 'candidate_limit',
      candidatesTruncated: true
    }));
    expect(paid).not.toHaveBeenCalled();
  });

  it.each([200, undefined])('prioritizes candidate truncation over dynamic and %s target-status fallback', async targetStatus => {
    const candidates = Array.from({ length: 21 }, (_value, index) => `<a href="https://private.example/${index}.pdf">Rejected</a>`).join('');
    const markup = `${candidates}<div id="pdf"></div><script src="/app.js"></script>`;
    const base = response('direct', 'direct', markup);
    const direct = jest.fn(async () => ({
      ...base,
      targetStatus,
      document: { ...base.document!, targetStatus }
    }));
    const paid = jest.fn(async () => response('paid', 'browser', '<a href="https://publisher.example/should-not-dispatch.pdf">PDF</a>'));
    const { discovery, paid: paidSpy } = makeDiscovery(direct, paid, configuration(true, true));
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'skipped',
      reason: 'candidate_limit',
      candidateCount: 21,
      candidatesTruncated: true
    }));
    expect(paidSpy).not.toHaveBeenCalled();
  });

  it('keeps paid admission available for another eligible paper after candidate truncation', async () => {
    const candidates = Array.from({ length: 21 }, (_value, index) => `<a href="https://private.example/${index}.pdf">Rejected</a>`).join('');
    const direct = jest.fn() as RetrieveMock;
    direct
      .mockResolvedValueOnce(response('direct', 'direct', `${candidates}<div id="pdf"></div><script src="/app.js"></script>`))
      .mockResolvedValueOnce(response('direct', 'direct', '<div id="pdf"></div><script src="/app.js"></script>'));
    const paid = jest.fn(async () => response('paid', 'static', '<a href="https://publisher.example/second.pdf">PDF</a>'));
    const { discovery, paid: paidSpy, service } = makeDiscovery(direct, paid, configuration(true));
    const operation = service.createOperation();
    try {
      const enriched = await discovery.enrich([paper('10.1000/first'), paper('10.1000/second')], { operation });

      expect(enriched[0].extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'skipped', reason: 'candidate_limit' }));
      expect(enriched[1].pdfUrl).toBe('https://publisher.example/second.pdf');
      expect(enriched[1].extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate' }));
      expect(paidSpy).toHaveBeenCalledTimes(1);
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({ paidClosed: false, admissionUsed: 1 }));
    } finally {
      operation.dispose();
    }
  });

  it('keeps the twentieth candidate and never validates the twenty-first', async () => {
    const links = [
      ...Array.from({ length: 19 }, (_value, index) => `<a href="https://private.example/${index}.pdf">Rejected</a>`),
      '<a href="https://publisher.example/twentieth.pdf">Accepted</a>',
      '<a href="https://publisher.example/twenty-first.pdf">Unvalidated</a>'
    ].join('');
    const validator = jest.fn(validateUrl);
    const direct = jest.fn(async () => response('direct', 'direct', links));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), makeDoiRequester(), 60000, validator);
    const [enriched] = await discovery.enrich([paper()]);

    expect(enriched.pdfUrl).toBe('https://publisher.example/twentieth.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      candidateCount: 21,
      candidatesTruncated: true,
      candidateUrl: 'https://publisher.example/twentieth.pdf'
    }));
    expect(validator.mock.calls.some(call => call[0] === 'https://publisher.example/twenty-first.pdf')).toBe(false);
  });

  it('performs optional bounded PDF verification without writing a file', async () => {
    const body = (async function* () {
      yield Buffer.from('%');
      yield Buffer.from('PDF-1.7');
    })();
    const requester = makeDoiRequester('https://publisher.example/article', body);
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/paper.pdf">PDF</a>'));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester);
    const [enriched] = await discovery.enrich([paper(),], { verifyPdf: true });

    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'pdf_verified',
      verification: expect.objectContaining({ status: 'verified' })
    }));
    const probeCall = requester.request.mock.calls.find(call => /\.pdf/.test(call[0].url || ''));
    expect(probeCall?.[0].headers).toEqual({ Range: 'bytes=0-65535' });
  });

  it('probes only the best safe candidate once when PDF verification is requested', async () => {
    const first = 'https://publisher.example/first.pdf';
    const second = 'https://publisher.example/second.pdf';
    const requester = makeDoiRequester();
    requester.request.mockImplementation(async (config: TestDoiRequestConfig): Promise<TestDoiResponse> => {
      const url = config.url || '';
      if (url.includes('doi.org')) return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
      if (url === first) return { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('not-pdf') };
      if (url === second) return { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-second') };
      return { status: 200, headers: {}, data: undefined };
    });
    const direct = jest.fn(async () => response('direct', 'direct', `<a href="${first}">First PDF</a><a href="${second}">Second PDF</a>`));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester);
    const [enriched] = await discovery.enrich([paper()], { verifyPdf: true });

    expect(enriched.pdfUrl).toBe(first);
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      candidateUrl: first,
      verification: expect.objectContaining({ status: 'inconclusive' })
    }));
    expect(requester.request.mock.calls.some(call => call[0].url === second)).toBe(false);
  });

  it('shares discovery while keeping verifyPdf as an independent one-shot step', async () => {
    const requester = makeDoiRequester();
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/shared.pdf">PDF</a>'));
    const { discovery, service } = makeDiscovery(direct, undefined, configuration(false), requester);
    const operation = service.createOperation();
    try {
      const [withoutVerification, withVerification] = await Promise.all([
        discovery.enrich([paper('10.1000/shared')], { operation, verifyPdf: false }),
        discovery.enrich([paper('10.1000/shared')], { operation, verifyPdf: true })
      ]);

      expect(withoutVerification[0].extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'oa_candidate',
        candidateUrl: 'https://publisher.example/shared.pdf'
      }));
      expect(withoutVerification[0].extra?.accessDiscovery?.verification).toBeUndefined();
      expect(withVerification[0].extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'pdf_verified',
        verification: expect.objectContaining({ status: 'verified' })
      }));
      expect(direct).toHaveBeenCalledTimes(1);
      expect(requester.request.mock.calls.filter(call => call[0].url?.includes('doi.org'))).toHaveLength(1);
      expect(requester.request.mock.calls.filter(call => call[0].url?.endsWith('.pdf'))).toHaveLength(1);
    } finally {
      operation.dispose();
    }
  });

  it('settles a stalled DOI resolution as failed without direct dispatch', async () => {
    jest.useFakeTimers();
    try {
      const requester = { request: jest.fn(async () => new Promise<any>(() => undefined)) };
      const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/late.pdf">PDF</a>'));
      const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester, 10);
      const pending = discovery.enrich([paper()]);
      await jest.advanceTimersByTimeAsync(10);
      const [enriched] = await pending;
      expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed' }));
      expect(direct).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(30000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not dispatch after target validation resolves beyond the deadline', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      const delayedValidator: typeof validateUrl = async url => {
        started();
        await gate;
        return validateUrl(url);
      };
      const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/late.pdf">PDF</a>'));
      const { discovery } = makeDiscovery(direct, undefined, configuration(false), makeDoiRequester(), 10, delayedValidator);
      const pending = discovery.enrich([paper()]);
      await entered;
      await jest.advanceTimersByTimeAsync(10);
      const [enriched] = await pending;
      expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed' }));
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(direct).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a candidate when the bounded PDF body stalls and destroys the stream', async () => {
    jest.useFakeTimers();
    try {
      const destroy = jest.fn();
      const stalledBody: AsyncIterable<Buffer> & { destroy: jest.Mock } = {
        destroy,
        [Symbol.asyncIterator]: () => ({
          next: async () => new Promise<IteratorResult<Buffer>>(() => undefined),
          return: async () => ({ done: true, value: undefined })
        })
      };
      const requester = makeDoiRequester('https://publisher.example/article', stalledBody);
      const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/paper.pdf">PDF</a>'));
      const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester);
      const pending = discovery.enrich([paper()], { verifyPdf: true });
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(10000);
      const [enriched] = await pending;

      expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'oa_candidate',
        verification: expect.objectContaining({ status: 'inconclusive' })
      }));
      expect(destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects credential-bearing PDF redirect targets before probing them', async () => {
    const candidate = 'https://publisher.example/signed.pdf';
    const credentialTarget = 'https://cdn.example/signed.pdf?access_token=sentinel';
    const requester = {
      request: jest.fn(async (config: { url?: string }) => {
        const url = config.url || '';
        if (url.includes('doi.org')) return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
        if (url === candidate) return { status: 302, headers: { location: credentialTarget }, data: undefined };
        return { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-should-not-fetch') };
      })
    };
    const direct = jest.fn(async () => response('direct', 'direct', `<a href="${candidate}">PDF</a>`));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester as any);
    const [enriched] = await discovery.enrich([paper('10.1000/signed-redirect')], { verifyPdf: true });

    expect(enriched.pdfUrl).toBe(candidate);
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      verification: { status: 'failed', reason: 'restricted_target' }
    }));
    expect(requester.request.mock.calls.some(call => String(call[0].url).includes('access_token'))).toBe(false);
    expect(JSON.stringify(enriched)).not.toContain('sentinel');
  });

  it('keeps the candidate but rejects a PDF probe redirected to a login target', async () => {
    const requester = {
      request: jest.fn(async (config: { url?: string }) => {
        const url = config.url || '';
        if (url.includes('doi.org')) return { status: 302, headers: { location: 'https://publisher.example/article' }, data: undefined };
        if (url.endsWith('.pdf')) return { status: 302, headers: { location: 'https://login.publisher.example/sso' }, data: undefined };
        return { status: 200, headers: {}, data: undefined };
      })
    };
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/paper.pdf">PDF</a>'));
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), requester);
    const [enriched] = await discovery.enrich([paper()], { verifyPdf: true });

    expect(enriched.pdfUrl).toBe('https://publisher.example/paper.pdf');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({
      status: 'oa_candidate',
      verification: expect.objectContaining({ status: 'failed', reason: 'restricted_target' })
    }));
    expect(requester.request).toHaveBeenCalledTimes(3);
    expect(requester.request.mock.calls.some(call => (call[0].url || '').includes('login.publisher.example'))).toBe(false);
  });

  it('does not apply a late provider result after the discovery deadline', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const direct = jest.fn(async () => {
      started();
      await gate;
      return response('direct', 'direct', '<a href="https://publisher.example/late.pdf">PDF</a>');
    });
    const { discovery } = makeDiscovery(direct, undefined, configuration(false), makeDoiRequester(), 10);
    const pending = discovery.enrich([paper()]);
    await entered;
    const [enriched] = await pending;
    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed' }));

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(enriched.pdfUrl).toBe('');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('limits enrichment by result position without backfilling invalid DOI items', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/item.pdf">PDF</a>'));
    const { discovery, direct: directSpy } = makeDiscovery(direct);
    const papers = [paper(''), paper('10.1000/selected'), paper('10.1000/not-selected')];
    const enriched = await discovery.enrich(papers, { maxItems: 2 });

    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(enriched[0].extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'skipped', reason: 'invalid_doi' }));
    expect(enriched[1].extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate' }));
    expect(enriched[2].extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'skipped', reason: 'discovery_limit' }));
  });

  it('uses one shared operation and the deployment default for the first five positions', async () => {
    const original = process.env.ACCESS_DISCOVERY_MAX_ITEMS;
    process.env.ACCESS_DISCOVERY_MAX_ITEMS = '5';
    try {
      const contexts: RetrievalOperationContext[] = [];
      const direct = jest.fn(async (_request: RetrievalRequest, context: RetrievalOperationContext) => {
        contexts.push(context);
        return response('direct', 'direct', '<html><title>No public copy</title></html>');
      });
      const { discovery } = makeDiscovery(direct);
      const papers = Array.from({ length: 6 }, (_, index) => paper(`10.1000/${index + 1}`));
      const enriched = await discovery.enrich(papers);

      expect(direct).toHaveBeenCalledTimes(5);
      expect(new Set(contexts).size).toBe(1);
      expect(enriched[5].extra?.accessDiscovery).toEqual(expect.objectContaining({
        status: 'skipped',
        reason: 'discovery_limit'
      }));
    } finally {
      if (original === undefined) delete process.env.ACCESS_DISCOVERY_MAX_ITEMS;
      else process.env.ACCESS_DISCOVERY_MAX_ITEMS = original;
    }
  });

  it('limits the whole DOI pipeline to three concurrent items', async () => {
    let active = 0;
    let maximum = 0;
    const direct = jest.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return response('direct', 'direct', '<html><title>No public copy</title></html>');
    });
    const { discovery } = makeDiscovery(direct);
    const enriched = await discovery.enrich(
      Array.from({ length: 6 }, (_, index) => paper(`10.1000/concurrency-${index}`)),
      { maxItems: 6 }
    );

    expect(enriched).toHaveLength(6);
    expect(direct).toHaveBeenCalledTimes(6);
    expect(maximum).toBeLessThanOrEqual(3);
  });

  it('preserves an existing PDF source while adding evidence', async () => {
    const direct = jest.fn(async () => response('direct', 'direct', '<a href="https://publisher.example/new.pdf">PDF</a>'));
    const { discovery } = makeDiscovery(direct);
    const original = paper('10.1000/example', { pdfUrl: 'https://repository.example/original.pdf', source: 'repository' });
    const [enriched] = await discovery.enrich([original]);

    expect(enriched.pdfUrl).toBe('https://repository.example/original.pdf');
    expect(enriched.source).toBe('repository');
    expect(enriched.extra?.accessDiscovery).toEqual(expect.objectContaining({ status: 'oa_candidate' }));
  });
});
