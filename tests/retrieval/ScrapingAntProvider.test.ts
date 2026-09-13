import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import { describe, expect, it, jest } from '@jest/globals';
import { ScrapingAntProvider } from '../../src/retrieval/ScrapingAntProvider.js';
import { MAX_RETRIEVAL_RESPONSE_BYTES } from '../../src/retrieval/DirectHttpProvider.js';
import type { RetrievalOperationContext } from '../../src/retrieval/types.js';

function context(signal = new AbortController().signal): RetrievalOperationContext {
  return {
    operationId: 'scrapingant-test',
    signal,
    deadlineAt: Date.now() + 120_000,
    cost: {} as RetrievalOperationContext['cost'],
    remainingMs: () => 120_000
  };
}

function requestFor(data: unknown, status = 200, headers: Record<string, string> = {}): any {
  return jest.fn(async (_config: unknown) => ({ status, headers, data }));
}

describe('ScrapingAntProvider', () => {
  it('maps General and Extended contracts while separating API and page status', async () => {
    const generalRequest = requestFor({ html: '<html>general</html>', status_code: 201 }, 200, {
      'Ant-credits-cost': '1',
      'Ant-page-status-code': '201'
    });
    const general = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request: generalRequest } });
    const generalResult = await general.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'scholar_search',
      strategy: 'static',
      documentFormat: 'html'
    }, context());

    expect(generalResult.apiStatus).toBe(200);
    expect(generalResult.targetStatus).toBe(201);
    expect(generalRequest.mock.calls[0][0]).toEqual(expect.objectContaining({
      method: 'GET',
      url: 'https://api.scrapingant.com/v2/general',
      responseType: 'stream'
    }));
    expect(generalRequest.mock.calls[0][0].params).toEqual({
      url: 'https://publisher.example/article',
      'x-api-key': 'secret-key',
      browser: false,
      proxy_type: 'datacenter'
    });

    const extendedRequest = requestFor({
      content: '<html>extended</html>',
      status_code: 204,
      iframes: [{ src: 'https://publisher.example/frame', html: '<html>frame</html>' }]
    }, 200, { 'Ant-credits-cost': '2' });
    const extended = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request: extendedRequest } });
    const extendedResult = await extended.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'browser',
      documentFormat: 'html_with_iframes'
    }, context());

    expect(extendedRequest.mock.calls[0][0].url).toBe('https://api.scrapingant.com/v2/extended');
    expect(extendedRequest.mock.calls[0][0].params.browser).toBe(true);
    expect(extendedResult.targetStatus).toBe(204);
    expect(extendedResult.cost).toEqual({ known: true, credits: 2 });
    expect(extendedResult.document?.html).toBe('<html>extended</html>');
    expect(extendedResult.document?.iframes).toHaveLength(1);
  });

  it('keeps remote provenance unknown and drops cookies, XHR, and final-url hints', async () => {
    const request = requestFor({
      html: '<a href="paper.pdf">relative</a><a href="https://publisher.example/paper.pdf">absolute</a>',
      finalUrl: 'https://attacker.example/final',
      cookies: 'session=secret',
      xhrs: [{ url: 'https://attacker.example/xhr', headers: { Authorization: 'Bearer secret' } }],
      headers: [{ name: 'Set-Cookie', value: 'private=secret' }],
      iframes: [
        { src: '//remote.example/frame', html: '<a href="frame.pdf">relative</a>' },
        { src: 'https://viewer.example/frame?X-Amz-Signature=sentinel', html: '<html />' },
        { src: '/relative.pdf?token=relative-sentinel', html: '<html />' }
      ]
    }, 200, { 'Ant-credits-cost': '3' });
    const provider = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request } });

    const result = await provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html_with_iframes'
    }, context());

    expect(result.document?.source).toEqual({
      provenance: 'unknown_remote',
      submittedUrl: 'https://publisher.example/article'
    });
    expect(result.document?.source).not.toHaveProperty('finalUrl');
    expect(result.document?.iframes[0].source).toEqual({
      provenance: 'unknown_remote',
      submittedUrl: 'https://publisher.example/article'
    });
    const serialized = JSON.stringify(result);
    for (const secret of ['session=secret', 'Authorization', 'Bearer secret', 'attacker.example/final', 'private=secret', 'sentinel', 'relative-sentinel']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('accepts sixteen iframes but rejects the seventeenth before domain parsing', async () => {
    const frames = Array.from({ length: 16 }, (_value, index) => ({ src: `https://publisher.example/${index}`, html: '<html />' }));
    const acceptedRequest = requestFor({ html: '<html />', iframes: frames }, 200, { 'Ant-credits-cost': '4' });
    const accepted = new ScrapingAntProvider({ apiKey: 'key', client: { request: acceptedRequest } });
    await expect(accepted.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html_with_iframes'
    }, context())).resolves.toMatchObject({ cost: { known: true, credits: 4 } });

    const rejectedRequest = requestFor({ html: '<html />', iframes: [...frames, { src: 'https://publisher.example/17', html: '<html />' }] }, 200, { 'Ant-credits-cost': '4' });
    const rejected = new ScrapingAntProvider({ apiKey: 'key', client: { request: rejectedRequest } });
    await expect(rejected.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html_with_iframes'
    }, context())).rejects.toMatchObject({ code: 'document_limit', cost: { known: true, credits: 4 } });
    expect(rejectedRequest).toHaveBeenCalledTimes(1);
  });

  it('accepts an exactly max-sized decompressed JSON response', async () => {
    const prefix = Buffer.from('{"html":"');
    const suffix = Buffer.from('"}');
    const body = Buffer.concat([prefix, Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES - prefix.length - suffix.length, 97), suffix]);
    expect(body.byteLength).toBe(MAX_RETRIEVAL_RESPONSE_BYTES);
    const request = requestFor(Readable.from([body]), 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });

    await expect(provider.retrieve({
      url: 'https://publisher.example/exact-limit',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context())).resolves.toMatchObject({
      cost: { known: true, credits: 1 },
      document: { html: expect.any(String) }
    });
  });

  it('enforces the decompressed response limit on success and error without retrying', async () => {
    const successBody = JSON.stringify({ html: 'x'.repeat(MAX_RETRIEVAL_RESPONSE_BYTES) });
    const successRequest = requestFor(Readable.from([Buffer.from(successBody)]), 200, { 'Ant-credits-cost': '1' });
    const successProvider = new ScrapingAntProvider({ apiKey: 'key', client: { request: successRequest } });
    await expect(successProvider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'response_too_large', cost: { known: true, credits: 1 } });

    const errorBody = 'x'.repeat(MAX_RETRIEVAL_RESPONSE_BYTES + 1);
    const errorRequest = requestFor(Readable.from([Buffer.from(errorBody)]), 500, { 'Ant-credits-cost': '2' });
    const errorProvider = new ScrapingAntProvider({ apiKey: 'key', client: { request: errorRequest } });
    await expect(errorProvider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'response_too_large', cost: { known: true, credits: 2 } });
    expect(errorRequest).toHaveBeenCalledTimes(1);
  });

  it('enforces the decompressed limit after gzip expansion', async () => {
    const expanded = Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES + 1, 97);
    const compressed = gzipSync(expanded);
    const stream = Readable.from([compressed]).pipe(createGunzip());
    const request = requestFor(stream, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });

    await expect(provider.retrieve({
      url: 'https://publisher.example/gzip-over-limit',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'response_too_large', cost: { known: true, credits: 1 } });
    expect(stream.destroyed).toBe(true);
  });

  it('cancels a stalled response body and closes its async iterator', async () => {
    const controller = new AbortController();
    let bodyStarted!: () => void;
    let returnCalled = 0;
    const entered = new Promise<void>(resolve => { bodyStarted = resolve; });
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            bodyStarted();
            return new Promise<any>(() => undefined);
          },
          return: async () => {
            returnCalled++;
            return { done: true, value: undefined };
          }
        };
      }
    };
    const request = requestFor(body, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });
    const pending = provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context(controller.signal));
    await entered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled', cost: { known: true, credits: 1 } });
    expect(returnCalled).toBeGreaterThan(0);
  });

  it('uses a safe error without returning the provider detail', async () => {
    const request = requestFor({ detail: 'token=super-secret' }, 403, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });

    const error = await provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context()).catch((value: unknown) => value as any);
    expect(error).toMatchObject({ code: 'auth_or_credits_unknown', apiStatus: 403, cost: { known: true, credits: 1 } });
    expect(error.message).not.toContain('super-secret');
  });
});
