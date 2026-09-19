import { describe, expect, it } from '@jest/globals';
import { discoverPublicPage } from '../../src/services/PublicPageFallback.js';
import type { RetrievalOperationContext, RetrievalResponse } from '../../src/retrieval/types.js';

function operation(): RetrievalOperationContext {
  const signal = new AbortController().signal;
  return { operationId: 'page-fallback-test', signal, deadlineAt: Date.now() + 120_000, remainingMs: () => 120_000, cost: {} as any };
}

function response(strategy: 'direct' | 'static', html: string, targetStatus = 200): RetrievalResponse {
  return {
    provider: strategy === 'direct' ? 'direct' : 'scrapingant',
    strategy,
    targetStatus,
    document: {
      kind: 'html', html, iframes: [],
      source: strategy === 'direct' ? { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/article' } : { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/article' },
      targetStatus
    },
    cost: { known: true, credits: strategy === 'direct' ? 0 : 1 }
  };
}

describe('discoverPublicPage', () => {
  it('stops paid fallback after a safe direct candidate', async () => {
    const strategies: string[] = [];
    const service = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: true }),
      retrieveWithStrategies: async (steps: any[], operation: RetrievalOperationContext) => {
        const step = steps[0];
        strategies.push(step.request.strategy);
        return response(step.request.strategy, '<a href="https://cdn.example/paper.pdf">PDF</a>');
      }
    };
    const result = await discoverPublicPage({
      service, url: 'https://publisher.example/article', purpose: 'publisher_discovery', platform: 'publisher', operation: operation()
    });
    expect(result.state).toBe('candidate');
    expect(result.candidates[0].url).toBe('https://cdn.example/paper.pdf');
    expect(strategies).toEqual(['direct']);
  });

  it('does not enter paid fallback after a bare unauthorized permission status', async () => {
    const strategies: string[] = [];
    const service = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: false, availableProxyTypes: ['datacenter'] as const }),
      retrieveWithStrategies: async (steps: any[], operation: RetrievalOperationContext) => {
        strategies.push(steps[0].request.strategy);
        return response(steps[0].request.strategy, '', 401);
      }
    };
    const result = await discoverPublicPage({
      service, url: 'https://publisher.example/restricted', purpose: 'scholar_search', platform: 'googlescholar', operation: operation()
    });
    expect(result.state).toBe('restricted');
    expect(strategies).toEqual(['direct']);
  });

  it('drops unsafe provider candidates without issuing a download request', async () => {
    const service = {
      getProcessStatus: () => ({ enabled: true, browserAllowed: false }),
      retrieveWithStrategies: async (steps: any[]) => response(steps[0].request.strategy, '<a href="https://127.0.0.1/private.pdf">PDF</a>')
    };
    const result = await discoverPublicPage({
      service, url: 'https://publisher.example/article', purpose: 'publisher_discovery', platform: 'publisher', operation: operation()
    });
    expect(result.candidates).toEqual([]);
    expect(result.state).toBe('not_found');
  });
});
