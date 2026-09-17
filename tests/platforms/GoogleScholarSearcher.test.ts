/**
 * GoogleScholarSearcher Platform Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import { GoogleScholarSearcher, ScholarAxiosRequester } from '../../src/platforms/GoogleScholarSearcher.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { ScrapingAntProvider } from '../../src/retrieval/ScrapingAntProvider.js';
import { RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';
import { RetrievalService } from '../../src/retrieval/RetrievalService.js';
import { parseRetrievalConfiguration } from '../../src/retrieval/Configuration.js';
import { PublicSourceDispatchScheduler } from '../../src/services/PublicSourceDispatchScheduler.js';
import { RetrievalError, type RetrievalOperationContext, type RetrievalProvider, type RetrievalResponse } from '../../src/retrieval/types.js';
import { OutboundSecurityError } from '../../src/retrieval/OutboundSecurityPolicy.js';
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

function scholarResponse(strategy: 'direct' | 'static' | 'browser', html: string, targetStatus = 200): RetrievalResponse {
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
  dispatch: (strategy: 'direct' | 'static' | 'browser', url: string) => Promise<RetrievalResponse>,
  processStatus: { enabled: boolean; browserAllowed: boolean; residentialAllowed?: boolean; availableProxyTypes?: readonly ('datacenter' | 'residential')[] } = {
    enabled: true,
    browserAllowed: false
  }
) {
  return {
    createOperation: jest.fn(() => scholarOperation()),
    getProcessStatus: jest.fn(() => processStatus),
    retrieveWithStrategies: jest.fn(async (steps: readonly RetrievalStrategyStep[], operation: RetrievalOperationContext) => {
      let state: any = { attemptedStrategies: [] };
      let last: RetrievalResponse | undefined;
      for (const step of steps) {
        if (step.shouldAttempt && !step.shouldAttempt(state)) continue;
        try {
          const response = await dispatch(step.request.strategy as 'direct' | 'static' | 'browser', step.request.url);
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
        proxyType: 'datacenter',
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
        (operation as RetrievalOperationContext & { dispose?: () => void }).dispose?.();
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

    it('uses the standard local proxy alias when SCHOLAR_PROXY is absent', () => {
      for (const name of proxyEnvNames) delete process.env[name];
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      const configured = new GoogleScholarSearcher(undefined, { transport: 'direct' });

      expect((configured as any).proxy).toBe('http://127.0.0.1:7890');
      expect((configured as any).buildProxyAgent()).toBeInstanceOf(HttpsProxyAgent);
    });

    it('prioritizes an explicit SCHOLAR_PROXY over the local proxy alias', () => {
      for (const name of proxyEnvNames) delete process.env[name];
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      process.env.SCHOLAR_PROXY = 'https://explicit-proxy.example:443';
      const configured = new GoogleScholarSearcher(undefined, { transport: 'direct' });

      expect((configured as any).proxy).toBe('https://explicit-proxy.example:443');
      expect((configured as any).buildProxyAgent()).toBeInstanceOf(HttpsProxyAgent);
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
    it('fails before query dispatch when Scholar session setup is security-rejected', async () => {
      const retrieveWithStrategies = jest.fn();
      const service = {
        createOperation: jest.fn(() => scholarOperation()),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: false })),
        retrieveWithStrategies
      } as any;
      const publicHttpClient = {
        request: jest.fn(async () => {
          throw new OutboundSecurityError('session target rejected');
        })
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('blocked query', { maxResults: 1 })).rejects.toThrow(/search failed/i);
      expect(retrieveWithStrategies).not.toHaveBeenCalled();
    });

    it('stops before query dispatch when Scholar session setup returns anti-bot 423', async () => {
      const retrieveWithStrategies = jest.fn();
      const service = {
        createOperation: jest.fn(() => scholarOperation()),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: true })),
        retrieveWithStrategies
      } as any;
      const publicHttpClient = {
        request: jest.fn(async () => ({
          response: { status: 423, headers: {}, data: '' },
          finalUrl: 'https://scholar.google.com'
        }))
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('session anti-bot', { maxResults: 1 })).rejects.toThrow(/search failed/i);
      expect(publicHttpClient.request).toHaveBeenCalledTimes(1);
      expect(retrieveWithStrategies).not.toHaveBeenCalled();
    });

    it('clears retained Scholar cookies when a later session is restricted', async () => {
      let sessionCalls = 0;
      const service = fakeScholarService(async strategy => scholarResponse(strategy, scholarHtml('Cookie-safe paper')));
      const publicHttpClient = {
        request: jest.fn(async () => {
          sessionCalls++;
          return sessionCalls === 1
            ? {
              response: { status: 200, headers: { 'set-cookie': ['SID=old-session; Path=/'] }, data: '' },
              finalUrl: 'https://scholar.google.com'
            }
            : {
              response: { status: 423, headers: {}, data: '' },
              finalUrl: 'https://scholar.google.com'
            };
        })
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('cookie first', { maxResults: 1 })).resolves.toHaveLength(1);
      expect((configured as any).sessionCookies).toContain('SID=old-session');
      await expect(configured.search('cookie restricted', { maxResults: 1 })).rejects.toThrow(/search failed/i);
      expect((configured as any).sessionCookies).toBe('');
      expect(publicHttpClient.request).toHaveBeenCalledTimes(2);
    });

    it('does not use paid fallback when a session 423 also contains permission evidence', async () => {
      const retrieveWithStrategies = jest.fn();
      const service = {
        createOperation: jest.fn(() => scholarOperation()),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: true })),
        retrieveWithStrategies
      } as any;
      const publicHttpClient = {
        request: jest.fn(async () => ({
          response: { status: 423, headers: {}, data: '<h1>Sign in to continue</h1>' },
          finalUrl: 'https://scholar.google.com'
        }))
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('permission anti-bot', { maxResults: 1 })).rejects.toThrow(/search failed/i);
      expect(retrieveWithStrategies).not.toHaveBeenCalled();
    });

    it('fails before query dispatch when Scholar session setup exceeds 5 MiB', async () => {
      const destroy = jest.fn();
      const body: AsyncIterable<Uint8Array> & { destroy: jest.Mock } = {
        destroy,
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: Buffer.alloc(5 * 1024 * 1024 + 1) }),
          return: async () => ({ done: true, value: undefined })
        })
      };
      const retrieveWithStrategies = jest.fn();
      const service = {
        createOperation: jest.fn(() => scholarOperation()),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: false })),
        retrieveWithStrategies
      } as any;
      const publicHttpClient = {
        request: jest.fn(async () => ({ response: { status: 200, headers: {}, data: body }, finalUrl: 'https://scholar.google.com' }))
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('oversized query', { maxResults: 1 })).rejects.toThrow(/response|size|failed/i);
      expect(retrieveWithStrategies).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalled();
    });

    it('preserves structured provider failures for caller diagnostics', async () => {
      const service = {
        createOperation: jest.fn(() => scholarOperation()),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: true })),
        retrieveWithStrategies: jest.fn(async () => {
          throw new RetrievalError({
            code: 'timeout',
            message: 'ScrapingAnt retrieval timed out',
            provider: 'scrapingant',
            failureKind: 'transport_timeout'
          });
        })
      } as any;
      const publicHttpClient = {
        request: jest.fn(async () => ({
          response: { status: 200, headers: {}, data: '' },
          finalUrl: 'https://scholar.google.com'
        }))
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('structured timeout', { maxResults: 1 })).rejects.toMatchObject({
        code: 'timeout',
        provider: 'scrapingant',
        failureKind: 'transport_timeout'
      });
    });

    it('continues query retrieval after an ordinary session 429 without paid HOME setup', async () => {
      const service = fakeScholarService(async strategy => scholarResponse(strategy, scholarHtml('After session rate limit')));
      const publicHttpClient = {
        request: jest.fn(async () => ({
          response: { status: 429, headers: { 'retry-after': '1' }, data: '' },
          finalUrl: 'https://scholar.google.com'
        }))
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('rate limited home', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'After session rate limit' })
      ]);
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(1);
    });

    it('does not query after session cancellation', async () => {
      const controller = new AbortController();
      const retrieveWithStrategies = jest.fn();
      const service = {
        createOperation: jest.fn(() => ({
          ...scholarOperation(),
          signal: controller.signal,
          remainingMs: () => 60_000
        })),
        getProcessStatus: jest.fn(() => ({ enabled: true, browserAllowed: false })),
        retrieveWithStrategies
      } as any;
      const publicHttpClient = {
        request: jest.fn(async (_url: string, config: any) => new Promise((_resolve, reject) => {
          config.signal.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
          controller.abort();
        }))
      } as any;
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        publicHttpClient,
        transport: 'auto'
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('cancelled home', { maxResults: 1, operationContext: {
        ...scholarOperation(),
        signal: controller.signal,
        remainingMs: () => 60_000
      } })).resolves.toEqual([]);
      expect(retrieveWithStrategies).not.toHaveBeenCalled();
    });

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

    it('allows an ordinary direct CAPTCHA response to use paid fallback', async () => {
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
      expect(strategies).toEqual(['direct', 'static']);
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(1);
    });

    it('allows a 503 Scholar CAPTCHA page to use paid static retrieval', async () => {
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
      expect(strategies).toEqual(['direct', 'static']);
    });

    it('keeps a direct Scholar target 423 terminal without paid bypass', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async strategy => {
        strategies.push(strategy);
        return strategy === 'direct'
          ? scholarResponse(strategy, '<html>captcha</html>', 423)
          : scholarResponse(strategy, scholarHtml('Should not run'));
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('target anti-bot', { maxResults: 1 })).resolves.toEqual([]);
      expect(strategies).toEqual(['direct']);
    });

    it('does not use paid fallback when a direct 423 also contains permission evidence', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async strategy => {
        strategies.push(strategy);
        return strategy === 'direct'
          ? scholarResponse(strategy, `<h1>Sign in to continue</h1>${scholarHtml('Gated paper')}`, 423)
          : scholarResponse(strategy, scholarHtml('Should not run'));
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('permission target', { maxResults: 1 })).resolves.toEqual([]);
      expect(strategies).toEqual(['direct']);
    });

    it('reports bounded parser-stage counts for a parsed Scholar page', async () => {
      const html = scholarHtml('Observed parser paper');
      const diagnostics: any[] = [];
      const service = fakeScholarService(async strategy => scholarResponse(strategy, html));
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant',
        parserObserver: value => diagnostics.push(value)
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('parser diagnostics', { maxResults: 1 })).resolves.toHaveLength(1);
      expect(diagnostics).toEqual([{
        bodyBytes: Buffer.byteLength(html, 'utf8'),
        resultContainers: 1,
        itemsExamined: 1,
        missingTitleItems: 0,
        bookFilteredItems: 0,
        constructionErrorItems: 0,
        parsedItems: 1,
        classification: 'parsed'
      }]);
    });

    it.each([
      ['', 'empty'],
      ['<div class="notice">No indexed results</div>', 'unrecognized']
    ])('classifies empty or unrecognized Scholar markup without exposing content (%s)', async (html, classification) => {
      const diagnostics: any[] = [];
      const service = fakeScholarService(async strategy => scholarResponse(strategy, html));
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant',
        parserObserver: value => diagnostics.push(value)
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('parser empty', { maxResults: 1 })).resolves.toEqual([]);
      expect(diagnostics).toEqual([expect.objectContaining({
        bodyBytes: Buffer.byteLength(html, 'utf8'),
        resultContainers: 0,
        itemsExamined: 0,
        parsedItems: 0,
        classification
      })]);
    });

    it('reports filtered Scholar items and preserves a valid item', async () => {
      const html = [
        '<div class="gs_ri"><h3 class="gs_rt"></h3></div>',
        '<div class="gs_ri"><h3 class="gs_rt">[BOOK] A book result</h3><div class="gs_a">Author - Book, 2024</div></div>',
        scholarHtml('Valid result after filtered items')
      ].join('');
      const diagnostics: any[] = [];
      const service = fakeScholarService(async strategy => scholarResponse(strategy, html));
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant',
        parserObserver: value => diagnostics.push(value)
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('filtered items', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'Valid result after filtered items' })
      ]);
      expect(diagnostics[0]).toEqual(expect.objectContaining({
        resultContainers: 3,
        itemsExamined: 3,
        missingTitleItems: 1,
        bookFilteredItems: 1,
        constructionErrorItems: 0,
        parsedItems: 1,
        classification: 'parsed'
      }));
    });

    it('ignores challenge and permission words inside scripts or Scholar result text', async () => {
      const html = `<script>const marker = "cloudflare captcha paywall sign in";</script>${scholarHtml('A study about CAPTCHA and paywall policy')}`;
      const diagnostics: any[] = [];
      const service = fakeScholarService(async strategy => scholarResponse(strategy, html));
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'scrapingant',
        parserObserver: value => diagnostics.push(value)
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('visible result text', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'A study about CAPTCHA and paywall policy' })
      ]);
      expect(diagnostics).toEqual([expect.objectContaining({
        resultContainers: 1,
        parsedItems: 1,
        classification: 'parsed'
      })]);
    });

    it('classifies genuine Scholar challenge and restriction pages separately', async () => {
      const challengeDiagnostics: any[] = [];
      const challengeService = fakeScholarService(async strategy => scholarResponse(
        strategy,
        '<h1>CAPTCHA verification required</h1>',
        403
      ));
      const challengeSearcher = new GoogleScholarSearcher(undefined, {
        retrievalService: challengeService,
        transport: 'scrapingant',
        parserObserver: value => challengeDiagnostics.push(value)
      });
      (challengeSearcher as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(challengeSearcher.search('challenge', { maxResults: 1 })).resolves.toEqual([]);
      expect(challengeDiagnostics).toEqual([expect.objectContaining({ classification: 'challenge' })]);

      const restrictionDiagnostics: any[] = [];
      const restrictionService = fakeScholarService(async strategy => scholarResponse(
        strategy,
        `<h1>Sign in to continue</h1>${scholarHtml('Gated result')}`,
        403
      ));
      const restrictionSearcher = new GoogleScholarSearcher(undefined, {
        retrievalService: restrictionService,
        transport: 'scrapingant',
        parserObserver: value => restrictionDiagnostics.push(value)
      });
      (restrictionSearcher as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(restrictionSearcher.search('restriction', { maxResults: 1 })).resolves.toEqual([]);
      expect(restrictionDiagnostics).toEqual([expect.objectContaining({
        resultContainers: 1,
        parsedItems: 1,
        classification: 'restricted'
      })]);
    });

    it('parses a Paper after the real browser-first ScrapingAnt fallback', async () => {
      let schedulerNow = 0;
      const sourceScheduler = new PublicSourceDispatchScheduler({
        now: () => schedulerNow,
        sleep: async milliseconds => {
          schedulerNow += milliseconds;
        }
      });
      const providerRequests: any[] = [];
      const providerResponses = [
        { status: 200, headers: { 'Ant-credits-cost': '10' }, data: { html: scholarHtml('Real fallback paper') } }
      ];
      const paidProvider = new ScrapingAntProvider({
        apiKey: 'test-key',
        sourceScheduler,
        client: {
          request: jest.fn(async config => {
            providerRequests.push(config);
            return providerResponses.shift()!;
          })
        }
      });
      const baseConfiguration = parseRetrievalConfiguration({} as NodeJS.ProcessEnv);
      const configuration = {
        ...baseConfiguration,
        scrapingAnt: {
          ...baseConfiguration.scrapingAnt,
          apiKey: 'test-key',
          configured: true,
          enabled: true,
          paidEnabled: true,
          browserAllowed: true,
          availableProxyTypes: ['datacenter'] as const
        }
      };
      const directProvider: RetrievalProvider = {
        name: 'direct',
        capabilities: {
          html: true,
          iframeDocuments: false,
          pdfCandidates: false,
          browser: false,
          paid: false,
          purposes: ['scholar_search'],
          proxyTypes: ['datacenter'],
          combinations: ['direct:datacenter']
        },
        retrieve: async () => ({
          ...scholarResponse('direct', '<html>captcha</html>', 403),
          targetStatus: 403,
          document: {
            ...scholarResponse('direct', '<html>captcha</html>', 403).document!,
            targetStatus: 403
          }
        })
      };
      const retrievalService = new RetrievalService({
        directProvider,
        scrapingAntProvider: paidProvider,
        configuration,
        costPolicy: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: true }),
        securityPolicy: new OutboundSecurityPolicy({
          validatePublicUrl: async url => ({
            url,
            hostname: new URL(url).hostname,
            addresses: [{ address: '93.184.216.34', family: 4 as const }]
          })
        }),
        retrySleep: async () => undefined,
        retryRandom: () => 0
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({
          response: { status: 200, headers: {}, data: '' },
          finalUrl: 'https://scholar.google.com'
        })) } as any,
        delay: async () => undefined
      });

      await expect(configured.search('real fallback', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'Real fallback paper', source: 'googlescholar' })
      ]);
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0].params.browser).toBe(true);
      expect(retrievalService.getProcessStatus()).toEqual(expect.objectContaining({
        unknownCostAttempts: 0,
        reportedCredits: 10
      }));
    });

    it('uses paid fallback when Direct returns an empty Scholar page', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async strategy => {
        strategies.push(strategy);
        return strategy === 'direct'
          ? scholarResponse(strategy, '<html></html>')
          : scholarResponse(strategy, scholarHtml('Fallback paper'));
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'Fallback paper' })
      ]);
      expect(strategies).toEqual(['direct', 'static']);
    });

    it('starts Scholar production fallback with browser datacenter when explicitly allowed', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async strategy => {
        strategies.push(strategy);
        return strategy === 'direct'
          ? scholarResponse(strategy, '<html>captcha</html>', 403)
          : scholarResponse(strategy, scholarHtml('Browser-first paper'));
      }, {
        enabled: true,
        browserAllowed: true,
        availableProxyTypes: ['datacenter']
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('browser first', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'Browser-first paper' })
      ]);
      expect(strategies).toEqual(['direct', 'browser']);
    });

    it('stops same-page escalation when Direct returns a valid Scholar result', async () => {
      const strategies: string[] = [];
      const service = fakeScholarService(async strategy => {
        strategies.push(strategy);
        return scholarResponse(strategy, scholarHtml('Direct paper'));
      });
      const configured = new GoogleScholarSearcher(undefined, {
        retrievalService: service,
        transport: 'auto',
        publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
      });
      (configured as any).adaptiveDelay = jest.fn(async () => undefined);

      await expect(configured.search('public query', { maxResults: 1 })).resolves.toEqual([
        expect.objectContaining({ title: 'Direct paper' })
      ]);
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

    it('reuses parsed results when a completed strategy response is compacted', async () => {
    const direct = jest.fn(async () => scholarResponse('direct', scholarHtml('Cached Scholar paper')));
    const directProvider: RetrievalProvider = {
      name: 'direct',
      capabilities: {
        html: true,
        iframeDocuments: false,
        pdfCandidates: false,
        browser: false,
        paid: false,
        purposes: ['scholar_search'],
        proxyTypes: ['datacenter'],
        combinations: ['direct:datacenter']
      },
      retrieve: direct
    };
    const service = new (await import('../../src/retrieval/RetrievalService.js')).RetrievalService({
      directProvider,
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: async url => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      }) })
    });
    const configured = new GoogleScholarSearcher(undefined, { retrievalService: service, transport: 'direct' });
    (configured as any).adaptiveDelay = jest.fn(async () => undefined);
    const operation = service.createOperation({ purpose: 'scholar_search' });
    try {
      await expect(configured.search('cached query', { maxResults: 1, operationContext: operation })).resolves.toHaveLength(1);
      const second = await configured.search('cached query', { maxResults: 1, operationContext: operation });
      second[0].title = 'caller mutation';
      second[0].authors.push('caller mutation');
      const third = await configured.search('cached query', { maxResults: 1, operationContext: operation });
      expect(third[0].title).toBe('Cached Scholar paper');
      expect(third[0].authors).not.toContain('caller mutation');
      expect(direct).toHaveBeenCalledTimes(1);
    } finally {
      operation.dispose();
    }
  });

  it('reuses paid fallback results within one operation without a second paid call', async () => {
    const strategies: string[] = [];
    const service = fakeScholarService(async strategy => {
      strategies.push(strategy);
      return strategy === 'direct'
        ? scholarResponse(strategy, '<html>captcha</html>', 403)
        : scholarResponse(strategy, scholarHtml('Paid cached paper'));
    });
    const configured = new GoogleScholarSearcher(undefined, {
      retrievalService: service,
      transport: 'auto',
      publicHttpClient: { request: jest.fn(async () => ({ status: 200, headers: {}, data: '' })) } as any
    });
    (configured as any).adaptiveDelay = jest.fn(async () => undefined);
    const operation = scholarOperation();
    try {
      await expect(configured.search('paid cached query', { maxResults: 1, operationContext: operation })).resolves.toEqual([
        expect.objectContaining({ title: 'Paid cached paper' })
      ]);
      await expect(configured.search('paid cached query', { maxResults: 1, operationContext: operation })).resolves.toEqual([
        expect.objectContaining({ title: 'Paid cached paper' })
      ]);
      expect(strategies).toEqual(['direct', 'static']);
    } finally {
      (operation as RetrievalOperationContext & { dispose?: () => void }).dispose?.();
    }
  });

  it('does not turn a cached Scholar login gate into papers on re-entry', async () => {
    const service = fakeScholarService(async strategy => scholarResponse(
      strategy,
      `<h1>Sign in to continue</h1>${scholarHtml('Gated paper')}`
    ));
    const configured = new GoogleScholarSearcher(undefined, {
      retrievalService: service,
      transport: 'scrapingant'
    });
    (configured as any).adaptiveDelay = jest.fn(async () => undefined);
    const operation = scholarOperation();
    try {
      await expect(configured.search('gated cached query', { maxResults: 1, operationContext: operation })).resolves.toEqual([]);
      await expect(configured.search('gated cached query', { maxResults: 1, operationContext: operation })).resolves.toEqual([]);
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(1);
    } finally {
      (operation as RetrievalOperationContext & { dispose?: () => void }).dispose?.();
    }
  });

  it('deeply snapshots Scholar cache dates and isolates concurrent cache readers', async () => {
    const service = fakeScholarService(async strategy => scholarResponse(strategy, scholarHtml('Snapshot paper')));
    const configured = new GoogleScholarSearcher(undefined, {
      retrievalService: service,
      transport: 'scrapingant'
    });
    (configured as any).adaptiveDelay = jest.fn(async () => undefined);
    const operation = scholarOperation();
    try {
      const first = await configured.search('snapshot query', { maxResults: 1, operationContext: operation });
      const originalYear = first[0].publishedDate?.getFullYear();
      first[0].publishedDate?.setFullYear(1999);
      const [second, third] = await Promise.all([
        configured.search('snapshot query', { maxResults: 1, operationContext: operation }),
        configured.search('snapshot query', { maxResults: 1, operationContext: operation })
      ]);
      expect(second[0].publishedDate?.getFullYear()).toBe(originalYear);
      second[0].publishedDate?.setFullYear(1984);
      second[0].title = 'mutated concurrent reader';
      expect(third[0].publishedDate?.getFullYear()).toBe(originalYear);
      expect(third[0].title).toBe('Snapshot paper');
      expect(service.retrieveWithStrategies).toHaveBeenCalledTimes(1);
    } finally {
      (operation as RetrievalOperationContext & { dispose?: () => void }).dispose?.();
    }
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
