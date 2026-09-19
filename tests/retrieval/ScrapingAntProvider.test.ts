import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import { TIMEOUTS } from '../../src/config/constants.js';
import { describe, expect, it, jest } from '@jest/globals';
import { ScrapingAntProvider } from '../../src/retrieval/ScrapingAntProvider.js';
import { PublicSourceDispatchScheduler } from '../../src/services/PublicSourceDispatchScheduler.js';
import { MAX_RETRIEVAL_RESPONSE_BYTES } from '../../src/retrieval/DirectHttpProvider.js';
import type { RetrievalOperationContext } from '../../src/retrieval/types.js';
import { abortForRetrievalScope } from '../../src/retrieval/abortDiagnostics.js';

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
  it('sends the normalized browser and residential combination without redirects or hidden retries', async () => {
    const request = requestFor({ html: '<html>ok</html>' }, 200, { 'Ant-credits-cost': '125' });
    const provider = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request } });

    await expect(provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'browser',
      proxyType: 'residential',
      documentFormat: 'html'
    }, context())).resolves.toMatchObject({ cost: { known: true, credits: 125 } });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual(expect.objectContaining({
      proxy: false,
      maxRedirects: 0,
      validateStatus: expect.any(Function)
    }));
    expect(request.mock.calls[0][0].params).toEqual({
      url: 'https://publisher.example/article',
      'x-api-key': 'secret-key',
      browser: true,
      proxy_type: 'residential'
    });
  });

  it('observes the single provider API submission without exposing raw response headers', async () => {
    const request = requestFor({ html: '<html>ok</html>' }, 200, { 'Ant-credits-cost': '1', 'Set-Cookie': 'secret' });
    const onDispatch = jest.fn();
    const onResponse = jest.fn();
    const provider = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request } });

    await provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html',
      dispatchObserver: { onDispatch, onResponse }
    }, context());

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'provider_api',
      origin: 'https://api.scrapingant.com',
      dispatchId: expect.any(String),
      submittedAt: expect.any(Number)
    }));
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ role: 'provider_api', status: 200 }));
    const dispatchedId = (onDispatch.mock.calls[0][0] as { dispatchId: string }).dispatchId;
    const respondedId = (onResponse.mock.calls[0][0] as { dispatchId: string }).dispatchId;
    expect(respondedId).toBe(dispatchedId);
    expect(JSON.stringify(onResponse.mock.calls)).not.toContain('Set-Cookie');
  });

  it('does not turn a successful paid response into a retryable error when diagnostics throw', async () => {
    const body = Readable.from([Buffer.from(JSON.stringify({ html: '<html>ok</html>' }))]);
    const request = requestFor(body, 200, { 'Ant-credits-cost': '2' });
    const onResponse = jest.fn(() => { throw new Error('observer failure'); });
    const provider = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request } });

    await expect(provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html',
      dispatchObserver: { onResponse }
    }, context())).resolves.toMatchObject({
      apiStatus: 200,
      cost: { known: true, credits: 2 }
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(body.destroyed).toBe(true);
  });

  it('maps the bounded Markdown contract without exposing provider fields', async () => {
    const request = requestFor({
      markdown: '# Public paper',
      status_code: 200,
      url: 'https://attacker.example/observed',
      cookies: 'session=secret',
      headers: [{ name: 'Set-Cookie', value: 'secret' }],
      xhrs: [{ url: 'https://attacker.example/xhr' }]
    }, 200, { 'Ant-credits-cost': '3', 'Ant-page-status-code': '200' });
    const provider = new ScrapingAntProvider({ apiKey: 'secret-key', client: { request } });

    const result = await provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'markdown'
    }, context());

    expect(result).toMatchObject({
      apiStatus: 200,
      targetStatus: 200,
      cost: { known: true, credits: 3 },
      document: { kind: 'markdown', markdown: '# Public paper' }
    });
    expect(request.mock.calls[0][0].url).toBe('https://api.scrapingant.com/v2/markdown');
    expect(JSON.stringify(result)).not.toContain('attacker.example');
    expect(JSON.stringify(result)).not.toContain('session=secret');
  });

  it('rejects empty or malformed Markdown payloads without treating HTML as Markdown', async () => {
    for (const data of [
      { html: '<html>not markdown</html>', status_code: 200 },
      { markdown: '', status_code: 200 },
      { markdown: '# missing target status' }
    ]) {
      const request = requestFor(data, 200, { 'Ant-credits-cost': '1' });
      const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });
      await expect(provider.retrieve({
        url: 'https://publisher.example/article',
        purpose: 'publisher_discovery',
        strategy: 'static',
        documentFormat: 'markdown'
      }, context())).rejects.toMatchObject({ code: expect.any(String) });
    }
  });

  it('keeps Markdown static and datacenter only', async () => {
    const request = requestFor({ markdown: '# text', status_code: 200 }, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });
    await expect(provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'browser',
      proxyType: 'datacenter',
      documentFormat: 'markdown'
    }, context())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(request).not.toHaveBeenCalled();
  });

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

  it('distinguishes scope cancellation, provider transport timeout, and operation deadline', async () => {
    const scopeController = new AbortController();
    abortForRetrievalScope(scopeController);
    const scopeProvider = new ScrapingAntProvider({ apiKey: 'key', client: { request: requestFor({ html: '<html />' }) } });
    await expect(scopeProvider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context(scopeController.signal))).rejects.toMatchObject({
      code: 'cancelled',
      failureKind: 'scope_deadline'
    });

    const timeoutRequest = jest.fn(async () => {
      const error = new Error('transport detail must stay private') as Error & { code?: string };
      error.code = 'ETIMEDOUT';
      throw error;
    });
    const timeoutProvider = new ScrapingAntProvider({ apiKey: 'key', client: { request: timeoutRequest } });

    await expect(timeoutProvider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({
      code: 'timeout',
      failureKind: 'transport_timeout',
      cost: { known: false, credits: null, reason: 'missing_billing_header' }
    });

    const deadlineRequest = requestFor({ html: '<html />' });
    const deadlineProvider = new ScrapingAntProvider({ apiKey: 'key', client: { request: deadlineRequest } });
    await expect(deadlineProvider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, { ...context(), remainingMs: () => 0 })).rejects.toMatchObject({
      code: 'timeout',
      failureKind: 'operation_deadline'
    });
    expect(deadlineRequest).not.toHaveBeenCalled();

    const streamFailure = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw new Error('stream detail must stay private'); },
          return: async () => ({ done: true, value: undefined })
        };
      }
    };
    const bodyFailureRequest = requestFor(streamFailure, 200, { 'Ant-credits-cost': '4' });
    const bodyFailureProvider = new ScrapingAntProvider({ apiKey: 'key', client: { request: bodyFailureRequest } });
    await expect(bodyFailureProvider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({
      code: 'network',
      failureKind: 'response_body',
      cost: { known: true, credits: 4 }
    });
  });

  it.each([
    ['publisher_discovery', 'https://publisher.example/article'],
    ['scholar_search', 'https://scholar.example/query']
  ] as Array<['publisher_discovery' | 'scholar_search', string]>)('does not submit a paid request when the %s operation cannot cover the bounded provider timeout', async (purpose, url) => {
    const request = requestFor({ html: '<html />' }, 200, { 'Ant-credits-cost': '1' });
    const onDispatch = jest.fn();
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });
    const remainingMs = TIMEOUTS.EXTENDED - 1;

    await expect(provider.retrieve({
      url,
      purpose,
      strategy: 'browser',
      proxyType: 'residential',
      documentFormat: 'html',
      dispatchObserver: { onDispatch }
    }, {
      ...context(),
      deadlineAt: Date.now() + remainingMs,
      remainingMs: () => remainingMs
    })).rejects.toMatchObject({
      code: 'timeout',
      failureKind: 'operation_deadline'
    });
    expect(request).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('rechecks the bounded provider timeout after source queueing', async () => {
    let now = 0;
    let remaining = 120_000;
    const scheduler = new PublicSourceDispatchScheduler({
      now: () => now,
      sleep: async milliseconds => {
        now += milliseconds;
        remaining -= milliseconds;
      }
    });
    scheduler.observeRetryAfter('https://publisher.example', 429, { 'retry-after': '61' });
    const request = requestFor({ html: '<html />' }, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request }, sourceScheduler: scheduler });

    await expect(provider.retrieve({
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery',
      strategy: 'static',
      documentFormat: 'html'
    }, {
      ...context(),
      deadlineAt: 120_000,
      remainingMs: () => remaining
    })).rejects.toMatchObject({
      code: 'timeout',
      failureKind: 'operation_deadline'
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not apply the full provider-timeout admission guard to Sci-Hub lookup', async () => {
    const request = requestFor({ html: '<html />' }, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({
      apiKey: 'key',
      client: { request },
      sourceScheduler: new PublicSourceDispatchScheduler()
    });
    const remainingMs = TIMEOUTS.EXTENDED - 1;

    await expect(provider.retrieve({
      url: 'https://scihub.example/article',
      purpose: 'scihub_lookup',
      strategy: 'static',
      documentFormat: 'html'
    }, {
      ...context(),
      deadlineAt: Date.now() + remainingMs,
      remainingMs: () => remainingMs
    })).resolves.toMatchObject({ apiStatus: 200 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('allows a non-Publisher paid dispatch after queueing consumes the timeout tail', async () => {
    let now = 0;
    let remaining = 120_000;
    const scheduler = new PublicSourceDispatchScheduler({
      now: () => now,
      sleep: async milliseconds => {
        now += milliseconds;
        remaining -= milliseconds;
      }
    });
    scheduler.observeRetryAfter('https://scihub.example', 429, { 'retry-after': '61' });
    const request = requestFor({ html: '<html />' }, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request }, sourceScheduler: scheduler });

    await expect(provider.retrieve({
      url: 'https://scihub.example/article',
      purpose: 'scihub_lookup',
      strategy: 'static',
      documentFormat: 'html'
    }, {
      ...context(),
      deadlineAt: 120_000,
      remainingMs: () => remaining
    })).resolves.toMatchObject({ apiStatus: 200 });
    expect(request).toHaveBeenCalledTimes(1);
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

  it('propagates a paid target 429 into the shared source cooldown', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const request = requestFor({ status_code: 429, html: '<html>rate limited</html>' }, 200, { 'Ant-credits-cost': '1' });
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request }, sourceScheduler: scheduler });
    const requestInput = {
      url: 'https://publisher.example/article',
      purpose: 'publisher_discovery' as const,
      strategy: 'static' as const,
      documentFormat: 'html' as const
    };
    try {
      await provider.retrieve(requestInput, { ...context(), deadlineAt: 120_000, remainingMs: () => 120_000 });
      expect(scheduler.getState('https://publisher.example')).toEqual(expect.objectContaining({ cooldownUntil: 3_000 }));
      const second = provider.retrieve(requestInput, { ...context(), deadlineAt: 120_000, remainingMs: () => 120_000 });
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(1);
      now = 3_000;
      await jest.advanceTimersByTimeAsync(3_000);
      await second;
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps API 405 and 429 errors separate from target status', async () => {
    for (const apiStatus of [405, 429]) {
      const request = requestFor({ status_code: 200, html: '<html>target</html>' }, apiStatus, { 'Ant-credits-cost': '1' });
      const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });
      const error = await provider.retrieve({
        url: 'https://publisher.example/article',
        purpose: 'publisher_discovery',
        strategy: 'static',
        documentFormat: 'html'
      }, context()).catch((value: unknown) => value as any);

      expect(error.apiStatus).toBe(apiStatus);
      expect(error.targetStatus).toBeUndefined();
      expect(error.code).toBe(apiStatus === 405 ? 'invalid_request' : 'provider_error');
      expect(request).toHaveBeenCalledTimes(1);
    }
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

  it('keeps a Scholar API 423 without a billing header unknown and retryable', async () => {
    const request = requestFor({ detail: 'anti-bot' }, 423);
    const provider = new ScrapingAntProvider({ apiKey: 'key', client: { request } });
    const error = await provider.retrieve({
      url: 'https://scholar.google.com/scholar',
      purpose: 'scholar_search',
      strategy: 'static',
      documentFormat: 'html'
    }, context()).catch((value: unknown) => value as any);

    expect(error).toMatchObject({
      code: 'detected',
      apiStatus: 423,
      retryable: true,
      cost: { known: false, credits: null, reason: 'missing_billing_header' }
    });
  });
});
