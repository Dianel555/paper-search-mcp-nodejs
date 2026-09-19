import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ScrapingAntFetcher } from '../../src/services/ScrapingAntFetcher.js';
import { MAX_RETRIEVAL_RESPONSE_BYTES } from '../../src/retrieval/DirectHttpProvider.js';
import { sanitizeRequest } from '../../src/utils/SecurityUtils.js';

const validateUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 }]
});

describe('ScrapingAntFetcher', () => {
  beforeEach(() => {
    process.env.SCRAPINGANT_ENABLED = 'true';
  });

  it('requires explicit paid enablement even when a key is present', async () => {
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: { html: '<html />' } }));
    const fetcher = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request }, validateUrl });
    delete process.env.SCRAPINGANT_ENABLED;

    await expect(fetcher.fetch('https://example.com')).rejects.toThrow(/not explicitly enabled/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('enforces the decompressed compatibility response bound at the exact edge', async () => {
    const exact = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: jest.fn(async () => ({
        status: 200,
        headers: { 'Ant-credits-cost': '1' },
        data: Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES, 120)
      })) },
      validateUrl
    });
    await expect(exact.fetch('https://example.com/exact')).resolves.toMatchObject({ html: 'x'.repeat(MAX_RETRIEVAL_RESPONSE_BYTES) });

    const overRequest = jest.fn(async () => ({
      status: 200,
      headers: { 'Ant-credits-cost': '2' },
      data: Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES + 1, 120)
    }));
    const over = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request: overRequest }, validateUrl });
    await expect(over.fetch('https://example.com/over')).rejects.toMatchObject({ code: 'response_too_large', creditsCost: 2 });
    expect(over.getStatus()).toEqual(expect.objectContaining({ creditsUsed: 2, requestCount: 1 }));
  });

  it('supports the explicit static Markdown endpoint without exposing extended fields', async () => {
    const request = jest.fn(async (_config: any) => ({
      status: 200,
      headers: { 'Ant-credits-cost': '2', 'Ant-page-status-code': '200' },
      data: {
        markdown: '# Markdown',
        status_code: 200,
        cookies: 'session=secret',
        headers: [{ name: 'Set-Cookie', value: 'secret' }],
        xhrs: [{ url: 'https://attacker.example/xhr' }]
      }
    }));
    const fetcher = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request }, validateUrl });
    const result = await fetcher.fetch('https://example.com/page', { endpoint: 'markdown' });

    expect(result).toMatchObject({ markdown: '# Markdown', apiStatus: 200, pageStatus: 200, creditsCost: 2 });
    expect(result.html).toBe('');
    expect(result.headers).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('session=secret');
    expect((request.mock.calls[0][0] as any).url).toBe('https://api.scrapingant.com/v2/markdown');
  });

  it('separates API/page status, supports html/content and accumulates actual credits', async () => {
    const request = jest.fn(async (_config: any) => ({
      status: 200,
      headers: { 'Ant-credits-cost': '3', 'Ant-page-status-code': '201' },
      data: {
        content: '<html>content</html>',
        text: 'content',
        iframes: [{ src: 'https://example.com/frame', html: '<iframe></iframe>' }],
        headers: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Set-Cookie', value: 'secret' }],
        cookies: 'session=secret',
        xhrs: [{ headers: { Authorization: 'Bearer secret' } }]
      }
    }));
    const fetcher = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request },
      validateUrl,
      sleep: async () => undefined
    });

    const result = await fetcher.fetch('https://example.com/page', { endpoint: 'extended', browser: false });
    expect(result).toEqual(expect.objectContaining({
      html: '<html>content</html>',
      apiStatus: 200,
      pageStatus: 201,
      creditsCost: 3
    }));
    expect(result.iframes).toHaveLength(1);
    expect(result.headers).toEqual([{ name: 'Content-Type', value: 'text/html' }]);
    expect(result).not.toHaveProperty('cookies');
    expect(result).not.toHaveProperty('xhrs');
    expect(fetcher.getStatus()).toEqual(expect.objectContaining({ creditsUsed: 3, requestCount: 1 }));
    expect((request.mock.calls[0][0] as any).params).toEqual(expect.objectContaining({
      url: 'https://example.com/page',
      'x-api-key': 'test-api-key',
      proxy_type: 'datacenter'
    }));
  });

  it('accepts plain string HTML and records credits reported on an unsuccessful response', async () => {
    const plainRequest = jest.fn(async (_config: any) => ({
      status: 200,
      headers: { 'Ant-credits-cost': '1', 'Ant-page-status-code': '200' },
      data: '<html>plain html</html>'
    }));
    const plain = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request: plainRequest }, validateUrl, sleep: async () => undefined });
    await expect(plain.fetch('https://example.com')).resolves.toEqual(expect.objectContaining({ html: '<html>plain html</html>', creditsCost: 1 }));

    const failedRequest = jest.fn(async (_config: any) => ({ status: 500, headers: { 'Ant-credits-cost': '2' }, data: {} }));
    const failed = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request: failedRequest }, validateUrl, sleep: async () => undefined, random: () => 0 });
    await expect(failed.fetch('https://example.com')).rejects.toThrow(/status 500/);
    expect(failed.getStatus().creditsUsed).toBe(2);
    expect(failed.getStatus().requestCount).toBe(1);
  });

  it('rejects residential requests in the legacy compatibility adapter before transport', async () => {
    const request = jest.fn(async (_config: any) => ({ status: 200, headers: {}, data: {} }));
    const fetcher = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request }, validateUrl });

    await expect(fetcher.fetch('https://example.com/residential', { proxyType: 'residential' }))
      .rejects.toThrow(/Residential proxy retrieval is not supported/);
    expect(request).not.toHaveBeenCalled();
  });

  it('allows the retrieval adapter to request exactly one transport attempt', async () => {
    const request = jest.fn(async (_config: any) => ({ status: 503, headers: {}, data: {} }));
    const fetcher = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request },
      validateUrl,
      sleep: async () => undefined
    });

    await expect(fetcher.fetch('https://example.com/retry', { singleAttempt: true })).rejects.toThrow(/status 503/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry caller or transient provider errors in the compatibility transport', async () => {
    const forbiddenRequest = jest.fn(async (_config: any) => ({ status: 403, headers: {}, data: {} }));
    const forbidden = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: forbiddenRequest },
      validateUrl
    });
    await expect(forbidden.fetch('https://example.com')).rejects.toThrow(/status 403/);
    expect(forbiddenRequest).toHaveBeenCalledTimes(1);

    const retryRequest = jest.fn(async (_config: any) => ({ status: 409, headers: {}, data: {} }));
    const retrying = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request: retryRequest },
      validateUrl
    });
    await expect(retrying.fetch('https://example.com')).rejects.toThrow(/status 409/);
    expect(retryRequest).toHaveBeenCalledTimes(1);
  });

  it('frees the queue when validation never settles after cancellation', async () => {
    let validationStarted!: () => void;
    const enteredValidation = new Promise<void>(resolve => {
      validationStarted = resolve;
    });
    let validationCalls = 0;
    const delayedValidate = jest.fn(async (url: string) => {
      if (validationCalls++ === 0) {
        validationStarted();
        return new Promise<any>(() => undefined);
      }
      return validateUrl(url);
    });
    const request = jest.fn(async (_config: any) => ({ status: 200, headers: {}, data: { html: '<html />' } }));
    const fetcher = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request },
      maxConcurrency: 1,
      validateUrl: delayedValidate,
      sleep: async () => undefined
    });
    const controller = new AbortController();
    const first = fetcher.fetch('https://example.com/first', { signal: controller.signal });
    await enteredValidation;

    const firstExpectation = expect(first).rejects.toThrow(/aborted/i);
    controller.abort();
    await firstExpectation;

    await expect(fetcher.fetch('https://example.com/second')).resolves.toEqual(expect.objectContaining({ html: '<html />' }));
    expect(delayedValidate).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0].params.url).toBe('https://example.com/second');
  });

  it('accounts for a late response and disposes it after transport cancellation', async () => {
    let resolveRequest!: (response: any) => void;
    const request = jest.fn(() => new Promise<any>(resolve => { resolveRequest = resolve; }));
    const body = { destroy: jest.fn() };
    const fetcher = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request },
      validateUrl
    });
    const controller = new AbortController();
    const pending = fetcher.fetch('https://example.com/late', { signal: controller.signal });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(request).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    resolveRequest({ status: 200, headers: { 'Ant-credits-cost': '4' }, data: body });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher.getStatus()).toEqual(expect.objectContaining({ creditsUsed: 4, requestCount: 1 }));
    expect(body.destroy).toHaveBeenCalled();
  });

  it('cancels a stalled streaming body and closes its async iterator', async () => {
    let bodyStarted!: () => void;
    let returnCalled = 0;
    const enteredBody = new Promise<void>(resolve => { bodyStarted = resolve; });
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
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: body }));
    const fetcher = new ScrapingAntFetcher({ apiKey: 'test-api-key', client: { request }, validateUrl });
    const controller = new AbortController();
    const pending = fetcher.fetch('https://example.com/stalled', { signal: controller.signal });
    await enteredBody;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(returnCalled).toBeGreaterThan(0);
  });

  it('makes one compatibility transport attempt for a server error', async () => {
    const request = jest.fn(async (_config: any) => ({ status: 503, headers: {}, data: {} }));
    const fetcher = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request },
      validateUrl
    });

    await expect(fetcher.fetch('https://example.com/retry')).rejects.toThrow(/status 503/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('removes canceled requests from the concurrency queue', async () => {
    let releaseFirst!: (value: any) => void;
    let requestStarted!: () => void;
    const firstResponse = new Promise<any>(resolve => {
      releaseFirst = resolve;
    });
    const enteredRequest = new Promise<void>(resolve => {
      requestStarted = resolve;
    });
    const validate = jest.fn(validateUrl);
    const request = jest.fn(async (_config: any) => {
      requestStarted();
      return firstResponse;
    });
    const fetcher = new ScrapingAntFetcher({
      apiKey: 'test-api-key',
      client: { request },
      maxConcurrency: 1,
      validateUrl: validate,
      sleep: async () => undefined
    });
    const first = fetcher.fetch('https://example.com/first');
    await enteredRequest;
    expect(request).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const second = fetcher.fetch('https://example.com/second', { signal: controller.signal });
    const secondExpectation = expect(second).rejects.toThrow(/aborted/i);
    controller.abort();
    releaseFirst({ status: 200, headers: {}, data: { html: '<html />' } });

    await first;
    await secondExpectation;
    expect(validate).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('redacts x-api-key in params before logging', () => {
    const sanitized = sanitizeRequest({
      url: 'https://api.scrapingant.com/v2/extended?x-api-key=test-api-key',
      params: { 'x-api-key': 'test-api-key' }
    });
    expect(sanitized.url).not.toContain('test-api-key');
    expect(sanitized.params['x-api-key']).toContain('***');
  });
});
