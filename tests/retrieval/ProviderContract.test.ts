import { describe, expect, it } from '@jest/globals';
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
});
