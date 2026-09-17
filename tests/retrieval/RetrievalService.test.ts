import { describe, expect, it, jest } from '@jest/globals';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import { RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';
import { parseRetrievalConfiguration } from '../../src/retrieval/Configuration.js';
import { RetrievalService } from '../../src/retrieval/RetrievalService.js';
import { RetrievalError } from '../../src/retrieval/types.js';
import { DirectHttpProvider } from '../../src/retrieval/DirectHttpProvider.js';
import { ScrapingAntProvider } from '../../src/retrieval/ScrapingAntProvider.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { PublicSourceDispatchScheduler } from '../../src/services/PublicSourceDispatchScheduler.js';
import type {
  RetrievalCostObservation,
  RetrievalOperationContext,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResponse
} from '../../src/retrieval/types.js';

const validateUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 as const }]
});

function response(provider: string, strategy: 'direct' | 'static' | 'browser' = 'static', cost: RetrievalCostObservation = { known: true, credits: 1 }): RetrievalResponse {
  return {
    provider,
    strategy,
    apiStatus: provider === 'paid' ? 200 : undefined,
    targetStatus: 200,
    document: {
      kind: 'html',
      html: '<html />',
      iframes: [],
      source: provider === 'paid'
        ? { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/page' }
        : { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/page' },
      targetStatus: 200
    },
    cost
  };
}

function provider(name: string, retrieve: RetrievalProvider['retrieve']): RetrievalProvider {
  return {
    name,
    capabilities: {
      html: true,
      iframeDocuments: name === 'paid',
      pdfCandidates: true,
      browser: name === 'paid',
      paid: name === 'paid'
    },
    retrieve
  };
}

function serviceWith(
  paidRetrieve: RetrievalProvider['retrieve'],
  directRetrieve: RetrievalProvider['retrieve'] = async () => response('direct', 'direct', { known: true, credits: 0 }),
  options: {
    budget?: number;
    maxCreditsPerRequest?: number;
    maxConcurrency?: number;
    operationTimeoutMs?: number;
    retrySleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    retryRandom?: () => number;
    browserAllowed?: boolean;
  } = {}
): RetrievalService {
  const baseConfiguration = parseRetrievalConfiguration({} as NodeJS.ProcessEnv);
  const configuration = {
    ...baseConfiguration,
    scrapingAnt: {
      ...baseConfiguration.scrapingAnt,
      apiKey: 'test-key',
      configured: true,
      enabled: true,
      paidEnabled: true,
      browserAllowed: options.browserAllowed ?? false
    }
  };
  return new RetrievalService({
    directProvider: provider('direct', directRetrieve),
    scrapingAntProvider: provider('paid', paidRetrieve),
    configuration,
    costPolicy: new RetrievalCostPolicy({
      budget: options.budget ?? 50,
      maxCreditsPerRequest: options.maxCreditsPerRequest ?? 10,
      enabled: true
    }),
    securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl }),
    maxConcurrency: options.maxConcurrency ?? 1,
    operationTimeoutMs: options.operationTimeoutMs,
    retrySleep: options.retrySleep,
    retryRandom: options.retryRandom
  });
}

const paidRequest = {
  url: 'https://publisher.example/page',
  purpose: 'publisher_discovery' as const,
  strategy: 'static' as const,
  documentFormat: 'html_with_iframes' as const
};

describe('RetrievalService', () => {
  it('creates purpose-specific ledgers without upgrading supplied or mixed-purpose operations', async () => {
    const configuration = parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: 'test-key',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_PROXY_TYPE: 'datacenter'
    });
    const service = new RetrievalService({
      directProvider: provider('direct', async () => response('direct', 'direct', { known: true, credits: 0 })),
      scrapingAntProvider: provider('paid', async () => response('paid')),
      configuration,
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });

    await service.withOperation(async operation => {
      expect(operation.cost.snapshot().budget).toBe(500);
    }, { purpose: 'publisher_discovery' });
    await service.withOperation(async operation => {
      expect(operation.cost.snapshot().budget).toBe(500);
    }, { purpose: 'scholar_search' });
    await service.withOperation(async operation => {
      expect(operation.cost.snapshot().budget).toBe(50);
    }, { purpose: 'unknown' });
    await service.withOperation(async operation => {
      expect(operation.cost.snapshot().budget).toBe(50);
    }, { purpose: undefined });

    const supplied = service.createOperation();
    expect(supplied.cost.snapshot().budget).toBe(50);
    await expect(service.retrieve({
      ...paidRequest,
      strategy: 'direct',
      documentFormat: 'html'
    }, supplied)).resolves.toBeDefined();
    expect(supplied.cost.snapshot().budget).toBe(50);
    supplied.dispose();

    const seenBudgets: number[] = [];
    const mixedService = new RetrievalService({
      directProvider: provider('direct', async (_request, operation) => {
        seenBudgets.push(operation.cost.snapshot().budget);
        return response('direct', 'direct', { known: true, credits: 0 });
      }),
      scrapingAntProvider: provider('paid', async () => response('paid')),
      configuration,
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    await mixedService.retrieveWithStrategies([
      { request: { ...paidRequest, strategy: 'direct', documentFormat: 'html' } },
      { request: { ...paidRequest, purpose: 'scholar_search', strategy: 'direct', documentFormat: 'html' } }
    ]);
    expect(seenBudgets).toEqual([50, 50]);

    const explicitConfiguration = parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: 'test-key',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '17',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '4'
    });
    const explicitService = new RetrievalService({
      directProvider: provider('direct', async () => response('direct', 'direct', { known: true, credits: 0 })),
      scrapingAntProvider: provider('paid', async () => response('paid')),
      configuration: explicitConfiguration,
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    await explicitService.withOperation(async operation => {
      expect(operation.cost.snapshot().budget).toBe(17);
    }, { purpose: 'publisher_discovery' });
  });

  it('cancels a queued request when its independent request signal aborts', async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const retrieve = jest.fn(async (_request: unknown, _context: RetrievalOperationContext) => {
      firstStarted();
      await firstRelease;
      return response('paid');
    });
    const service = serviceWith(retrieve, undefined, { maxConcurrency: 1 });
    const firstOperation = service.createOperation();
    const first = service.retrieve(paidRequest, firstOperation);
    await firstReady;

    const requestController = new AbortController();
    const secondOperation = service.createOperation();
    const second = service.retrieve({ ...paidRequest, signal: requestController.signal }, secondOperation);
    requestController.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(retrieve).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    firstOperation.dispose();
    secondOperation.dispose();
  });

  it('cancels queued work when the parent aborts while a request signal remains live', async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const retrieve = jest.fn(async (_request: unknown, _context: RetrievalOperationContext) => {
      firstStarted();
      await firstRelease;
      return response('paid');
    });
    const service = serviceWith(retrieve, undefined, { maxConcurrency: 1 });
    const firstOperation = service.createOperation();
    const first = service.retrieve(paidRequest, firstOperation);
    await firstReady;

    const parentController = new AbortController();
    const requestController = new AbortController();
    const secondOperation = service.createOperation({ signal: parentController.signal });
    const second = service.retrieve({ ...paidRequest, signal: requestController.signal }, secondOperation);
    parentController.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(requestController.signal.aborted).toBe(false);
    expect(retrieve).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    firstOperation.dispose();
    secondOperation.dispose();
  });

  it('cancels an operation queued behind another attempt without dispatching it', async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const retrieve = jest.fn(async (_request: unknown, _context: RetrievalOperationContext) => {
      firstStarted();
      await firstRelease;
      return response('paid');
    });
    const service = serviceWith(retrieve, undefined, { maxConcurrency: 1 });
    const firstOperation = service.createOperation();
    const first = service.retrieve(paidRequest, firstOperation);
    await firstReady;

    const controller = new AbortController();
    const secondOperation = service.createOperation({ signal: controller.signal });
    const second = service.retrieve(paidRequest, secondOperation);
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'cancelled' });
    expect(retrieve).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    firstOperation.dispose();
    secondOperation.dispose();
  });

  it('shares one parent budget while continuing paid dispatch after unknown cost', async () => {
    const retrieve = jest.fn(async () => response('paid', 'static', { known: false, credits: null, reason: 'missing_billing_header' }));
    const direct = jest.fn(async () => response('direct', 'direct', { known: true, credits: 0 }));
    const service = serviceWith(retrieve, direct, { budget: 10 });

    await service.withOperation(async operation => {
      await expect(service.retrieve(paidRequest, operation)).resolves.toBeDefined();
      await expect(service.retrieve(paidRequest, operation)).resolves.toBeDefined();
      await expect(service.retrieve({ ...paidRequest, strategy: 'direct', documentFormat: 'html' }, operation)).resolves.toBeDefined();
      expect(retrieve).toHaveBeenCalledTimes(2);
      expect(direct).toHaveBeenCalledTimes(1);
      expect(operation.cost.snapshot()).toEqual(expect.objectContaining({
        admissionUsed: 2,
        unknownCostAttempts: 2,
        reportedCreditsKnown: false,
        paidClosed: false
      }));
    });
  });

  it('notifies benchmark callers with a sanitized error and linked reservation', async () => {
    const onError = jest.fn();
    const retrieve = jest.fn(async () => {
      throw new RetrievalError({
        code: 'timeout',
        message: 'provider detail must not escape',
        provider: 'paid',
        failureKind: 'transport_timeout',
        cost: { known: false, credits: null, reason: 'provider_timeout' }
      });
    });
    const service = serviceWith(retrieve);
    const operation = service.createOperation({ onError, purpose: 'publisher_discovery' });

    await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({
      code: 'timeout',
      failureKind: 'transport_timeout',
      cost: { known: false, credits: null, reason: 'provider_timeout' }
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      code: 'timeout',
      failureKind: 'transport_timeout',
      cost: { known: false, credits: null }
    });
    expect(onError.mock.calls[0][1]).toEqual(expect.objectContaining({ estimate: 1 }));
    operation.dispose();
  });

  it('does not share budgets between independent operations', async () => {
    const retrieve = jest.fn(async () => response('paid'));
    const service = serviceWith(retrieve, undefined, { budget: 1 });

    await service.withOperation(operation => service.retrieve(paidRequest, operation));
    await service.withOperation(operation => service.retrieve(paidRequest, operation));
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('releases no-dispatch admission when an operation is cancelled before the provider call', async () => {
    const retrieve = jest.fn(async () => response('paid'));
    const service = serviceWith(retrieve, undefined, { budget: 1 });
    const controller = new AbortController();
    controller.abort();
    const operation = service.createOperation({ signal: controller.signal });

    await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({ code: 'cancelled' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(operation.cost.snapshot().reservedCredits).toBe(0);
    operation.dispose();
  });

  it('releases an admission when cancellation lands before provider invocation', async () => {
    const controller = new AbortController();
    const retrieve = jest.fn(async () => response('paid'));
    const costPolicy = new RetrievalCostPolicy({ enabled: true, budget: 10 });
    const originalCreateLedger = costPolicy.createLedger.bind(costPolicy);
    (costPolicy as any).createLedger = () => {
      const ledger = originalCreateLedger();
      const originalReserve = ledger.reserve.bind(ledger);
      ledger.reserve = (estimate: number) => {
        const reservation = originalReserve(estimate);
        controller.abort();
        return reservation;
      };
      return ledger;
    };
    const service = new RetrievalService({
      directProvider: provider('direct', async () => response('direct', 'direct', { known: true, credits: 0 })),
      scrapingAntProvider: provider('paid', retrieve),
      costPolicy,
      configuration: {
        ...parseRetrievalConfiguration({} as NodeJS.ProcessEnv),
        scrapingAnt: {
          ...parseRetrievalConfiguration({} as NodeJS.ProcessEnv).scrapingAnt,
          apiKey: 'test-key',
          configured: true,
          enabled: true,
          paidEnabled: true,
          browserAllowed: false
        }
      },
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const operation = service.createOperation({ signal: controller.signal });

    try {
      await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({ code: 'cancelled' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(retrieve).not.toHaveBeenCalled();
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 0,
        admissionUsed: 0,
        reservedCredits: 0,
        unknownCostAttempts: 0
      }));
    } finally {
      operation.dispose();
    }
  });

  it('retries one static strategy at most twice and releases the attempt between retries', async () => {
    const attempts: number[] = [];
    const retrieve = jest.fn(async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) {
        throw new RetrievalError({ code: 'server_error', message: 'safe', provider: 'paid', status: 503, retryable: true, cost: { known: true, credits: 1 } });
      }
      return response('paid');
    });
    const sleeps: number[] = [];
    const service = serviceWith(retrieve, undefined, {
      retrySleep: async milliseconds => { sleeps.push(milliseconds); },
      retryRandom: () => 0
    });

    await service.withOperation(operation => service.retrieveWithRetry(paidRequest, operation));
    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it('retries a static unknown-cost failure while local admission remains available', async () => {
    const strategies: string[] = [];
    const retrieve = jest.fn(async (request: RetrievalRequest) => {
      strategies.push(request.strategy);
      if (strategies.length === 1) {
        throw new RetrievalError({
          code: 'detected',
          message: 'temporary provider detection',
          provider: 'paid',
          retryable: true,
          cost: { known: false, credits: null, reason: 'missing_billing_header' }
        });
      }
      return response('paid', 'static', { known: true, credits: 1 });
    });
    const service = serviceWith(retrieve, undefined, {
      budget: 10,
      retrySleep: async () => undefined,
      retryRandom: () => 0
    });

    await service.withOperation(async operation => {
      await expect(service.retrieveWithRetry(paidRequest, operation)).resolves.toBeDefined();
      expect(strategies).toEqual(['static', 'static']);
      expect(operation.cost.snapshot()).toEqual(expect.objectContaining({
        admissionUsed: 2,
        reportedCredits: 1,
        reportedCreditsKnown: false,
        unknownCostAttempts: 1,
        paidClosed: false
      }));
    });
  });

  it('continues to the next paid combination after bounded unknown-cost retries', async () => {
    const combinations: string[] = [];
    const retrieve = jest.fn(async (request: RetrievalRequest) => {
      combinations.push(`${request.strategy}:${request.proxyType}`);
      if (request.strategy === 'static') {
        throw new RetrievalError({
          code: 'detected',
          message: 'temporary provider detection',
          provider: 'paid',
          retryable: true,
          cost: { known: false, credits: null, reason: 'missing_billing_header' }
        });
      }
      return response('paid', 'browser', { known: true, credits: 1 });
    });
    const service = serviceWith(retrieve, undefined, {
      budget: 50,
      retrySleep: async () => undefined,
      retryRandom: () => 0,
      browserAllowed: true
    });
    const operation = service.createOperation();
    try {
      const result = await service.retrieveWithStrategies([
        {
          request: { ...paidRequest, strategy: 'static', proxyType: 'datacenter' },
          continueOnError: () => true
        },
        {
          request: { ...paidRequest, strategy: 'browser', proxyType: 'datacenter' },
          isTerminalResponse: () => true
        }
      ], operation, { maxPaidStrategySelections: 4, maxBrowserDispatches: 2 });

      expect(result.strategy).toBe('browser');
      expect(combinations).toEqual(['static:datacenter', 'static:datacenter', 'static:datacenter', 'browser:datacenter']);
      expect(operation.cost.snapshot()).toEqual(expect.objectContaining({
        admissionUsed: 13,
        reportedCredits: 1,
        reportedCreditsKnown: false,
        unknownCostAttempts: 3,
        paidClosed: false
      }));
    } finally {
      operation.dispose();
    }
  });

  it('does not let unknown billing bypass a terminal provider failure', async () => {
    let attempts = 0;
    const retrieve = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new RetrievalError({
          code: 'detected',
          message: 'temporary provider detection',
          provider: 'paid',
          retryable: true,
          cost: { known: false, credits: null, reason: 'missing_billing_header' }
        });
      }
      throw new RetrievalError({
        code: 'auth_or_credits_unknown',
        message: 'provider authorization failed',
        provider: 'paid',
        apiStatus: 403,
        cost: { known: false, credits: null, reason: 'missing_billing_header' }
      });
    });
    const service = serviceWith(retrieve, undefined, {
      budget: 10,
      retrySleep: async () => undefined,
      retryRandom: () => 0
    });

    await service.withOperation(async operation => {
      await expect(service.retrieveWithRetry(paidRequest, operation)).rejects.toMatchObject({
        code: 'auth_or_credits_unknown',
        apiStatus: 403
      });
      expect(attempts).toBe(2);
      expect(operation.cost.snapshot()).toEqual(expect.objectContaining({
        admissionUsed: 2,
        unknownCostAttempts: 2,
        reportedCreditsKnown: false,
        paidClosed: true,
        paidClosedReason: 'provider_error'
      }));
    });
  });

  it('keeps full-jitter retry delays within the 250ms and 500ms bounds', async () => {
    let attempts = 0;
    const retrieve = jest.fn(async () => {
      attempts++;
      if (attempts < 3) {
        throw new RetrievalError({
          code: 'server_error',
          message: 'temporary',
          provider: 'paid',
          status: 503,
          retryable: true,
          cost: { known: true, credits: 1 }
        });
      }
      return response('paid');
    });
    const sleeps: number[] = [];
    const service = serviceWith(retrieve, undefined, {
      retrySleep: async milliseconds => { sleeps.push(milliseconds); },
      retryRandom: () => 1
    });

    await service.withOperation(operation => service.retrieveWithRetry({ ...paidRequest, strategy: 'static' }, operation));
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThanOrEqual(250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(0);
    expect(sleeps[1]).toBeLessThanOrEqual(500);
  });

  it('cancels retry backoff without dispatching the next attempt', async () => {
    let retrySleepStarted!: () => void;
    const retrySleep = jest.fn((_milliseconds: number, signal?: AbortSignal) => {
      retrySleepStarted();
      return new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('retry sleep cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    const retrieve = jest.fn(async () => {
      throw new RetrievalError({
        code: 'server_error',
        message: 'retryable',
        provider: 'paid',
        status: 503,
        retryable: true,
        cost: { known: true, credits: 1 }
      });
    });
    const service = serviceWith(retrieve, undefined, {
      retrySleep,
      retryRandom: () => 1
    });
    const operation = service.createOperation();
    const retryStarted = new Promise<void>(resolve => {
      retrySleepStarted = resolve;
    });
    const pending = service.retrieveWithRetry(paidRequest, operation);
    await retryStarted;
    operation.dispose();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrySleep).toHaveBeenCalledWith(expect.any(Number), expect.any(AbortSignal));
  });

  it('does not retry a browser strategy or provider 403 and closes paid admission', async () => {
    const browserRetrieve = jest.fn(async () => {
      throw new RetrievalError({ code: 'server_error', message: 'safe', provider: 'paid', status: 503, retryable: true, cost: { known: true, credits: 1 } });
    });
    const browserService = serviceWith(browserRetrieve, undefined, { retrySleep: async () => undefined, browserAllowed: true });
    await expect(browserService.withOperation(operation => browserService.retrieveWithRetry({ ...paidRequest, strategy: 'browser' }, operation)))
      .rejects.toMatchObject({ code: 'server_error' });
    expect(browserRetrieve).toHaveBeenCalledTimes(1);

    const forbiddenRetrieve = jest.fn(async () => {
      throw new RetrievalError({ code: 'auth_or_credits_unknown', message: 'safe', provider: 'paid', status: 403, retryable: false, cost: { known: true, credits: 1 } });
    });
    const forbiddenService = serviceWith(forbiddenRetrieve);
    const operation = forbiddenService.createOperation();
    await expect(forbiddenService.retrieveWithRetry(paidRequest, operation)).rejects.toMatchObject({ code: 'auth_or_credits_unknown' });
    expect(forbiddenRetrieve).toHaveBeenCalledTimes(1);
    expect(operation.cost.snapshot().paidClosed).toBe(true);
    expect(operation.cost.snapshot().paidClosedReason).toBe('provider_error');
    operation.dispose();
  });

  it('atomically limits browser dispatches across repeated retry calls', async () => {
    const retrieve = jest.fn(async (request: RetrievalRequest) => response('paid', request.strategy));
    const service = serviceWith(retrieve, undefined, { browserAllowed: true });
    const operation = service.createOperation();
    await expect(service.retrieveWithRetry({ ...paidRequest, strategy: 'browser' }, operation)).resolves.toBeDefined();
    await expect(service.retrieveWithRetry({ ...paidRequest, strategy: 'browser' }, operation)).resolves.toBeDefined();
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(service.getOperationStatus(operation).strategyCounts.browser).toBe(1);
    operation.dispose();
  });

  it('counts dispatches per normalized combination and permits the two browser combinations independently', async () => {
    const retrieve = jest.fn(async (request: RetrievalRequest) => response('paid', request.strategy));
    const configuration = parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: 'key',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_PROXY_TYPE: 'residential'
    });
    const paidProvider: RetrievalProvider = {
      ...provider('paid', retrieve),
      capabilities: {
        html: true,
        iframeDocuments: true,
        pdfCandidates: true,
        browser: true,
        paid: true,
        proxyTypes: ['datacenter', 'residential'],
        combinations: ['static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential']
      }
    };
    const service = new RetrievalService({
      directProvider: provider('direct', async () => response('direct', 'direct', { known: true, credits: 0 })),
      scrapingAntProvider: paidProvider,
      configuration,
      costPolicy: new RetrievalCostPolicy({ budget: 200, maxCreditsPerRequest: 125, enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const operation = service.createOperation();
    const scope = 'publisher-doi-scope';
    const staticDc = { ...paidRequest, strategy: 'static' as const, proxyType: 'datacenter' as const };

    try {
      await expect(service.retrieveWithRetry(staticDc, operation, { strategyScopeId: scope }))
        .resolves.toBeDefined();
      await expect(service.retrieveWithRetry(staticDc, operation, { strategyScopeId: scope }))
        .resolves.toBeDefined();
      expect(retrieve).toHaveBeenCalledTimes(1);

      await expect(service.retrieveWithRetry({ ...staticDc, strategy: 'browser' }, operation, { strategyScopeId: scope }))
        .resolves.toBeDefined();
      await expect(service.retrieveWithRetry({ ...staticDc, strategy: 'browser' }, operation, { strategyScopeId: scope }))
        .resolves.toBeDefined();
      await expect(service.retrieveWithRetry({ ...staticDc, strategy: 'browser', proxyType: 'residential' }, operation, { strategyScopeId: scope }))
        .resolves.toBeDefined();
    } finally {
      operation.dispose();
    }

    expect(retrieve).toHaveBeenCalledTimes(3);
    expect(service.getOperationStatus(operation).strategyCounts).toEqual(expect.objectContaining({ static: 1, browser: 2 }));
  });

  it('drops raw provider documents from completed strategy re-entry snapshots', async () => {
    const retrieve = jest.fn(async () => ({
      ...response('paid'),
      document: {
        ...response('paid').document!,
        html: '<html>secret provider body</html>'
      }
    }));
    const service = serviceWith(retrieve);
    const operation = service.createOperation();
    try {
      const first = await service.retrieveWithRetry(paidRequest, operation, { strategyScopeId: 'bounded-cache' });
      const second = await service.retrieveWithRetry(paidRequest, operation, { strategyScopeId: 'bounded-cache' });
      expect(first.document?.html).toContain('secret provider body');
      expect(second.document).toBeUndefined();
      expect(JSON.stringify(second)).not.toContain('secret provider body');
      expect(retrieve).toHaveBeenCalledTimes(1);
    } finally {
      operation.dispose();
    }
  });

  it('shares one strategy flight across concurrent waiters while isolating waiter cancellation', async () => {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const retrieve = jest.fn(async () => {
      started();
      await gate;
      return response('paid');
    });
    const service = serviceWith(retrieve);
    const operation = service.createOperation();
    const firstController = new AbortController();
    const first = service.retrieveWithRetry({ ...paidRequest, signal: firstController.signal }, operation, {
      strategyScopeId: 'concurrent-scope'
    });
    await ready;
    const second = service.retrieveWithRetry({ ...paidRequest }, operation, {
      strategyScopeId: 'concurrent-scope'
    });

    firstController.abort();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    release();
    await expect(second).resolves.toMatchObject({ combination: 'static:datacenter' });
    expect(retrieve).toHaveBeenCalledTimes(1);
    operation.dispose();
  });

  it('scopes browser limits to independent business sub-scopes while sharing one ledger', async () => {
    const retrieve = jest.fn(async (request: RetrievalRequest) => response('paid', request.strategy));
    const service = serviceWith(retrieve, undefined, { browserAllowed: true });
    const operation = service.createOperation();
    const browserRequest = { ...paidRequest, strategy: 'browser' as const };

    await service.retrieveWithStrategies([{ request: browserRequest }], operation, {
      scopeId: 'doi-0',
      maxPaidStrategySelections: 3,
      maxBrowserDispatches: 1
    });
    await service.retrieveWithStrategies([{ request: browserRequest }], operation, {
      scopeId: 'doi-1',
      maxPaidStrategySelections: 3,
      maxBrowserDispatches: 1
    });

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(service.getOperationStatus(operation).strategyCounts.browser).toBe(2);
    expect(operation.cost.snapshot().admissionUsed).toBe(20);
    operation.dispose();
  });

  it('retries unrestricted direct server responses before strategy fallback', async () => {
    let calls = 0;
    const directRetrieve = jest.fn(async () => {
      calls++;
      const directResponse = response('direct', 'direct', { known: true, credits: 0 });
      if (calls < 3) {
        return {
          ...directResponse,
          targetStatus: 503,
          document: { ...directResponse.document!, targetStatus: 503 }
        };
      }
      return directResponse;
    });
    const service = serviceWith(async () => response('paid'), directRetrieve, {
      retrySleep: async () => undefined,
      retryRandom: () => 0
    });
    const operation = service.createOperation();
    try {
      const result = await service.retrieveWithRetry({ ...paidRequest, strategy: 'direct', documentFormat: 'html' }, operation, {
        shouldRetryResponse: response => (response.targetStatus || 0) >= 500
      });
      expect(result.targetStatus).toBe(200);
      expect(directRetrieve).toHaveBeenCalledTimes(3);
    } finally {
      operation.dispose();
    }
  });

  it('keeps direct-first fallback separate from same-strategy retry', async () => {
    const directRetrieve = jest.fn(async () => {
      const directResponse = response('direct', 'direct', { known: true, credits: 0 });
      return {
        ...directResponse,
        targetStatus: 503,
        document: { ...directResponse.document!, targetStatus: 503 }
      };
    });
    const paidRetrieve = jest.fn(async () => response('paid'));
    const service = serviceWith(paidRetrieve, directRetrieve);

    await service.withOperation(operation => service.retrieveWithStrategies([
      {
        request: { ...paidRequest, strategy: 'direct', documentFormat: 'html' },
        isTerminalResponse: candidate => candidate.targetStatus !== 503
      },
      { request: paidRequest }
    ], operation, { maxPaidStrategySelections: 3 }));
    expect(directRetrieve).toHaveBeenCalledTimes(1);
    expect(paidRetrieve).toHaveBeenCalledTimes(1);
  });

  it('advances to the next combination after a reliable detected failure exhausts one static combination', async () => {
    let staticAttempts = 0;
    const retrieve = jest.fn(async (request: RetrievalRequest) => {
      if (request.strategy === 'static') {
        staticAttempts++;
        throw new RetrievalError({
          code: 'detected',
          message: 'temporary detection',
          provider: 'paid',
          status: 423,
          retryable: true,
          cost: { known: true, credits: 1 }
        });
      }
      return response('paid', request.strategy);
    });
    const service = serviceWith(retrieve, undefined, {
      retrySleep: async () => undefined,
      retryRandom: () => 0,
      browserAllowed: true
    });
    const operation = service.createOperation();

    try {
      await expect(service.retrieveWithStrategies([
        { request: paidRequest, continueOnError: () => true },
        { request: { ...paidRequest, strategy: 'browser' }, continueOnError: () => true }
      ], operation, { scopeId: 'detected-scope', maxPaidStrategySelections: 4, maxBrowserDispatches: 2 }))
        .resolves.toMatchObject({ strategy: 'browser' });
      expect(staticAttempts).toBe(3);
      expect(retrieve).toHaveBeenCalledTimes(4);
      expect(operation.cost.snapshot().paidClosed).toBe(false);
    } finally {
      operation.dispose();
    }
  });

  it('advances Scholar from billed ScrapingAnt API 423 detections to browser retrieval', async () => {
    let schedulerNow = 0;
    const scheduler = new PublicSourceDispatchScheduler({
      now: () => schedulerNow,
      sleep: async milliseconds => {
        schedulerNow += milliseconds;
      }
    });
    const providerRequests: unknown[] = [];
    const responses = [
      { status: 423, headers: { 'Ant-credits-cost': '0' }, data: { detail: 'anti-bot' } },
      { status: 423, headers: { 'Ant-credits-cost': '0' }, data: { detail: 'anti-bot' } },
      { status: 423, headers: { 'Ant-credits-cost': '0' }, data: { detail: 'anti-bot' } },
      { status: 200, headers: { 'Ant-credits-cost': '10' }, data: { html: '<html>browser result</html>' } }
    ];
    const paidProvider = new ScrapingAntProvider({
      apiKey: 'test-key',
      sourceScheduler: scheduler,
      client: {
        request: jest.fn(async config => {
          providerRequests.push(config);
          return responses.shift()!;
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
    const service = new RetrievalService({
      directProvider: provider('direct', async () => response('direct', 'direct', { known: true, credits: 0 })),
      scrapingAntProvider: paidProvider,
      configuration,
      costPolicy: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl }),
      retrySleep: async () => undefined,
      retryRandom: () => 0
    });
    const operation = service.createOperation({ purpose: 'scholar_search' });
    const request = {
      url: 'https://scholar.google.com/scholar',
      purpose: 'scholar_search' as const,
      documentFormat: 'html' as const
    };
    try {
      const result = await service.retrieveWithStrategies([
        {
          request: { ...request, strategy: 'direct' as const },
          isTerminalResponse: () => false,
          continueOnError: () => true
        },
        {
          request: { ...request, strategy: 'static' as const },
          continueOnError: () => true
        },
        {
          request: { ...request, strategy: 'browser' as const },
          continueOnError: () => true
        }
      ], operation, { scopeId: 'scholar-423-fallback', maxPaidStrategySelections: 4, maxBrowserDispatches: 2 });

      expect(result.strategy).toBe('browser');
      expect(providerRequests).toHaveLength(4);
      expect((providerRequests[3] as any).params.browser).toBe(true);
      expect(operation.cost.snapshot()).toEqual(expect.objectContaining({
        unknownCostAttempts: 0,
        paidClosed: false
      }));
    } finally {
      operation.dispose();
    }
  });

  it('limits a browser plan to one actual dispatch and does not bypass a provider error with paid retry', async () => {
    const staticRetrieve = jest.fn(async (_request?: unknown, _context?: unknown) => {
      throw new RetrievalError({ code: 'auth_or_credits_unknown', message: 'safe', provider: 'paid', status: 403, cost: { known: true, credits: 1 } });
    });
    const browserRetrieve = jest.fn(async (_request?: unknown, _context?: unknown) => {
      throw new RetrievalError({ code: 'server_error', message: 'safe', provider: 'paid', status: 503, retryable: true, cost: { known: true, credits: 1 } });
    });
    // Replace the paid provider with a provider that distinguishes static/browser.
    const browserService = new RetrievalService({
      directProvider: provider('direct', async () => response('direct', 'direct', { known: true, credits: 0 })),
      scrapingAntProvider: {
        ...provider('paid', async (request) => request.strategy === 'browser'
          ? browserRetrieve(request, {} as RetrievalOperationContext)
          : staticRetrieve(request, {} as RetrievalOperationContext)),
        capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true }
      },
      costPolicy: new RetrievalCostPolicy({ enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl }),
      retrySleep: async () => undefined,
      retryRandom: () => 0
    });
    const operation = browserService.createOperation();
    await expect(browserService.retrieveWithStrategies([
      { request: paidRequest, continueOnError: () => true },
      { request: { ...paidRequest, strategy: 'browser' }, continueOnError: () => true },
      { request: { ...paidRequest, strategy: 'browser' } }
    ], operation, { maxPaidStrategySelections: 3, maxBrowserDispatches: 1 })).rejects.toMatchObject({ code: 'auth_or_credits_unknown' });
    expect(staticRetrieve).toHaveBeenCalledTimes(1);
    expect(browserRetrieve).toHaveBeenCalledTimes(0);
    operation.dispose();
  });

  it('terminates paid strategy progression for global provider errors', async () => {
    for (const [code, status] of [
      ['invalid_request', 400],
      ['auth_or_credits_unknown', 403],
      ['target_unavailable', 404],
      ['invalid_request', 405],
      ['invalid_request', 422],
      ['provider_error', 429]
    ] as const) {
      const retrieve = jest.fn(async () => {
        throw new RetrievalError({
          code,
          message: 'provider failure',
          provider: 'paid',
          status,
          apiStatus: status,
          cost: { known: true, credits: 1 }
        });
      });
      const service = serviceWith(retrieve, undefined, { browserAllowed: true });
      const operation = service.createOperation();
      try {
        await expect(service.retrieveWithStrategies([
          { request: paidRequest, continueOnError: () => true },
          { request: { ...paidRequest, strategy: 'browser' } }
        ], operation, { scopeId: `global-error-${status}`, maxPaidStrategySelections: 4, maxBrowserDispatches: 2 }))
          .rejects.toMatchObject({ code });
        expect(retrieve).toHaveBeenCalledTimes(1);
        expect(operation.cost.snapshot().paidClosed).toBe(true);
      } finally {
        operation.dispose();
      }
    }
  });

  it('closes paid admission after a final failure through the single-attempt API', async () => {
    const paidRetrieve = jest.fn(async () => {
      throw new RetrievalError({
        code: 'auth_or_credits_unknown',
        message: 'safe provider failure',
        provider: 'paid',
        status: 403,
        cost: { known: true, credits: 1 }
      });
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();

    await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({ code: 'auth_or_credits_unknown' });
    expect(operation.cost.snapshot().paidClosed).toBe(true);
    await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({ code: 'budget' });
    expect(paidRetrieve).toHaveBeenCalledTimes(1);
    operation.dispose();
  });

  it('classifies provider cancellation caused by the operation deadline as timeout', async () => {
    jest.useFakeTimers();
    try {
      let providerStarted!: () => void;
      const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
      const paidRetrieve = jest.fn(async (_request: unknown, context: RetrievalOperationContext) => {
        providerStarted();
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new RetrievalError({
            code: 'cancelled',
            message: 'provider observed abort',
            provider: 'paid',
            cost: { known: false, credits: null, reason: 'abort' }
          })), { once: true });
        });
        return response('paid');
      });
      const service = serviceWith(paidRetrieve, undefined, { operationTimeoutMs: 100 });
      const operation = service.createOperation();
      const pending = service.retrieveWithRetry(paidRequest, operation);
      await providerReady;
      const result = expect(pending).rejects.toMatchObject({
        code: 'timeout',
        provider: 'paid',
        cost: { known: false, credits: null }
      });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);
      await result;
      operation.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves deadline timeout precedence over a late structured provider error', async () => {
    jest.useFakeTimers();
    try {
      let rejectLate!: (error: RetrievalError) => void;
      let providerStarted!: () => void;
      const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
      const lateFailure = new Promise<RetrievalResponse>((_resolve, reject) => { rejectLate = reject; });
      const paidRetrieve = jest.fn(async () => {
        providerStarted();
        return lateFailure;
      });
      const service = serviceWith(paidRetrieve, undefined, { operationTimeoutMs: 100 });
      const operation = service.createOperation();
      const pending = service.retrieveWithRetry(paidRequest, operation);
      await providerReady;
      const result = expect(pending).rejects.toMatchObject({ code: 'timeout', provider: 'paid' });
      await jest.advanceTimersByTimeAsync(100);
      await result;

      rejectLate(new RetrievalError({
        code: 'server_error',
        message: 'late provider failure',
        provider: 'paid',
        status: 503,
        cost: { known: true, credits: 2 }
      }));
      await Promise.resolve();
      await Promise.resolve();
      await jest.runAllTimersAsync();
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        admissionUsed: 2,
        reportedCredits: 2,
        paidClosed: false
      }));
      operation.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves direct-provider identity when its in-flight deadline aborts', async () => {
    jest.useFakeTimers();
    try {
      let providerStarted!: () => void;
      const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
      const directRetrieve = jest.fn(async (_request: unknown, context: RetrievalOperationContext) => {
        providerStarted();
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new RetrievalError({
            code: 'cancelled',
            message: 'provider observed abort',
            provider: 'direct',
            cost: { known: true, credits: 0 }
          })), { once: true });
        });
        return response('direct', 'direct', { known: true, credits: 0 });
      });
      const service = serviceWith(async () => response('paid'), directRetrieve, { operationTimeoutMs: 100 });
      const operation = service.createOperation();
      const pending = service.retrieveWithRetry({ ...paidRequest, strategy: 'direct' }, operation);
      await providerReady;
      const result = expect(pending).rejects.toMatchObject({ code: 'timeout', provider: 'direct', cost: { known: true, credits: 0 } });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);
      await result;
      operation.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('records known zero credits from a paid error as the latest observation', async () => {
    let attempt = 0;
    const paidRetrieve = jest.fn(async () => {
      if (attempt++ === 0) return response('paid', 'static', { known: true, credits: 3 });
      throw new RetrievalError({
        code: 'server_error',
        message: 'known zero-cost failure',
        provider: 'paid',
        retryable: false,
        cost: { known: true, credits: 0 }
      });
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    await service.retrieve(paidRequest, operation);
    await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({ code: 'server_error' });

    expect(service.getProcessStatus()).toEqual(expect.objectContaining({
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      lastRequestCredits: 0
    }));
    operation.dispose();
  });

  it('records a same-turn late zero-cost observation after cancellation settlement', async () => {
    let resolveProvider!: (response: RetrievalResponse) => void;
    let providerStarted!: () => void;
    const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
    const providerResponse = new Promise<RetrievalResponse>(resolve => { resolveProvider = resolve; });
    const paidRetrieve = jest.fn(async () => {
      providerStarted();
      return providerResponse;
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    const requestController = new AbortController();
    requestController.signal.addEventListener('abort', () => resolveProvider(response('paid', 'static', { known: true, credits: 0 })), { once: true });
    const pending = service.retrieveWithRetry({ ...paidRequest, signal: requestController.signal }, operation);
    await providerReady;
    requestController.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.getProcessStatus()).toEqual(expect.objectContaining({
      reportedCredits: 0,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      lastRequestCredits: 0
    }));
    operation.dispose();
  });

  it('does not let an older late positive cost overwrite newer diagnostics', async () => {
    let resolveLate!: (response: RetrievalResponse) => void;
    let providerStarted!: () => void;
    const lateResponse = new Promise<RetrievalResponse>(resolve => { resolveLate = resolve; });
    const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
    let attempt = 0;
    const paidRetrieve = jest.fn(async () => {
      if (attempt++ === 0) {
        providerStarted();
        return lateResponse;
      }
      return response('paid', 'static', { known: true, credits: 1 });
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    const requestController = new AbortController();
    const pending = service.retrieveWithRetry({ ...paidRequest, signal: requestController.signal }, operation);
    await providerReady;
    requestController.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    await service.withOperation(child => service.retrieve(paidRequest, child));
    expect(service.getProcessStatus().lastRequestCredits).toBe(1);

    resolveLate(response('paid', 'static', { known: true, credits: 3 }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.getProcessStatus()).toEqual(expect.objectContaining({
      reportedCredits: 4,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      lastRequestCredits: 1
    }));
    operation.dispose();
  });

  it('updates diagnostics for an accepted late zero cost but ignores duplicate reconciliation', async () => {
    let resolveLate!: (response: RetrievalResponse) => void;
    let providerStarted!: () => void;
    const lateResponse = new Promise<RetrievalResponse>(resolve => { resolveLate = resolve; });
    const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
    let attempt = 0;
    const paidRetrieve = jest.fn(async () => {
      if (attempt++ === 0) {
        providerStarted();
        return lateResponse;
      }
      return response('paid', 'static', { known: true, credits: 1 });
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    const requestController = new AbortController();
    const pending = service.retrieveWithRetry({ ...paidRequest, signal: requestController.signal }, operation);
    await providerReady;
    requestController.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const reservation = service.getOperationReservation(operation, 'retrieval-attempt-1');
    expect(reservation).toBeDefined();

    resolveLate(response('paid', 'static', { known: true, credits: 0 }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.getProcessStatus().lastRequestCredits).toBe(0);

    await service.withOperation(child => service.retrieve(paidRequest, child));
    expect(service.getProcessStatus().lastRequestCredits).toBe(1);
    service.reconcileCost(operation, reservation!, { known: true, credits: 0 });
    expect(service.getProcessStatus().lastRequestCredits).toBe(1);
    operation.dispose();
  });

  it('keeps a same-turn late cost observation until cancellation settlement completes', async () => {
    let resolveProvider!: (response: RetrievalResponse) => void;
    let providerStarted!: () => void;
    const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
    const providerResponse = new Promise<RetrievalResponse>(resolve => { resolveProvider = resolve; });
    const paidRetrieve = jest.fn(async () => {
      providerStarted();
      return providerResponse;
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    const requestController = new AbortController();
    requestController.signal.addEventListener('abort', () => resolveProvider(response('paid', 'static', { known: true, credits: 3 })), { once: true });
    const pending = service.retrieveWithRetry({ ...paidRequest, signal: requestController.signal }, operation);
    await providerReady;
    requestController.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      admissionUsed: 3,
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
    expect(service.getProcessStatus()).toEqual(expect.objectContaining({
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      lastRequestCredits: 3
    }));
    operation.dispose();
  });

  it('reconciles a late paid response after request cancellation without reopening the operation', async () => {
    let resolveLate!: (value: RetrievalResponse) => void;
    const lateResponse = new Promise<RetrievalResponse>(resolve => { resolveLate = resolve; });
    let providerStarted!: () => void;
    const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
    const paidRetrieve = jest.fn(async () => {
      providerStarted();
      return lateResponse;
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    const requestController = new AbortController();
    const pending = service.retrieveWithRetry({ ...paidRequest, signal: requestController.signal }, operation);
    await providerReady;
    requestController.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled', provider: 'paid' });
    const settled = service.getOperationStatus(operation);
    expect(settled).toEqual(expect.objectContaining({
      admissionUsed: 1,
      reservedCredits: 0,
      reportedCredits: 0,
      reportedCreditsKnown: false,
      unknownCostAttempts: 1,
      paidClosed: false
    }));

    resolveLate(response('paid', 'static', { known: true, credits: 3 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      admissionUsed: 3,
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
    expect(paidRetrieve).toHaveBeenCalledTimes(1);
    operation.dispose();
  });

  it('reconciles late cost carried by a cancelled compatibility provider error', async () => {
    let rejectProvider!: (error: RetrievalError) => void;
    let providerStarted!: () => void;
    let resolveLateCost!: (observation: RetrievalCostObservation) => void;
    const providerReady = new Promise<void>(resolve => { providerStarted = resolve; });
    const lateCost = new Promise<RetrievalCostObservation>(resolve => { resolveLateCost = resolve; });
    const providerOutcome = new Promise<RetrievalResponse>((_resolve, reject) => { rejectProvider = reject; });
    const paidRetrieve = jest.fn(async () => {
      providerStarted();
      return providerOutcome;
    });
    const service = serviceWith(paidRetrieve);
    const operation = service.createOperation();
    const requestController = new AbortController();
    const pending = service.retrieveWithRetry({ ...paidRequest, signal: requestController.signal }, operation);
    await providerReady;
    requestController.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    rejectProvider(new RetrievalError({
      code: 'cancelled',
      message: 'compatibility transport cancelled',
      provider: 'paid',
      cost: { known: false, credits: null, reason: 'cancelled_before_provider_completion' },
      lateCost
    }));
    resolveLateCost({ known: true, credits: 3 });
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
      admissionUsed: 3,
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
    operation.dispose();
  });

  it('allows safe direct retrieval after a known paid cost exceeds the budget', async () => {
    const paidRetrieve = jest.fn(async () => response('paid', 'static', { known: true, credits: 6 }));
    const directRetrieve = jest.fn(async () => response('direct', 'direct', { known: true, credits: 0 }));
    const service = serviceWith(paidRetrieve, directRetrieve, { budget: 5 });

    await service.withOperation(async operation => {
      await service.retrieve(paidRequest, operation);
      expect(operation.cost.snapshot()).toEqual(expect.objectContaining({
        paidClosed: true,
        paidClosedReason: 'actual_cost_exceeded'
      }));
      await expect(service.retrieveWithRetry({ ...paidRequest, strategy: 'direct', documentFormat: 'html' }, operation)).resolves.toBeDefined();
    });
    expect(directRetrieve).toHaveBeenCalledTimes(1);
  });

  it('counts each observable direct HTTP redirect separately from one retrieval attempt', async () => {
    const clientRequest: any = jest.fn();
    clientRequest.mockResolvedValueOnce({ status: 302, headers: { location: 'https://publisher.example/final' }, data: undefined });
    clientRequest.mockResolvedValueOnce({ status: 200, headers: {}, data: '<html>ok</html>' });
    const publicHttpClient = new (await import('../../src/services/PublicHttpClient.js')).PublicHttpClient({
      client: { request: clientRequest },
      validateUrl: async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 as const }]
      })
    });
    const directProvider = new (await import('../../src/retrieval/DirectHttpProvider.js')).DirectHttpProvider({ publicHttpClient });
    const service = new RetrievalService({
      directProvider,
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const operation = service.createOperation();

    try {
      await expect(service.retrieve({
        url: 'https://publisher.example/start',
        purpose: 'publisher_discovery',
        strategy: 'direct',
        documentFormat: 'html'
      }, operation)).resolves.toMatchObject({ combination: 'direct:datacenter' });
      expect(service.getOperationStatus(operation)).toEqual(expect.objectContaining({
        requestCount: 1,
        httpDispatchCount: 2
      }));
    } finally {
      operation.dispose();
    }
  });

  it('rejects an unsafe target before dispatch', async () => {
    const retrieve = jest.fn(async () => response('paid'));
    const rejectedPolicy = new OutboundSecurityPolicy({
      validatePublicUrl: async () => { throw new Error('private target'); }
    });
    const service = new RetrievalService({
      directProvider: provider('direct', retrieve),
      scrapingAntProvider: provider('paid', retrieve),
      costPolicy: new RetrievalCostPolicy({ enabled: true }),
      securityPolicy: rejectedPolicy
    });

    await expect(service.withOperation(operation => service.retrieve(paidRequest, operation)))
      .rejects.toMatchObject({ code: 'security' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('cancels an in-flight public-target validation without dispatching', async () => {
    const retrieve = jest.fn(async () => response('direct', 'direct', { known: true, credits: 0 }));
    const securityPolicy = new OutboundSecurityPolicy({
      validatePublicUrl: async () => new Promise<never>(() => undefined)
    });
    const service = new RetrievalService({
      directProvider: provider('direct', retrieve),
      costPolicy: new RetrievalCostPolicy({ enabled: false }),
      securityPolicy
    });
    const operation = service.createOperation();
    const requestController = new AbortController();
    const pending = service.retrieve({ ...paidRequest, strategy: 'direct', signal: requestController.signal }, operation);
    const result = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await Promise.resolve();
    requestController.abort();
    await result;
    expect(retrieve).not.toHaveBeenCalled();
    operation.dispose();
  });

  it('does not let a cooling Scholar source occupy the shared transport slot', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const request = jest.fn(async (_config: any) => ({ status: 200, headers: {}, data: '<html />' }));
    const validate = async (url: string) => ({
      url,
      hostname: new URL(url).hostname,
      addresses: [{ address: '93.184.216.34', family: 4 as const }]
    });
    const publisherClient = new PublicHttpClient({
      purpose: 'publisher_discovery',
      sourceScheduler: scheduler,
      client: { request },
      validateUrl: validate
    });
    const scholarClient = new PublicHttpClient({
      purpose: 'scholar_search',
      sourceScheduler: scheduler,
      client: { request },
      validateUrl: validate
    });
    const service = new RetrievalService({
      directProvider: new DirectHttpProvider({
        publicHttpClient: publisherClient,
        publicHttpClients: { scholar_search: scholarClient }
      }),
      configuration: parseRetrievalConfiguration({} as NodeJS.ProcessEnv),
      costPolicy: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validate }),
      maxConcurrency: 1,
      operationTimeoutMs: 100_000,
      now: () => now
    });
    scheduler.observeRetryAfter('https://scholar.google.com', 429, { 'retry-after': '10' });

    try {
      const scholar = service.retrieve({
        url: 'https://scholar.google.com/scholar?q=waiting',
        purpose: 'scholar_search',
        strategy: 'direct',
        documentFormat: 'html'
      });
      await Promise.resolve();
      const publisher = service.retrieve({
        url: 'https://publisher.example/article',
        purpose: 'publisher_discovery',
        strategy: 'direct',
        documentFormat: 'html'
      });

      await expect(publisher).resolves.toBeDefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0].url).toBe('https://publisher.example/article');

      now = 10_000;
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(scholar).resolves.toBeDefined();
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1][0].url).toBe('https://scholar.google.com/scholar?q=waiting');
    } finally {
      scheduler.reset();
      jest.useRealTimers();
    }
  });

  it('records Scholar pacing after global-slot contention, not source-lease acquisition', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    let releasePublisher!: () => void;
    const publisherGate = new Promise<void>(resolve => { releasePublisher = resolve; });
    const scholarDispatchTimes: number[] = [];
    const request = jest.fn(async (config: any) => {
      const url = String(config.url);
      if (url.startsWith('https://publisher.example')) {
        await publisherGate;
      } else {
        scholarDispatchTimes.push(now);
      }
      return { status: 200, headers: {}, data: '<html />' };
    });
    const validate = async (url: string) => ({
      url,
      hostname: new URL(url).hostname,
      addresses: [{ address: '93.184.216.34', family: 4 as const }]
    });
    const publisherClient = new PublicHttpClient({ purpose: 'publisher_discovery', sourceScheduler: scheduler, client: { request }, validateUrl: validate });
    const scholarClient = new PublicHttpClient({ purpose: 'scholar_search', sourceScheduler: scheduler, client: { request }, validateUrl: validate });
    const service = new RetrievalService({
      directProvider: new DirectHttpProvider({ publicHttpClient: publisherClient, publicHttpClients: { scholar_search: scholarClient } }),
      configuration: parseRetrievalConfiguration({} as NodeJS.ProcessEnv),
      costPolicy: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validate }),
      maxConcurrency: 1,
      operationTimeoutMs: 100_000,
      now: () => now
    });

    try {
      const publisher = service.retrieve({ url: 'https://publisher.example/article', purpose: 'publisher_discovery', strategy: 'direct', documentFormat: 'html' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);

      now = 10_000;
      const firstScholar = service.retrieve({ url: 'https://scholar.google.com/scholar?q=one', purpose: 'scholar_search', strategy: 'direct', documentFormat: 'html' });
      const secondScholar = service.retrieve({ url: 'https://scholar.google.com/scholar?q=two', purpose: 'scholar_search', strategy: 'direct', documentFormat: 'html' });
      await Promise.resolve();
      releasePublisher();
      await expect(publisher).resolves.toBeDefined();
      await Promise.resolve();
      await Promise.resolve();
      expect(scholarDispatchTimes).toEqual([10_000]);

      now = 12_999;
      await jest.advanceTimersByTimeAsync(2_999);
      expect(scholarDispatchTimes).toEqual([10_000]);
      now = 13_000;
      await jest.advanceTimersByTimeAsync(1);
      await expect(firstScholar).resolves.toBeDefined();
      await expect(secondScholar).resolves.toBeDefined();
      expect(scholarDispatchTimes).toEqual([10_000, 13_000]);
    } finally {
      scheduler.reset();
      jest.useRealTimers();
    }
  });

  it('cancels a transport queued behind the global slot without dispatch accounting', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    let releasePublisher!: () => void;
    const publisherGate = new Promise<void>(resolve => { releasePublisher = resolve; });
    const request = jest.fn(async (config: any) => {
      if (String(config.url).startsWith('https://publisher.example')) await publisherGate;
      return { status: 200, headers: {}, data: '<html />' };
    });
    const validate = async (url: string) => ({
      url,
      hostname: new URL(url).hostname,
      addresses: [{ address: '93.184.216.34', family: 4 as const }]
    });
    const publisherClient = new PublicHttpClient({ purpose: 'publisher_discovery', sourceScheduler: scheduler, client: { request }, validateUrl: validate });
    const scholarClient = new PublicHttpClient({ purpose: 'scholar_search', sourceScheduler: scheduler, client: { request }, validateUrl: validate });
    const service = new RetrievalService({
      directProvider: new DirectHttpProvider({ publicHttpClient: publisherClient, publicHttpClients: { scholar_search: scholarClient } }),
      configuration: parseRetrievalConfiguration({} as NodeJS.ProcessEnv),
      costPolicy: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: false }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validate }),
      maxConcurrency: 1,
      operationTimeoutMs: 100_000,
      now: () => now
    });

    try {
      const publisher = service.retrieve({ url: 'https://publisher.example/article', purpose: 'publisher_discovery', strategy: 'direct', documentFormat: 'html' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const controller = new AbortController();
      const scholar = service.retrieve({ url: 'https://scholar.google.com/scholar?q=cancel', purpose: 'scholar_search', strategy: 'direct', documentFormat: 'html', signal: controller.signal });
      controller.abort();
      await expect(scholar).rejects.toMatchObject({ code: 'cancelled' });
      expect(request).toHaveBeenCalledTimes(1);
      expect(scheduler.getState('https://scholar.google.com').lastStart).toBeUndefined();
      releasePublisher();
      await expect(publisher).resolves.toBeDefined();
    } finally {
      scheduler.reset();
      jest.useRealTimers();
    }
  });

  it('enforces an expired operation deadline without dispatch', async () => {
    jest.useFakeTimers();
    try {
      const retrieve = jest.fn(async () => response('paid'));
      const service = serviceWith(retrieve, undefined, { operationTimeoutMs: 100 });
      const operation = service.createOperation();
      await jest.advanceTimersByTimeAsync(100);

      await expect(service.retrieve(paidRequest, operation)).rejects.toMatchObject({ code: 'timeout' });
      expect(retrieve).not.toHaveBeenCalled();
      operation.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
