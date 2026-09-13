import { describe, expect, it, jest } from '@jest/globals';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import { RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';
import { RetrievalService } from '../../src/retrieval/RetrievalService.js';
import type { RetrievalOperationContext, RetrievalProvider, RetrievalResponse } from '../../src/retrieval/types.js';

const validateUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 as const }]
});

function makeProvider(retrieve: RetrievalProvider['retrieve']): RetrievalProvider {
  return {
    name: 'paid',
    capabilities: { html: true, iframeDocuments: true, pdfCandidates: true, browser: true, paid: true },
    retrieve
  };
}

function result(cost: RetrievalResponse['cost']): RetrievalResponse {
  return {
    provider: 'paid',
    strategy: 'static',
    apiStatus: 200,
    targetStatus: 200,
    document: {
      kind: 'html',
      html: '<html />',
      iframes: [],
      source: { provenance: 'unknown_remote', submittedUrl: 'https://publisher.example/page' },
      targetStatus: 200
    },
    cost
  };
}

describe('Retrieval diagnostics', () => {
  it('returns bounded process status without credentials or network work', async () => {
    const retrieve = jest.fn(async () => result({ known: true, credits: 1 }));
    const service = new RetrievalService({
      directProvider: makeProvider(retrieve),
      scrapingAntProvider: makeProvider(retrieve),
      costPolicy: new RetrievalCostPolicy({ enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });

    const before = service.getProcessStatus();
    expect(before.requestCount).toBe(0);
    expect(before.observationScope).toBe('process');
    expect(before.budgetDefaults).toEqual({ maxCreditsPerOperation: 50, maxCreditsPerRequest: 10 });
    expect(before).not.toHaveProperty('apiKey');
    expect(before).not.toHaveProperty('cookies');
    expect(retrieve).not.toHaveBeenCalled();

    await service.withOperation(operation => service.retrieve({
      url: 'https://publisher.example/page',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html_with_iframes'
    }, operation));
    const after = service.getProcessStatus();
    expect(after.requestCount).toBe(1);
    expect(after.reportedCredits).toBe(1);
    expect(after.lastRequestCredits).toBe(1);
  });

  it('keeps operation status detached from later accounting and another operation', async () => {
    const retrieve = jest.fn(async () => result({ known: false, credits: null, reason: 'missing_billing_header' }));
    const service = new RetrievalService({
      directProvider: makeProvider(retrieve),
      scrapingAntProvider: makeProvider(retrieve),
      costPolicy: new RetrievalCostPolicy({ enabled: true }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validateUrl })
    });
    const operation = service.createOperation();
    await service.retrieve({
      url: 'https://publisher.example/page',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html_with_iframes'
    }, operation);
    const reservation = service.getOperationReservation(operation, 'retrieval-attempt-1');
    expect(reservation).toBeDefined();

    const first = service.getOperationStatus(operation);
    const firstSerialized = JSON.stringify(first);
    (first.strategyCounts as Record<string, number>).static = 99;
    service.reconcileCost(operation, reservation!, { known: true, credits: 3 });
    const second = service.getOperationStatus(operation);
    service.reconcileCost(operation, reservation!, { known: true, credits: 7 });
    const afterRepeatedReconciliation = service.getOperationStatus(operation);

    expect(firstSerialized).toContain('"unknownCostAttempts":1');
    expect(first.unknownCostAttempts).toBe(1);
    expect(first.admissionUsed).toBe(1);
    expect(second.unknownCostAttempts).toBe(0);
    expect(second.reportedCredits).toBe(3);
    expect(second.strategyCounts.static).toBe(1);
    expect(afterRepeatedReconciliation.reportedCredits).toBe(3);
    expect(afterRepeatedReconciliation.unknownCostAttempts).toBe(0);
    expect(service.getProcessStatus().reportedCredits).toBe(3);
    operation.dispose();
  });
});
