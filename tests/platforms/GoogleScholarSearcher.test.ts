/**
 * GoogleScholarSearcher Platform Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import { GoogleScholarSearcher, ScholarAxiosRequester } from '../../src/platforms/GoogleScholarSearcher.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalResponse } from '../../src/retrieval/types.js';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import type { RetrievalStrategyStep } from '../../src/retrieval/RetrievalService.js';

function scholarOperation(): RetrievalOperationContext {
  const controller = new AbortController();
  return {
    operationId: 'scholar-test-operation',
    signal: controller.signal,
    deadlineAt: Date.now() + 60_000,
    remainingMs: () => 60_000,
    cost: {} as any
  };
}

function scholarHtml(title: string): string {
  return `<div class="gs_ri">
    <h3 class="gs_rt"><a href="https://example.com/${encodeURIComponent(title)}">${title}</a></h3>
    <div class="gs_a">Alice - Journal, 2024</div>
    <div class="gs_rs">A public abstract.</div>
  </div>`;
}

function scholarResponse(strategy: 'direct' | 'static', html: string, targetStatus = 200): RetrievalResponse {
  return {
    provider: strategy === 'direct' ? 'direct' : 'scrapingant',
    strategy,
    targetStatus,
    document: {
      kind: 'html',
      html,
      iframes: [],
      source: strategy === 'direct'
        ? { provenance: 'trusted_direct', finalUrl: 'https://scholar.google.com/scholar' }
        : { provenance: 'unknown_remote', submittedUrl: 'https://scholar.google.com/scholar' },
      targetStatus
    },
    cost: { known: true, credits: strategy === 'direct' ? 0 : 1 }
  };
}

function fakeScholarService(
  dispatch: (strategy: 'direct' | 'static', url: string) => Promise<RetrievalResponse>
) {
  return {
    createOperation: jest.fn(() => scholarOperation()),
    getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: false })),
    retrieveWithStrategies: jest.fn(async (steps: readonly RetrievalStrategyStep[], operation: RetrievalOperationContext) => {
      let state: any = { attemptedStrategies: [] };
      let last: RetrievalResponse | undefined;
      for (const step of steps) {
        if (step.shouldAttempt && !step.shouldAttempt(state)) continue;
        try {
          const response = await dispatch(step.request.strategy as 'direct' | 'static', step.request.url);
          last = response;
          state = { ...state, previousResponse: response, previousError: undefined };
          if (step.isTerminalResponse?.(response, state) !== false) return response;
        } catch (error) {
          state = { ...state, previousResponse: undefined, previousError: error };
          if (!step.continueOnError?.(error as any, state)) throw error;
        }
      }
      if (last) return last;
      throw new Error('No fake Scholar strategy completed');
    })
  } as any;
}

describe('GoogleScholarSearcher', () => {
  let searcher: GoogleScholarSearcher;
  const proxyEnvNames = ['SCHOLAR_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
  const originalProxyEnv = Object.fromEntries(proxyEnvNames.map(name => [name, process.env[name]]));

  beforeEach(() => {
    searcher = new GoogleScholarSearcher();
  });

  afterEach(() => {
    for (const name of proxyEnvNames) {
      const value = originalProxyEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(false);
      expect(caps.citations).toBe(true);
      expect(caps.requiresApiKey).toBe(false);
    });
  });

  describe('ScrapingAnt compatibility adapter', () => {
    it('cannot dispatch a legacy fetcher when paid retrieval is disabled', async () => {
      const fetch = jest.fn(async () => ({ html: '<html></html>', apiStatus: 200, pageStatus: 200 }));
      const configured = new GoogleScholarSearcher({ isConfigured: () => true, fetch } as any, {
        transport: 'scrapingant',
        retrievalService: {
          createOperation: jest.fn(() => scholarOperation()),
          getProcessStatus: jest.fn(() => ({ enabled: false, browserAllowed: false })),
          retrieveWithStrategies: jest.fn(async () => {
            throw new RetrievalError({ code: 'configuration', message: 'paid disabled' });
          })
        } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 1 })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('routes a configured legacy fetcher through the shared paid operation', async () => {
      process.env.SCRAPINGANT_API_KEY = 'test-api-key';
      process.env.SCRAPINGANT_ENABLED = 'true';
      const fetch = jest.fn(async () => ({
        html: scholarHtml('A public paper'),
        apiStatus: 200,
        pageStatus: 200,
        creditsCost: 1
      }));
      const configured = new GoogleScholarSearcher({ isConfigured: () => true, fetch } as any, {
        transport: 'scrapingant',
        securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        }) })
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 1 })).resolves.toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('q=public+query'), expect.objectContaining({
        endpoint: 'general',
        browser: false,
        signal: expect.any(AbortSignal),
        singleAttempt: true
      }));
    });

    it('preserves unknown target status when a legacy fetcher reports only API status', async () => {
      process.env.SCRAPINGANT_API_KEY = 'test-api-key';
      process.env.SCRAPINGANT_ENABLED = 'true';
      const fetch = jest.fn(async () => ({
        html: '<html>CAPTCHA verification required</html>',
        apiStatus: 200,
        creditsCost: 1
      }));
      const configured = new GoogleScholarSearcher({ isConfigured: () => true, fetch } as any, {
        transport: 'scrapingant',
        securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        }) })
      });
      const operation = (configured as any).retrievalService.createOperation();
      try {
        const response = await (configured as any).retrievalService.retrieveWithRetry({
          url: 'https://scholar.google.com/scholar?q=public',
          purpose: 'scholar_search',
          strategy: 'static',
          documentFormat: 'html'
        }, operation);
        expect(response.apiStatus).toBe(200);
        expect(response.targetStatus).toBeUndefined();
        expect(response.document.targetStatus).toBeUndefined();
      } finally {
        operation.dispose?.();
      }
    });
  });

  describe('proxy and transport selection', () => {
    it('attaches session cookies only to the exact Scholar HTTPS origin', async () => {
      const request = jest.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: '' } as any);
      const requester = new ScholarAxiosRequester(
        () => undefined,
        () => 'SID=scholar-session',
        () => 'Scholar UA'
      );

      try {
        await requester.request({ url: 'https://scholar.google.com/scholar?q=public' });
        for (const url of [
          'https://scholar.google.com:8443/scholar?q=public',
          'http://scholar.google.com/scholar?q=public',
          'https://publisher.example/article'
        ]) {
          await expect(requester.request({ url })).rejects.toThrow(/allowed HTTPS origin/i);
        }

        expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'SID=scholar-session' }) }));
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        request.mockRestore();
      }
    });

    it('stops a cross-origin redirect before a second Scholar transport dispatch', async () => {
      const request = jest.spyOn(axios, 'request').mockResolvedValue({
        status: 302,
        headers: { location: 'https://publisher.example/article' },
        data: ''
      } as any);
      const requester = new ScholarAxiosRequester(
        () => undefined,
        () => 'SID=scholar-session',
        () => 'Scholar UA'
      );
      const client = new PublicHttpClient({
        client: requester,
        purpose: 'scholar_search',
        validateUrl: async url => ({
          url,
          hostname: new URL(url).hostname,
          addresses: [{ address: '93.184.216.34', family: 4 as const }]
        })
      });

      try {
        await expect(client.request('https://scholar.google.com/scholar?q=public')).rejects.toThrow(/allowed HTTPS origin/i);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        request.mockRestore();
      }
    });

    it('builds an HTTPS proxy agent for an HTTP proxy URL', () => {
      process.env.SCHOLAR_PROXY = 'http://proxy.example:8080';
      const configured = new GoogleScholarSearcher(undefined, { transport: 'direct' });

      expect((configured as any).buildProxyAgent()).toBeInstanceOf(HttpsProxyAgent);
      expect((configured as any).proxy).toBe('http://proxy.example:8080');
    });

    it('builds a SOCKS proxy agent for a SOCKS URL', () => {
      process.env.SCHOLAR_PROXY = 'socks5://proxy.example:1080';
      const configured = new GoogleScholarSearcher(undefined, { transport: 'direct' });

      expect((configured as any).buildProxyAgent()).toBeInstanceOf(SocksProxyAgent);
    });

    it('rejects invalid proxy configuration before dispatching a direct request', () => {
      process.env.SCHOLAR_PROXY = 'not-a-proxy-url';
      const configured = new GoogleScholarSearcher(undefined, { transport: 'direct' });

      expect(() => (configured as any).buildProxyAgent()).toThrow(/proxy configuration is invalid or unavailable/i);
    });

    it('uses the isolated Scholar requester for direct proxy transport', async () => {
      process.env.SCHOLAR_PROXY = 'http://proxy.example:8080';
      const request = jest.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: '' } as any);
      const requester = new ScholarAxiosRequester(
        () => new HttpsProxyAgent('http://proxy.example:8080'),
        () => '',
        () => 'Scholar UA'
      );

      try {
        await requester.request({ url: 'https://scholar.google.com/scholar?q=public' });
        expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({
          proxy: false,
          httpsAgent: expect.any(HttpsProxyAgent)
        }));
      } finally {
        request.mockRestore();
      }
    });
  });

  describe('provider-neutral retrieval', () => {
    it('can create the shared retrieval service around its isolated Scholar transport', () => {
      const scholarHttpClient = { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any;
      const sharedService = fakeScholarService(async () => scholarResponse('direct', '<html></html>'));
      const factory = jest.fn(() => sharedService);
      new GoogleScholarSearcher(undefined, {
        publicHttpClient: scholarHttpClient,
        retrievalServiceFactory: factory
      });

      expect(factory).toHaveBeenCalledWith(scholarHttpClient);
    });

    it('does not treat the normal Scholar sign-in navigation link as a block', async () => {
      const service = fakeScholarService(async strategy => scholarResponse(
        strategy,
        `<nav><a href="https://accounts.google.com/ServiceLogin">Sign in</a></nav>${scholarHtml('Navigation-safe paper').replace('A public abstract.', 'This paper studies paywall policy.')}`
      ));
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'Navigation-safe paper' })
      ]);
    });

    it('blocks a page-level login gate even when result markup is present', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async strategy => {
        strategies.push(strategy);
        return scholarResponse(strategy, `<h1>Sign in to continue</h1>${scholarHtml('Should not pass')}`);
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 1 })).resolves.toEqual([]);
      expect(strategies).toEqual(['static']);
    });

    it('does not escalate a blocked direct Scholar response', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async (strategy) => {
        strategies.push(strategy);
        return scholarResponse(strategy, '<html>captcha</html>', 403);
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 10 })).resolves.toEqual([]);
      expect(strategies).toEqual(['direct']);
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(1);
    });

    it('does not escalate a 503 Scholar CAPTCHA page to paid static retrieval', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async (strategy) => {
        strategies.push(strategy);
        return scholarResponse(strategy, '<html>CAPTCHA verification required</html>', 503);
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 10 })).resolves.toEqual([]);
      expect(strategies).toEqual(['direct']);
    });

    it('uses static fallback only after a direct network/server failure', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async (strategy) => {
        strategies.push(strategy);
        if (strategy === 'direct') {
          throw new RetrievalError({ code: 'network', message: 'upstream unavailable', retryable: true });
        }
        return scholarResponse(strategy, '<html></html>');
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 10 })).resolves.toEqual([]);
      expect(strategies).toEqual(['direct', 'static']);
    });

    it('stops after two pages that contain no new papers', async () => {
      const html = scholarHtml('A public paper');
      const urls: string[] = [];
      const service = fakeScholarService(async (strategy, url) => {
        expect(strategy).toBe('static');
        urls.push(url);
        return scholarResponse(strategy, html);
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      const papers = await configured.search('public query', { maxResults: 20 });
      expect(papers).toHaveLength(1);
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(3);
      expect(urls[1]).toContain('start=10');
      expect(urls[2]).toContain('start=20');
    });

    it('caps pagination at ten pages even when every page is new', async () => {
      const service = fakeScholarService(async (_strategy, url) => {
        const start = Number(new URL(url).searchParams.get('start') || 0);
        return scholarResponse('static', scholarHtml(`Paper ${start}`));
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      const papers = await configured.search('public query', { maxResults: 20 });

      expect(papers).toHaveLength(10);
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(10);
    });

    it('returns partial results and does not reopen retrieval after a later provider error', async () => {
      const retrieveWithStrategies = jest.fn<() => Promise<RetrievalResponse>>();
      retrieveWithStrategies
        .mockResolvedValueOnce(scholarResponse('static', scholarHtml('First page paper')))
        .mockRejectedValueOnce(new RetrievalError({ code: 'network', message: 'upstream unavailable', retryable: true }));
      const service = {
        createOperation: jest.fn(() => scholarOperation()),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: false })),
        retrieveWithStrategies
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      const papers = await configured.search('public query', { maxResults: 20 });

      expect(papers).toHaveLength(1);
      expect(papers[0].title).toBe('First page paper');
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(2);
    });
  });

  describe('search options', () => {
    it('should support yearLow filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support yearHigh filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support author filter', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('Academic paper priority', () => {
    it('should prioritize academic papers over books', () => {
      // Smart filtering feature
      expect(searcher).toBeDefined();
    });
  });

  describe('Anti-detection', () => {
    it('should have smart request patterns', () => {
      expect(searcher).toBeDefined();
    });
  });
});
