import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  SciHubSearcher as BaseSciHubSearcher,
  extractMirrorUrls,
  extractPdfCandidates,
  normalizeSciHubInput,
  type SciHubSearcherOptions
} from '../../src/platforms/SciHubSearcher.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { ScrapingAntFetcher } from '../../src/services/ScrapingAntFetcher.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalResponse } from '../../src/retrieval/types.js';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import type { RetrievalStrategyStep } from '../../src/retrieval/RetrievalService.js';

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

const validateUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 }]
});

function healthResponse() {
  return { response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' }, finalUrl: 'https://mirror.example/' } as any;
}

function paidTestSecurityPolicy(): OutboundSecurityPolicy {
  return new OutboundSecurityPolicy({ validatePublicUrl: validateUrl });
}

function enablePaidRetrievalForCompatibilityAdapter(): void {
  process.env.SCRAPINGANT_API_KEY = 'test-api-key';
  process.env.SCRAPINGANT_ENABLED = 'true';
}

function sciHubOperation(): RetrievalOperationContext {
  const controller = new AbortController();
  return {
    operationId: 'scihub-test-operation',
    signal: controller.signal,
    deadlineAt: Date.now() + 120_000,
    remainingMs: () => 120_000,
    cost: {} as any
  };
}

function controlledSciHubOperation(): { operation: RetrievalOperationContext; controller: AbortController } {
  const controller = new AbortController();
  return {
    controller,
    operation: {
      operationId: 'scihub-controlled-operation',
      signal: controller.signal,
      deadlineAt: Date.now() + 120_000,
      remainingMs: () => 120_000,
      cost: {} as any
    }
  };
}

function sciHubResponse(
  strategy: 'direct' | 'static' | 'browser',
  html: string,
  targetStatus = 200
): RetrievalResponse {
  return {
    provider: strategy === 'direct' ? 'direct' : 'scrapingant',
    strategy,
    targetStatus,
    document: {
      kind: 'html',
      html,
      iframes: [],
      source: strategy === 'direct'
        ? { provenance: 'trusted_direct', finalUrl: 'https://sci-hub.se/10.1000/test' }
        : { provenance: 'unknown_remote', submittedUrl: 'https://sci-hub.se/10.1000/test' },
      targetStatus
    },
    cost: { known: true, credits: strategy === 'direct' ? 0 : 1 }
  };
}

function fakeSciHubService(
  dispatch: (strategy: 'direct' | 'static' | 'browser', url: string) => Promise<RetrievalResponse>
) {
  return {
    createOperation: jest.fn(() => sciHubOperation()),
    getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: true })),
    retrieveWithStrategies: jest.fn(async (steps: readonly RetrievalStrategyStep[], _operation: RetrievalOperationContext) => {
      let state: any = { attemptedStrategies: [] };
      let last: RetrievalResponse | undefined;
      for (const step of steps) {
        if (step.shouldAttempt && !(await step.shouldAttempt(state))) continue;
        try {
          const result = await dispatch(step.request.strategy, step.request.url);
          last = result;
          state = { ...state, previousResponse: result, previousError: undefined };
          if (step.isTerminalResponse && await step.isTerminalResponse(result, state) !== false) return result;
        } catch (error) {
          state = { ...state, previousResponse: undefined, previousError: error };
          if (!step.continueOnError || !(await step.continueOnError(error as any, state))) throw error;
        }
      }
      if (last) return last;
      throw new Error('No fake Sci-Hub strategy completed');
    })
  } as any;
}

function healthyMirrorRequest() {
  return {
    request: jest.fn(async (_url: string, _config: any) => ({
      response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
      finalUrl: _url
    } as any))
  };
}

describe('SciHub controlled adapter', () => {
  it('shares a health producer while allowing one waiter to cancel', async () => {
    let resolveResponse!: (value: any) => void;
    let resolveStarted!: () => void;
    let requestCount = 0;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const response = new Promise<any>(resolve => { resolveResponse = resolve; });
    const healthHttpClient = {
      request: jest.fn(async () => {
        requestCount++;
        if (requestCount === 5) resolveStarted();
        return response;
      })
    };
    const searcher = new SciHubSearcher({
      enabled: true,
      healthHttpClient,
      healthCheckConcurrency: 5,
      validateUrl
    });
    const first = new AbortController();
    const second = new AbortController();

    const firstWaiter = searcher.forceHealthCheck(first.signal);
    const secondWaiter = searcher.forceHealthCheck(second.signal);
    await started;
    first.abort();
    await expect(firstWaiter).rejects.toThrow(/aborted/i);
    resolveResponse({ response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' }, finalUrl: 'https://mirror.example/' });
    await secondWaiter;

    expect(requestCount).toBe(5);
    expect(searcher.getStatus().healthCheckedAt).toBeDefined();
    expect(searcher.getMirrorStatus().every(mirror => mirror.status === 'working')).toBe(true);
  });

  it('does not publish a health snapshot when the last waiter cancels', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const healthHttpClient = {
      request: jest.fn(async (_url: string, config: any) => {
        resolveStarted();
        await new Promise<never>((_resolve, reject) => {
          config.signal.addEventListener('abort', () => {
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      })
    };
    const searcher = new SciHubSearcher({
      enabled: true,
      healthHttpClient: healthHttpClient as any,
      healthCheckConcurrency: 1,
      validateUrl
    });
    const controller = new AbortController();
    const waiter = searcher.forceHealthCheck(controller.signal);
    await started;
    controller.abort();
    await expect(waiter).rejects.toThrow(/aborted/i);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(searcher.getStatus().healthCheckedAt).toBeUndefined();
    expect(searcher.getMirrorStatus().every(mirror => mirror.status === 'not_checked')).toBe(true);
  });

  it('lets a new waiter replace an abandoned flight and ignores its late completion', async () => {
    let resolveOld!: (value: any) => void;
    let requestCount = 0;
    const oldResponse = new Promise<any>(resolve => { resolveOld = resolve; });
    const healthHttpClient = {
      request: jest.fn(async (url: string) => {
        requestCount++;
        if (requestCount === 1) return oldResponse;
        return {
          response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
          finalUrl: url
        } as any;
      })
    };
    const searcher = new SciHubSearcher({
      enabled: true,
      healthHttpClient,
      healthCheckConcurrency: 1,
      validateUrl
    });
    const abandoned = new AbortController();
    const abandonedWaiter = searcher.forceHealthCheck(abandoned.signal);
    await new Promise<void>(resolve => {
      const waitForHealthRequest = () => {
        if (requestCount > 0) {
          resolve();
          return;
        }
        setImmediate(waitForHealthRequest);
      };
      waitForHealthRequest();
    });
    abandoned.abort();
    await expect(abandonedWaiter).rejects.toThrow(/aborted/i);

    await searcher.forceHealthCheck();
    expect(requestCount).toBe(6);
    expect(searcher.getStatus().healthCheckedAt).toBeDefined();
    expect(searcher.getMirrorStatus().every(mirror => mirror.status === 'working')).toBe(true);

    resolveOld({ response: { status: 500, headers: {}, data: '<html>late old result</html>' }, finalUrl: 'https://mirror.example/' });
    await Promise.resolve();
    await Promise.resolve();
    expect(searcher.getMirrorStatus().every(mirror => mirror.status === 'working')).toBe(true);
  });

  it('bounds a stalled health producer and permits a replacement flight', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      let stalled = true;
      const healthHttpClient = {
        request: jest.fn(async (url: string) => {
          if (stalled) return new Promise<any>(() => undefined);
          return {
            response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
            finalUrl: url
          } as any;
        })
      };
      const searcher = new SciHubSearcher({ enabled: true, healthHttpClient, validateUrl });
      const stalledWaiter = searcher.forceHealthCheck();
      const stalledResult = expect(stalledWaiter).rejects.toMatchObject({ code: 'timeout' });
      await jest.advanceTimersByTimeAsync(120_000);
      await stalledResult;
      expect(searcher.getStatus().healthCheckedAt).toBeUndefined();

      stalled = false;
      await searcher.forceHealthCheck();
      expect(searcher.getStatus().healthCheckedAt).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes only after the strict health-check TTL', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(0);
      const healthHttpClient = {
        request: jest.fn(async (url: string) => ({
          response: { status: 200, headers: {}, data: '<html>Sci-Hub mirror</html>' },
          finalUrl: url
        } as any))
      };
      const searcher = new SciHubSearcher({ enabled: true, healthHttpClient, validateUrl });

      await (searcher as any).checkMirrorHealth(false);
      expect(healthHttpClient.request).toHaveBeenCalledTimes(5);
      jest.setSystemTime(300_000);
      await (searcher as any).checkMirrorHealth(false);
      expect(healthHttpClient.request).toHaveBeenCalledTimes(5);
      jest.setSystemTime(300_001);
      await (searcher as any).checkMirrorHealth(false);
      expect(healthHttpClient.request).toHaveBeenCalledTimes(10);
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts only DOI forms and resolves relative PDF sources', () => {
    expect(normalizeSciHubInput('doi:10.1000/test')).toBe('10.1000/test');
    expect(normalizeSciHubInput('https://doi.org/10.1000/test')).toBe('10.1000/test');
    expect(() => normalizeSciHubInput('https://publisher.example/paper')).toThrow(/only a DOI/i);
    expect(extractPdfCandidates('<iframe src="/files/paper.pdf"></iframe>', 'https://mirror.example/10.1000/test')).toEqual([
      'https://mirror.example/files/paper.pdf'
    ]);
  });

  it('parses only mirror entries from each default directory layout', () => {
    expect(extractMirrorUrls(`
      <nav><a href="/mirrors">Mirrors</a></nav>
      <main>
        <a href="https://sci-hub.run/" target="_blank" title="Visit mirror">Visit mirror</a>
        <a href="https://ads.example/" target="_blank" title="Sponsored link">Sponsored link</a>
      </main>
    `, 'https://sci-hub.mobi/en/mirrors')).toEqual(['https://sci-hub.run']);
    expect(extractMirrorUrls(`
      <table class="scholar-table"><tbody>
        <tr><td class="url-cell"><a href="https://sci-hub.jp/">https://sci-hub.jp</a></td></tr>
        <tr><td><a href="https://not-a-mirror.example/">ignored</a></td></tr>
      </tbody></table>
    `, 'https://www.ooopn.com/tool/scihub/')).toEqual(['https://sci-hub.jp']);
  });

  it('discovers both default directories and keeps comma-separated env mirrors as supplements', async () => {
    process.env.SCIHUB_MIRRORS = 'https://configured.example, https://sci-hub.se';
    const healthUrls: string[] = [];
    const searcher = new SciHubSearcher({
      enabled: true,
      healthHttpClient: {
        request: jest.fn(async (url: string) => {
          healthUrls.push(url);
          return healthResponse();
        })
      },
      validateUrl
    });

    await searcher.forceHealthCheck();

    expect(new Set(healthUrls)).toEqual(new Set([
      'https://configured.example',
      'https://sci-hub.se',
      'https://sci-hub.st',
      'https://sci-hub.ru',
      'https://sci-hub.red',
      'https://sci-hub.box'
    ]));
    expect(searcher.getMirrorStatus()).toHaveLength(6);
  });

  it('keeps configured mirrors usable when both default directories fail', async () => {
    const discovery = {
      request: jest.fn(async () => {
        throw new Error('directory unavailable');
      })
    };
    const health = healthyMirrorRequest();
    const searcher = new SciHubSearcher({
      enabled: true,
      mirrors: ['https://configured.example'],
      mirrorDiscoveryHttpClient: discovery,
      healthHttpClient: health,
      validateUrl
    });

    await searcher.forceHealthCheck();

    expect(discovery.request).toHaveBeenCalledTimes(2);
    expect(health.request).toHaveBeenCalledTimes(1);
    expect(searcher.getMirrorStatus().map(mirror => mirror.url)).toEqual(['https://configured.example']);
  });

  it('uses a successful default directory when the other source fails', async () => {
    const discovery = {
      request: jest.fn(async (url: string) => {
        if (url.includes('ooopn.com')) throw new Error('directory unavailable');
        return {
          response: { status: 200, headers: {}, data: TEST_MIRROR_DIRECTORY_HTML },
          finalUrl: url
        } as any;
      })
    };
    const searcher = new SciHubSearcher({
      enabled: true,
      mirrorDiscoveryHttpClient: discovery,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await searcher.forceHealthCheck();

    expect(searcher.getMirrorStatus().map(mirror => mirror.url)).toEqual([
      'https://sci-hub.se',
      'https://sci-hub.st',
      'https://sci-hub.ru',
      'https://sci-hub.red'
    ]);
  });

  it('retains the last successful source list when a refresh returns no mirrors', async () => {
    let requestCount = 0;
    const discovery = {
      request: jest.fn(async (url: string) => {
        requestCount++;
        const data = requestCount <= 2
          ? url.includes('ooopn.com') ? TEST_OOOPN_DIRECTORY_HTML : TEST_MIRROR_DIRECTORY_HTML
          : '<main><p>No mirror entries</p></main>';
        return { response: { status: 200, headers: {}, data }, finalUrl: url } as any;
      })
    };
    const searcher = new SciHubSearcher({
      enabled: true,
      mirrorDiscoveryHttpClient: discovery,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await searcher.forceHealthCheck();
    const firstSnapshot = searcher.getMirrorStatus().map(mirror => mirror.url);
    await searcher.forceHealthCheck();

    expect(searcher.getMirrorStatus().map(mirror => mirror.url)).toEqual(firstSnapshot);
  });

  it('does not publish a late mirror discovery after cancellation', async () => {
    const resolvers: Array<(value: any) => void> = [];
    const discovery = {
      request: jest.fn(() => new Promise<any>(resolve => { resolvers.push(resolve); }))
    };
    const searcher = new SciHubSearcher({
      enabled: true,
      mirrorDiscoveryHttpClient: discovery,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });
    const controller = new AbortController();
    const pending = searcher.forceHealthCheck(controller.signal);
    await new Promise<void>(resolve => {
      const waitForSources = () => resolvers.length === 2 ? resolve() : setImmediate(waitForSources);
      waitForSources();
    });

    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    resolvers.forEach(resolve => resolve({
      response: { status: 200, headers: {}, data: TEST_MIRROR_DIRECTORY_HTML },
      finalUrl: 'https://sci-hub.mobi/en/mirrors'
    }));
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(searcher.getMirrorStatus()).toEqual([]);
    expect(searcher.getStatus().healthCheckedAt).toBeUndefined();
  });

  it('searches discovered defaults when SCIHUB_ENABLED is the only Sci-Hub configuration', async () => {
    process.env.SCIHUB_ENABLED = 'true';
    delete process.env.SCIHUB_MIRRORS;
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      '<a href="https://cdn.example/discovered.pdf">PDF</a>'
    ));
    const searcher = new SciHubSearcher({
      fetchMode: 'direct',
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    expect(searcher.getCapabilities().search).toBe(true);
    await expect(searcher.search('10.1000/discovered')).resolves.toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/discovered.pdf' })
    ]);
    expect(service.retrieveWithStrategies).toHaveBeenCalled();
  });

  it('does not call ScrapingAnt for a direct not_found result', async () => {
    const request = jest.fn(async (url: string, _config: any) => {
      if (new URL(url).pathname === '/') return healthResponse();
      return { response: { status: 404, headers: {}, data: '' }, finalUrl: url } as any;
    });
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: jest.fn(async (_config: any) => ({ status: 200, headers: {}, data: {} }) as any) as any },
      validateUrl,
      sleep: async () => undefined
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request },
      scrapingAntFetcher: scraper,
      validateUrl
    });

    await expect(searcher.search('10.1000/not-found')).resolves.toEqual([]);
    expect(scraper.getStatus().requestCount).toBe(0);
    expect(searcher.getStatus().lastLookupStatus).toBe('not_found');
  });

  it('uses a bounded ScrapingAnt fallback when direct health checks are blocked and accepts iframe src-only results', async () => {
    const directRequest = jest.fn(async (url: string, _config: any) => {
      return { response: { status: url.endsWith('/') ? 200 : 500, headers: {}, data: '' }, finalUrl: url } as any;
    });
    const scraperRequest = jest.fn(async (_config: any) => ({
      status: 200,
      headers: { 'Ant-credits-cost': '1' },
      data: { html: '<html>blocked</html>', iframes: [{ src: 'https://cdn.example/fallback.pdf', html: '' }] }
    }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest as any },
      validateUrl,
      sleep: async () => undefined
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      fetchMode: 'fallback',
      publicHttpClient: { request: directRequest },
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });

    const fallbackResult = await searcher.search('10.1000/fallback');
    expect(fallbackResult).toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/fallback.pdf' })
    ]);
    expect(scraperRequest).toHaveBeenCalledTimes(1);
    const healthCallCount = directRequest.mock.calls.length;
    await searcher.search('10.1000/fallback-again');
    expect(directRequest.mock.calls.length).toBeGreaterThan(healthCallCount);
    expect(directRequest.mock.calls.slice(0, healthCallCount).filter((call: any[]) => new URL(call[0]).pathname === '/').length).toBe(5);
    expect(directRequest.mock.calls.slice(healthCallCount).filter((call: any[]) => new URL(call[0]).pathname === '/').length).toBe(0);
  });

  it('prefers a PDF embedded in a viewer iframe over the viewer URL itself', async () => {
    const directRequest = jest.fn(async (_url: string, _config: any) => ({
      response: { status: 500, headers: {}, data: '' },
      finalUrl: _url
    } as any));
    const scraperRequest = jest.fn(async (_config: any) => ({
      status: 200,
      headers: {},
      data: {
        html: '<html><iframe src="https://viewer.example/frame"></iframe></html>',
        iframes: [{
          src: 'https://viewer.example/frame',
          html: '<embed type="application/pdf" src="https://cdn.example/actual.pdf">'
        }]
      }
    }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest } as any,
      validateUrl,
      maxRetries: 0,
      sleep: async () => undefined
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request: directRequest },
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });

    const viewerResult = await searcher.search('10.1000/viewer');
    expect(viewerResult).toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/actual.pdf' })
    ]);
    expect(scraperRequest).toHaveBeenCalledTimes(1);
  });

  it('reconciles late compatibility credits after a cancelled Sci-Hub lookup', async () => {
    const directRequest = jest.fn(async (_url: string, _config: any) => ({
      response: { status: 500, headers: {}, data: '' },
      finalUrl: _url
    } as any));
    let resolveScraper!: (response: any) => void;
    let scraperStarted!: () => void;
    const scraperEntered = new Promise<void>(resolve => { scraperStarted = resolve; });
    const scraperRequest = jest.fn(() => new Promise<any>(resolve => {
      resolveScraper = resolve;
      scraperStarted();
    }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest } as any,
      validateUrl
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request: directRequest },
      healthHttpClient: healthyMirrorRequest(),
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });
    const service = (searcher as any).retrievalService as import('../../src/retrieval/RetrievalService.js').RetrievalService;
    const operation = service.createOperation();
    try {
      const pending = searcher.search('10.1000/late-compatibility', { operationContext: operation });
      await scraperEntered;
      operation.dispose();
      expect(operation.signal.aborted).toBe(true);
      await expect(pending).resolves.toEqual([]);

      resolveScraper({ status: 200, headers: { 'Ant-credits-cost': '1' }, data: { html: '<html />' } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        admissionUsed: 1,
        reportedCredits: 1,
        reportedCreditsKnown: true,
        unknownCostAttempts: 0,
        paidClosed: false
      }));
      expect(scraperRequest).toHaveBeenCalledTimes(1);
    } finally {
      operation.dispose();
    }
  });

  it('does not escalate a ScrapingAnt API error to a paid browser attempt', async () => {
    const directRequest = jest.fn(async (_url: string, _config: any) => ({
      response: { status: 500, headers: {}, data: '' },
      finalUrl: _url
    } as any));
    const scraperRequest = jest.fn(async (_config: any) => ({ status: 500, headers: {}, data: {} }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest } as any,
      validateUrl,
      maxRetries: 0,
      sleep: async () => undefined
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request: directRequest },
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });

    await expect(searcher.search('10.1000/api-error')).resolves.toEqual([]);
    expect(scraperRequest).toHaveBeenCalledTimes(3);
    expect(scraperRequest.mock.calls.every((call: any[]) => call[0].params.browser === false)).toBe(true);
  });

  it('preserves a compatibility security failure and does not traverse another mirror', async () => {
    const directRequest = jest.fn(async (_url: string, _config: any) => ({
      response: { status: 500, headers: {}, data: '' },
      finalUrl: _url
    } as any));
    const scraperRequest = jest.fn(async (_config: any) => ({ status: 200, headers: {}, data: {} }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest } as any,
      validateUrl: async () => { throw new Error('private target'); }
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request: directRequest },
      healthHttpClient: healthyMirrorRequest(),
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });

    await expect(searcher.search('10.1000/compat-security')).resolves.toEqual([]);
    expect(scraperRequest).not.toHaveBeenCalled();
    expect(searcher.getStatus().lastLookupStatus).toBe('blocked');
    expect(searcher.getMirrorStatus().every(mirror => mirror.failureCount === 0)).toBe(true);
  });

  it('rejects failing page statuses and recognizes an HTML not-found response', async () => {
    const directRequest = jest.fn(async (url: string, _config: any) => ({
      response: { status: 500, headers: {}, data: '' },
      finalUrl: url
    } as any));
    const scraperRequest = jest.fn(async (config: any) => ({
      status: 200,
      headers: {},
      data: config.params.url.includes('page-error')
        ? { status_code: 500, html: '<iframe src="https://cdn.example/should-not-be-used.pdf"></iframe>' }
        : { html: '<html>Article not found</html>' }
    }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest } as any,
      validateUrl,
      maxRetries: 0,
      sleep: async () => undefined
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request: directRequest },
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });

    await expect(searcher.search('10.1000/page-error')).resolves.toEqual([]);
    await expect(searcher.search('10.1000/html-not-found')).resolves.toEqual([]);
    expect(scraperRequest.mock.calls.some((call: any[]) => call[0].params.browser === true)).toBe(false);
  });

  it('cancels while the download client target validation is pending', async () => {
    const pdfUrl = 'https://cdn.example/cancelled-client-validation.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    let releaseValidation!: (value: any) => void;
    let validationStarted!: () => void;
    const enteredValidation = new Promise<void>(resolve => { validationStarted = resolve; });
    const stalledValidation = new Promise<any>(resolve => { releaseValidation = resolve; });
    const downloadValidation = jest.fn(async (_url: string) => {
      validationStarted();
      return stalledValidation;
    });
    const downloadRequest = jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      data: Buffer.from('%PDF-safe')
    }));
    const downloadHttpClient = new PublicHttpClient({
      client: { request: downloadRequest },
      validateUrl: downloadValidation
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient,
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-cancel-client-validation-'));
    const { operation, controller } = controlledSciHubOperation();
    try {
      const pending = searcher.downloadPdf('10.1000/cancel-client-validation', {
        savePath: directory,
        operationContext: operation
      });
      await enteredValidation;
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: 'cancelled',
        message: 'Retrieval operation was cancelled'
      });

      releaseValidation({
        url: pdfUrl,
        hostname: 'cdn.example',
        addresses: [{ address: '93.184.216.34', family: 4 }]
      });
      await Promise.resolve();
      expect(downloadRequest).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds an uncooperative download request and disposes a late response', async () => {
    const pdfUrl = 'https://cdn.example/late-download.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    let releaseDownload!: (value: any) => void;
    let downloadStarted!: () => void;
    const response = new Promise<any>(resolve => { releaseDownload = resolve; });
    const started = new Promise<void>(resolve => { downloadStarted = resolve; });
    const body = { destroy: jest.fn() };
    const download = jest.fn(async () => {
      downloadStarted();
      return response;
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-timeout-download-'));
    const controller = new AbortController();
    let remainingMs = 120_000;
    let timedOut = false;
    const operation = {
      operationId: 'scihub-timeout-download-operation',
      signal: controller.signal,
      deadlineAt: Date.now() + 120_000,
      remainingMs: () => remainingMs,
      timedOut: () => timedOut,
      cost: {} as any
    } as RetrievalOperationContext;
    try {
      const pending = searcher.downloadPdf('10.1000/timeout-download', {
        savePath: directory,
        operationContext: operation
      });
      await started;
      timedOut = true;
      remainingMs = 0;
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: 'timeout',
        message: 'Retrieval operation timed out'
      });

      releaseDownload({
        response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: body },
        finalUrl: pdfUrl
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(body.destroy).toHaveBeenCalled();
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels while validating the download target before dispatch', async () => {
    const pdfUrl = 'https://cdn.example/cancelled-validation.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    let validationCount = 0;
    let validationStarted!: () => void;
    const enteredValidation = new Promise<void>(resolve => { validationStarted = resolve; });
    const validator = jest.fn(async (url: string) => {
      if (url === pdfUrl && validationCount++ === 1) {
        validationStarted();
        return new Promise<any>(() => undefined);
      }
      return validateUrl(url);
    });
    const download = jest.fn(async () => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-no') },
      finalUrl: pdfUrl
    } as any));
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl: validator
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-cancel-validation-'));
    const { operation, controller } = controlledSciHubOperation();
    try {
      const pending = searcher.downloadPdf('10.1000/cancel-validation', {
        savePath: directory,
        operationContext: operation
      });
      await enteredValidation;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      expect(download).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels a download during streaming and removes the temporary file', async () => {
    const pdfUrl = 'https://cdn.example/cancelled.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    let emitted = false;
    const body = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push(Buffer.from('%PDF-'));
        resolveStarted();
      }
    });
    const download = jest.fn(async () => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: body },
      finalUrl: pdfUrl
    } as any));
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-cancel-stream-'));
    const { operation, controller } = controlledSciHubOperation();
    try {
      const pending = searcher.downloadPdf('10.1000/cancel-stream', {
        savePath: directory,
        operationContext: operation
      });
      await started;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      const names = fs.readdirSync(directory);
      expect(names.some(name => name.endsWith('.pdf'))).toBe(false);
      expect(names.some(name => name.includes('.tmp-'))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not publish after cancellation at the pre-publication filesystem boundary', async () => {
    const pdfUrl = 'https://cdn.example/cancelled-before-link.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    const download = jest.fn(async () => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-safe') },
      finalUrl: pdfUrl
    } as any));
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-cancel-link-'));
    const { operation, controller } = controlledSciHubOperation();
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let lstatCount = 0;
    let releasePublicationCheck!: () => void;
    let publicationCheckStarted!: () => void;
    const publicationCheck = new Promise<void>(resolve => { releasePublicationCheck = resolve; });
    const publicationCheckReady = new Promise<void>(resolve => { publicationCheckStarted = resolve; });
    const lstat = jest.spyOn(fs.promises, 'lstat').mockImplementation(async filePath => {
      lstatCount++;
      if (lstatCount === 2) {
        publicationCheckStarted();
        await publicationCheck;
      }
      return originalLstat(filePath);
    });
    const link = jest.spyOn(fs.promises, 'link');
    const rename = jest.spyOn(fs.promises, 'rename');
    try {
      const pending = searcher.downloadPdf('10.1000/cancel-link', {
        savePath: directory,
        operationContext: operation
      });
      await publicationCheckReady;
      controller.abort();
      releasePublicationCheck();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      expect(link).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(fs.readdirSync(directory).some(name => name.endsWith('.pdf'))).toBe(false);
      expect(fs.readdirSync(directory).some(name => name.includes('.tmp-'))).toBe(false);
    } finally {
      lstat.mockRestore();
      link.mockRestore();
      rename.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses atomic no-clobber publication for concurrent downloads', async () => {
    const pdfUrl = 'https://cdn.example/concurrent.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    let downloadCount = 0;
    const download = jest.fn(async () => {
      downloadCount++;
      return {
        response: {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
          data: Buffer.from(`%PDF-${downloadCount}`)
        },
        finalUrl: pdfUrl
      } as any;
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-concurrent-'));
    const originalLink = fs.promises.link.bind(fs.promises);
    let linkCount = 0;
    let releaseLinks!: () => void;
    const linksReady = new Promise<void>(resolve => { releaseLinks = resolve; });
    const link = jest.spyOn(fs.promises, 'link').mockImplementation(async (oldPath, newPath) => {
      linkCount++;
      if (linkCount === 2) releaseLinks();
      await linksReady;
      return originalLink(oldPath, newPath);
    });
    const rename = jest.spyOn(fs.promises, 'rename');
    try {
      const results = await Promise.all([
        searcher.downloadPdf('10.1000/concurrent', { savePath: directory }),
        searcher.downloadPdf('10.1000/concurrent', { savePath: directory })
      ]);
      const filePath = path.join(directory, '10.1000_concurrent.pdf');
      expect(results).toEqual([filePath, filePath]);
      expect(linkCount).toBe(2);
      expect(rename).not.toHaveBeenCalled();
      expect(['%PDF-1', '%PDF-2']).toContain(fs.readFileSync(filePath, 'utf8'));
      expect(fs.readdirSync(directory).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally {
      link.mockRestore();
      rename.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('validates PDF magic/size and atomically writes a download', async () => {
    const pdfUrl = 'https://cdn.example/paper.pdf';
    const request = jest.fn(async (url: string, _config: any) => {
      if (new URL(url).pathname === '/') return healthResponse();
      if (url.includes('/10.1000/test')) {
        return {
          response: { status: 200, headers: {}, data: `<html><title>Paper</title><iframe src="${pdfUrl}"></iframe></html>` },
          finalUrl: url
        } as any;
      }
      return {
        response: { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '9' }, data: Buffer.from('%PDF-test') },
        finalUrl: url
      } as any;
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      fetchMode: 'direct',
      publicHttpClient: { request },
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-test-'));
    try {
      const filePath = await searcher.downloadPdf('10.1000/test', { savePath: directory });
      expect(fs.readFileSync(filePath).subarray(0, 5).toString()).toBe('%PDF-');
      expect(fs.readdirSync(directory).filter(name => name.includes('.tmp-'))).toEqual([]);

      fs.writeFileSync(filePath, 'previous valid PDF');
      await expect(searcher.downloadPdf('10.1000/test', { savePath: directory, overwrite: true }))
        .resolves.toBe(filePath);
      expect(fs.readFileSync(filePath).subarray(0, 5).toString()).toBe('%PDF-');
      expect(fs.readdirSync(directory).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an existing dangling symlink before an overwrite download', async () => {
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      '<a href="https://cdn.example/dangling.pdf">PDF</a>'
    ));
    const download = jest.fn(async () => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-new') },
      finalUrl: 'https://cdn.example/dangling.pdf'
    } as any));
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-dangling-link-'));
    const filePath = path.join(directory, '10.1000_dangling.pdf');
    let symlinkCreated = false;
    try {
      try {
        fs.symlinkSync(path.join(directory, 'missing.pdf'), filePath, 'file');
        symlinkCreated = true;
      } catch (error: any) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
        jest.spyOn(fs.promises, 'lstat').mockResolvedValueOnce({
          isSymbolicLink: () => true,
          isFile: () => false
        } as fs.Stats);
      }
      await expect(searcher.downloadPdf('10.1000/dangling', {
        savePath: directory,
        overwrite: true
      })).rejects.toThrow(/symbolic-link/i);
      if (symlinkCreated) expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
      expect(download).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses neutral retrieval and permits one bounded public fallback for target not-found', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async (strategy) => {
      strategies.push(strategy);
      return sciHubResponse(strategy, '', 404);
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/not-found')).resolves.toEqual([]);
    expect(strategies).toEqual(['direct', 'static']);
  });

  it.each([423, 429])('keeps restricted target status %s on the direct path without crossing mirrors or paid fallback', async targetStatus => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async (strategy) => {
      strategies.push(strategy);
      return sciHubResponse(strategy, '<iframe src="https://cdn.example/paper.pdf"></iframe>', targetStatus);
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search(`10.1000/restricted-${targetStatus}`)).resolves.toEqual([]);
    expect(strategies).toEqual(['direct']);
  });

  it.each([200, 404, 503])('does not escalate an iframe challenge with target status %s', async targetStatus => {
    const strategies: string[] = [];
    const base = sciHubResponse('direct', '<html>ordinary page</html>', targetStatus);
    const response = {
      ...base,
      document: {
        ...base.document!,
        iframes: [{
          src: 'https://viewer.example/frame',
          html: '<html>CAPTCHA verification required</html>',
          source: { provenance: 'unknown_remote' as const, submittedUrl: 'https://sci-hub.se/10.1000/iframe-challenge' }
        }]
      }
    } satisfies RetrievalResponse;
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      return response;
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search(`10.1000/iframe-challenge-${targetStatus}`)).resolves.toEqual([]);
    expect(strategies).toEqual(targetStatus === 404
      ? ['direct', 'static']
      : ['direct']);
  });

  it('gives restriction evidence precedence over a PDF candidate', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      return sciHubResponse(strategy, '<html>Access denied <a href="https://cdn.example/leak.pdf">PDF</a></html>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/restricted-body')).resolves.toEqual([]);
    expect(strategies).toEqual(['direct']);
    expect(searcher.getMirrorStatus().every(mirror => mirror.failureCount === 0)).toBe(true);
  });

  it('prioritizes successful not-found text over iframe PDF evidence', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      return sciHubResponse(strategy, '<html>Article not found <iframe src="https://cdn.example/leak.pdf"></iframe></html>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/not-found-body')).resolves.toEqual([]);
    expect(strategies).toEqual(['direct', 'static']);
  });

  it('does not use an ordinary iframe or unknown status to authorize browser escalation', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      const result = sciHubResponse(strategy, '<iframe src="https://viewer.example/frame"></iframe>');
      return strategy === 'direct'
        ? { ...result, targetStatus: undefined, document: { ...result.document!, targetStatus: undefined } }
        : result;
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/unknown-status')).resolves.toEqual([]);
    expect(strategies).toHaveLength(5);
    expect(strategies).toEqual(['direct', 'direct', 'direct', 'direct', 'direct']);
  });

  it('escalates a direct approved empty pdf container through static and browser', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      if (strategy === 'direct' || strategy === 'static') return sciHubResponse(strategy, '<div id="pdf"></div><script src="/viewer.js"></script>');
      return sciHubResponse(strategy, '<a href="https://cdn.example/direct-container.pdf">PDF</a>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/direct-container')).resolves.toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/direct-container.pdf' })
    ]);
    expect(strategies).toEqual(['direct', 'static', 'browser']);
  });

  it('authorizes browser only for the empty pdf container plus script shape', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      if (strategy === 'direct') return sciHubResponse(strategy, '<iframe src="https://viewer.example/initial"></iframe>');
      if (strategy === 'static') return sciHubResponse(strategy, '<div id="pdf">  </div><script src="/viewer.js"></script>');
      return sciHubResponse(strategy, '<a href="https://cdn.example/browser-container.pdf">PDF</a>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/positive-container')).resolves.toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/browser-container.pdf' })
    ]);
    expect(strategies).toEqual(['direct', 'static', 'browser']);
  });

  it('authorizes browser only for a pdf-viewer iframe with a safe data source', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      if (strategy === 'direct') return sciHubResponse(strategy, '<iframe src="https://viewer.example/initial"></iframe>');
      if (strategy === 'static') return sciHubResponse(strategy, '<iframe class="reader pdf-viewer" data-src="https://viewer.example/frame.pdf"></iframe>');
      return sciHubResponse(strategy, '<a href="https://cdn.example/browser-frame.pdf">PDF</a>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/positive-iframe')).resolves.toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/browser-frame.pdf' })
    ]);
    expect(strategies).toEqual(['direct', 'static', 'browser']);
  });

  it('allows a trusted-direct relative iframe data source after resolution', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      if (strategy === 'direct') return sciHubResponse(strategy, '<iframe class="pdf-viewer" data-src="/paper.pdf"></iframe>');
      return sciHubResponse(strategy, '<a href="https://cdn.example/trusted-relative.pdf">PDF</a>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/trusted-relative')).resolves.toEqual([
      expect.objectContaining({ pdfUrl: 'https://cdn.example/trusted-relative.pdf' })
    ]);
    expect(strategies).toEqual(['direct', 'static']);
  });

  it('does not let an empty iframe with an unsafe data source authorize paid retrieval', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      return sciHubResponse(strategy, '<iframe id="pdf" data-src="http://127.0.0.1/view"></iframe><script src="/viewer.js"></script>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/unsafe-iframe')).resolves.toEqual([]);
    expect(strategies).toEqual(['direct', 'direct', 'direct', 'direct', 'direct']);
  });

  it.each([
    'http://127.0.0.1/view',
    '/relative/view'
  ])('does not authorize browser for an unsafe or unknown-source data source %s', async dataSrc => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      if (strategy === 'direct') return sciHubResponse(strategy, '<iframe src="https://viewer.example/initial"></iframe>');
      return sciHubResponse(strategy, `<iframe class="pdf-viewer" data-src="${dataSrc}"></iframe>`);
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/unsafe-or-unknown-source')).resolves.toEqual([]);
    expect(strategies).toEqual(['direct', 'static', 'direct', 'static', 'direct', 'static', 'direct', 'static', 'direct', 'static']);
    expect(strategies).not.toContain('browser');
  });

  it('does not authorize browser for an incomplete positive marker', async () => {
    const strategies: string[] = [];
    const service = fakeSciHubService(async strategy => {
      strategies.push(strategy);
      return sciHubResponse(strategy, '<div id="pdf"></div>');
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/incomplete-marker')).resolves.toEqual([]);
    expect(strategies).toHaveLength(10);
    expect(strategies).not.toContain('browser');
  });

  it('does not resolve a relative iframe source from a legacy remote response', async () => {
    const directRequest = jest.fn(async (url: string) => ({
      response: { status: url.endsWith('/') ? 200 : 500, headers: {}, data: '' },
      finalUrl: url
    } as any));
    const scraperRequest = jest.fn(async () => ({
      status: 200,
      headers: { 'Ant-credits-cost': '1' },
      data: { html: '<html>viewer</html>', iframes: [{ src: '/relative.pdf', html: '' }] }
    }));
    const scraper = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: scraperRequest } as any,
      validateUrl,
      maxRetries: 0,
      sleep: async () => undefined
    });
    enablePaidRetrievalForCompatibilityAdapter();
    const searcher = new SciHubSearcher({
      enabled: true,
      publicHttpClient: { request: directRequest },
      scrapingAntFetcher: scraper,
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });

    await expect(searcher.search('10.1000/relative-iframe')).resolves.toEqual([]);
    expect(scraperRequest).toHaveBeenCalled();
    expect(scraperRequest.mock.calls.every((call: any[]) => call[0].params.browser === false)).toBe(true);
  });

  it('terminates the lookup chain on a response resource failure without changing mirrors', async () => {
    const strategies: string[] = [];
    const service = {
      createOperation: jest.fn(() => sciHubOperation()),
      getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: true })),
      retrieveWithStrategies: jest.fn(async () => {
        strategies.push('direct');
        throw new RetrievalError({ code: 'response_too_large', message: 'bounded response rejected', provider: 'direct' });
      })
    } as any;
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/oversized')).resolves.toEqual([]);
    expect(strategies).toEqual(['direct']);
    expect(searcher.getMirrorStatus().every(mirror => mirror.failureCount === 0)).toBe(true);
  });

  it('does not count a paid provider failure as a mirror health failure', async () => {
    const service = {
      createOperation: jest.fn(() => sciHubOperation()),
      getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: true })),
      retrieveWithStrategies: jest.fn(async () => {
        throw new RetrievalError({ code: 'network', message: 'paid provider unavailable', provider: 'scrapingant', retryable: true });
      })
    } as any;
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      validateUrl
    });

    await expect(searcher.search('10.1000/provider-failure')).resolves.toEqual([]);
    expect(searcher.getMirrorStatus().every(mirror => mirror.failureCount === 0)).toBe(true);
  });

  it('uses static fallback for a dynamic mirror and shares lookup context with download', async () => {
    const strategies: string[] = [];
    const contexts: RetrievalOperationContext[] = [];
    const service = fakeSciHubService(async (strategy, url) => {
      strategies.push(strategy);
      return strategy === 'direct'
        ? sciHubResponse(strategy, '<iframe src="https://viewer.example/frame"></iframe>')
        : sciHubResponse(strategy, '<a href="https://cdn.example/paper.pdf">PDF</a>');
    });
    const originalRetrieve = service.retrieveWithStrategies;
    service.retrieveWithStrategies = jest.fn(async (steps: readonly RetrievalStrategyStep[], operation: RetrievalOperationContext, options?: any) => {
      contexts.push(operation);
      return originalRetrieve(steps, operation, options);
    }) as any;
    const health = healthyMirrorRequest();
    const download = jest.fn(async () => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-test') },
      finalUrl: 'https://cdn.example/paper.pdf'
    } as any));
    const searcher = new SciHubSearcher({
      enabled: true,
      retrievalService: service,
      healthHttpClient: health,
      downloadHttpClient: { request: download },
      validateUrl
    });
    const operation = sciHubOperation();
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-neutral-'));
    try {
      await expect(searcher.search('10.1000/context', { operationContext: operation })).resolves.toEqual([
        expect.objectContaining({ pdfUrl: 'https://cdn.example/paper.pdf' })
      ]);
      expect(strategies).toEqual(['direct', 'static']);
      await expect(searcher.downloadPdf('10.1000/context', {
        savePath: directory,
        operationContext: operation
      })).resolves.toBe(path.join(directory, '10.1000_context.pdf'));
      expect(strategies).toEqual(['direct', 'static']);
      expect(new Set(contexts)).toEqual(new Set([operation]));
      expect(download).toHaveBeenCalledWith('https://cdn.example/paper.pdf', expect.objectContaining({
        signal: operation.signal
      }));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('owns one operation across standalone lookup and PDF download', async () => {
    const pdfUrl = 'https://cdn.example/standalone.pdf';
    const service = fakeSciHubService(async strategy => sciHubResponse(
      strategy,
      `<a href="${pdfUrl}">PDF</a>`
    ));
    const operation = sciHubOperation();
    const dispose = jest.fn();
    const ownedOperation = { ...operation, dispose };
    const contexts: RetrievalOperationContext[] = [];
    service.createOperation = jest.fn(() => ownedOperation);
    const originalRetrieve = service.retrieveWithStrategies;
    service.retrieveWithStrategies = jest.fn(async (steps: readonly RetrievalStrategyStep[], context: RetrievalOperationContext, options?: any) => {
      contexts.push(context);
      return originalRetrieve(steps, context, options);
    }) as any;
    const download = jest.fn(async (_url: string, config: any) => ({
      response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-standalone') },
      finalUrl: config.url
    } as any));
    const searcher = new SciHubSearcher({
      enabled: true,
      fetchMode: 'direct',
      retrievalService: service,
      healthHttpClient: healthyMirrorRequest(),
      downloadHttpClient: { request: download },
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-standalone-operation-'));
    try {
      await expect(searcher.downloadPdf('10.1000/standalone', { savePath: directory }))
        .resolves.toBe(path.join(directory, '10.1000_standalone.pdf'));
      expect(service.createOperation).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(new Set(contexts)).toEqual(new Set([ownedOperation]));
      expect(download).toHaveBeenCalledWith(pdfUrl, expect.objectContaining({ signal: ownedOperation.signal }));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an existing PDF and cleans the temporary file when atomic replacement fails', async () => {
    const pdfUrl = 'https://cdn.example/rename-failure.pdf';
    const request = jest.fn(async (url: string, _config: any) => {
      if (new URL(url).pathname === '/') return healthResponse();
      if (url.includes('/10.1000/rename-failure')) {
        return {
          response: { status: 200, headers: {}, data: `<html><iframe src="${pdfUrl}"></iframe></html>` },
          finalUrl: url
        } as any;
      }
      return {
        response: { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-new') },
        finalUrl: url
      } as any;
    });
    const searcher = new SciHubSearcher({
      enabled: true,
      fetchMode: 'direct',
      publicHttpClient: { request },
      securityPolicy: paidTestSecurityPolicy(),
      validateUrl
    });
    const downloadsRoot = path.resolve('downloads');
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(downloadsRoot, 'scihub-rename-failure-'));
    const filePath = path.join(directory, '10.1000_rename-failure.pdf');
    fs.writeFileSync(filePath, 'previous valid PDF');
    const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }));
    try {
      await expect(searcher.downloadPdf('10.1000/rename-failure', { savePath: directory, overwrite: true }))
        .rejects.toThrow('access denied');
      expect(fs.readFileSync(filePath, 'utf8')).toBe('previous valid PDF');
      expect(fs.readdirSync(directory).filter(name => name.includes('.tmp-'))).toEqual([]);
    } finally {
      rename.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
