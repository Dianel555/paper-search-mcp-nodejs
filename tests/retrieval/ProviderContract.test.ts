import { describe, expect, it, jest } from '@jest/globals';
import { RetrievalService } from '../../src/retrieval/RetrievalService.js';
import { DirectHttpProvider } from '../../src/retrieval/DirectHttpProvider.js';
import { RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import type {
  AccessArtifact,
  FiniteDocument,
  RetrievalOperationContext,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResponse
} from '../../src/retrieval/types.js';

const request: RetrievalRequest = {
  url: 'https://publisher.example/article',
  purpose: 'publisher_discovery',
  strategy: 'direct',
  documentFormat: 'html'
};

const context = {} as RetrievalOperationContext;
const validateUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 as const }]
});

function makeFakeProvider(name: string, response: RetrievalResponse): RetrievalProvider {
  return {
    name,
    capabilities: {
      html: true,
      iframeDocuments: false,
      pdfCandidates: true,
      browser: false,
      paid: false
    },
    retrieve: async (receivedRequest, receivedContext) => {
      expect(receivedRequest).toEqual(request);
      expect(receivedContext).toBe(context);
      return response;
    }
  };
}

describe('provider-neutral retrieval contract', () => {
  it('accepts independent fake providers without provider-specific request fields', async () => {
    const document: FiniteDocument = {
      kind: 'html',
      html: '<a href="https://publisher.example/paper.pdf">PDF</a>',
      iframes: [],
      source: {
        provenance: 'trusted_direct',
        finalUrl: request.url
      },
      targetStatus: 200
    };
    const response: RetrievalResponse = {
      provider: 'fake-direct',
      strategy: 'direct',
      document,
      apiStatus: 200,
      targetStatus: 200,
      cost: { known: false, credits: null }
    };

    const direct = makeFakeProvider('fake-direct', response);
    const alternate = makeFakeProvider('fake-alternate', response);

    await expect(direct.retrieve(request, context)).resolves.toBe(response);
    await expect(alternate.retrieve(request, context)).resolves.toBe(response);
    expect(direct.capabilities.paid).toBe(false);
    expect(Object.keys(request)).not.toEqual(expect.arrayContaining(['headers', 'cookies', 'provider', 'apiKey']));
  });

  it('does not treat an unknown remote document as a trusted relative-link base', () => {
    const remoteDocument: FiniteDocument = {
      kind: 'html',
      html: '<a href="paper.pdf">PDF</a>',
      iframes: [],
      source: {
        provenance: 'unknown_remote',
        submittedUrl: 'https://publisher.example/article'
      }
    };
    const artifact: AccessArtifact = {
      url: 'https://publisher.example/paper.pdf',
      method: 'pdf_anchor',
      source: remoteDocument.source
    };

    expect(artifact.source.provenance).toBe('unknown_remote');
    expect('finalUrl' in artifact.source).toBe(false);
    expect('baseUrl' in artifact.source).toBe(false);
  });

  it('rejects an unsupported residential combination before a legacy provider is called', async () => {
    const retrieve = jest.fn(async () => ({
      provider: 'legacy',
      strategy: 'static',
      cost: { known: true, credits: 1 }
    } as RetrievalResponse));
    const legacyProvider: RetrievalProvider = {
      name: 'legacy',
      capabilities: {
        html: true,
        iframeDocuments: false,
        pdfCandidates: true,
        browser: false,
        paid: true
      },
      retrieve
    };
    const service = new RetrievalService({
      directProvider: legacyProvider,
      scrapingAntProvider: legacyProvider
    });
    const operation = service.createOperation();

    try {
      await expect(service.retrieve({
        ...request,
        strategy: 'static',
        proxyType: 'residential'
      }, operation)).rejects.toMatchObject({ code: 'configuration' });
      expect(retrieve).not.toHaveBeenCalled();
    } finally {
      operation.dispose();
    }
  });

  it('isolates response diagnostics for an externally supplied operation context', async () => {
    const observed = jest.fn();
    const responseObserver = jest.fn(() => { throw new Error('observer failure'); });
    const publicRequest = jest.fn(async (_url: string, config: any) => {
      const observation = {
        dispatchId: 'provider-contract-response',
        role: 'target',
        origin: 'https://publisher.example',
        submittedAt: Date.now(),
        status: 200
      };
      config.dispatchObserver?.onDispatch?.(observation);
      config.dispatchObserver?.onResponse?.(observation);
      return {
        response: { status: 200, headers: {}, data: '<html>ok</html>' },
        finalUrl: 'https://publisher.example/article',
        release: jest.fn()
      };
    });
    const service = new RetrievalService({
      directProvider: new DirectHttpProvider({ publicHttpClient: { request: publicRequest } }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const controller = new AbortController();
    const external: RetrievalOperationContext = {
      operationId: 'external-direct-context',
      signal: controller.signal,
      deadlineAt: Date.now() + 120_000,
      remainingMs: () => 120_000,
      cost: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: false }).createLedger(),
      dispatchObserver: { onDispatch: observed, onResponse: responseObserver }
    };

    const response = await service.retrieve({ ...request }, external);
    expect(response.targetStatus).toBe(200);
    expect(publicRequest).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(responseObserver).toHaveBeenCalledTimes(1);
    expect(publicRequest.mock.calls[0][1]).toEqual(expect.objectContaining({ dispatchSlot: expect.any(Function) }));
  });

  it('does not synthesize a second observation for an observable legacy provider', async () => {
    const observed: unknown[] = [];
    const provider: RetrievalProvider = {
      name: 'observable-legacy',
      capabilities: {
        html: true,
        iframeDocuments: false,
        pdfCandidates: false,
        browser: false,
        paid: false,
        dispatchObservation: true,
        transportSlotManagement: false
      },
      retrieve: async receivedRequest => {
        receivedRequest.dispatchObserver?.onDispatch?.({
          dispatchId: 'observable-legacy-dispatch',
          role: 'provider_api',
          origin: 'https://publisher.example',
          submittedAt: Date.now()
        });
        return {
          provider: 'observable-legacy',
          strategy: 'direct',
          targetStatus: 200,
          cost: { known: true, credits: 0 }
        };
      }
    };
    const service = new RetrievalService({
      directProvider: provider,
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const controller = new AbortController();
    const external: RetrievalOperationContext = {
      operationId: 'observable-legacy-context',
      signal: controller.signal,
      deadlineAt: Date.now() + 120_000,
      remainingMs: () => 120_000,
      cost: new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: false }).createLedger(),
      dispatchObserver: { onDispatch: observation => observed.push(observation) }
    };

    await service.retrieve(request, external);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(expect.objectContaining({ role: 'provider_api' }));
  });

  it('rejects an unknown normalized combination before target validation or dispatch', async () => {
    const retrieve = jest.fn(async () => ({
      provider: 'legacy',
      strategy: 'static',
      cost: { known: true, credits: 1 }
    } as RetrievalResponse));
    const provider: RetrievalProvider = {
      name: 'legacy',
      capabilities: {
        html: true,
        iframeDocuments: false,
        pdfCandidates: true,
        browser: false,
        paid: true
      },
      retrieve
    };
    const service = new RetrievalService({ directProvider: provider, scrapingAntProvider: provider });
    const operation = service.createOperation();

    try {
      await expect(service.retrieve({
        ...request,
        strategy: 'static',
        proxyType: 'unknown' as never
      }, operation)).rejects.toMatchObject({ code: 'configuration' });
      expect(retrieve).not.toHaveBeenCalled();
    } finally {
      operation.dispose();
    }
  });
});
