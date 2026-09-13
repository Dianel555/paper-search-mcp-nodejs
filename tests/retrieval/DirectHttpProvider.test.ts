import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import { describe, expect, it, jest } from '@jest/globals';
import { DirectHttpProvider, MAX_RETRIEVAL_RESPONSE_BYTES } from '../../src/retrieval/DirectHttpProvider.js';
import { OutboundSecurityError } from '../../src/retrieval/OutboundSecurityPolicy.js';
import type { RetrievalOperationContext, RetrievalResponse } from '../../src/retrieval/types.js';

function context(signal = new AbortController().signal): RetrievalOperationContext {
  return {
    operationId: 'test-operation',
    signal,
    deadlineAt: Date.now() + 120_000,
    cost: {} as RetrievalOperationContext['cost'],
    remainingMs: () => 120_000
  };
}

function response(data: unknown, status = 200, finalUrl = 'https://publisher.example/final'): {
  response: { status: number; headers: Record<string, string>; data: unknown };
  finalUrl: string;
} {
  return {
    response: { status, headers: { 'content-type': 'text/html; charset=utf-8' }, data },
    finalUrl
  };
}

describe('DirectHttpProvider', () => {
  it('routes Scholar requests through the isolated purpose transport', async () => {
    const generalRequest = jest.fn(async () => response('<html>general</html>'));
    const scholarRequest = jest.fn(async () => response('<html>scholar</html>', 200, 'https://scholar.google.com/scholar'));
    const provider = new DirectHttpProvider({
      publicHttpClient: { request: generalRequest },
      publicHttpClients: { scholar_search: { request: scholarRequest } }
    });

    const scholarResult = await provider.retrieve({
      url: 'https://scholar.google.com/scholar?q=public',
      purpose: 'scholar_search',
      strategy: 'direct',
      documentFormat: 'html'
    }, context());
    const publisherResult = await provider.retrieve({
      url: 'https://publisher.example/page',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context());

    expect(scholarResult.document?.html).toBe('<html>scholar</html>');
    expect(publisherResult.document?.html).toBe('<html>general</html>');
    expect(scholarRequest).toHaveBeenCalledTimes(1);
    expect(generalRequest).toHaveBeenCalledTimes(1);
  });

  it('returns the checked final URL, target status, and bounded document', async () => {
    const request = jest.fn(async (_url: string, _config: unknown) => response('<html>ok</html>', 404));
    const provider = new DirectHttpProvider({ publicHttpClient: { request } });

    const result = await provider.retrieve({
      url: 'https://publisher.example/start',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context());

    expect(result).toEqual(expect.objectContaining({
      provider: 'direct',
      strategy: 'direct',
      targetStatus: 404,
      cost: { known: true, credits: 0 }
    }));
    expect(result.document).toEqual(expect.objectContaining({
      html: '<html>ok</html>',
      source: { provenance: 'trusted_direct', finalUrl: 'https://publisher.example/final' }
    }));
    expect(request).toHaveBeenCalledWith('https://publisher.example/start', expect.objectContaining({
      method: 'GET',
      responseType: 'stream'
    }));
  });

  it('accepts decompressed bodies below and at the limit and rejects one byte over it', async () => {
    const belowLimit = Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES - 1, 97);
    const belowLimitRequest = jest.fn(async () => response(Readable.from([belowLimit])));
    const belowLimitProvider = new DirectHttpProvider({ publicHttpClient: { request: belowLimitRequest } });
    const below = await belowLimitProvider.retrieve({
      url: 'https://publisher.example/below-limit',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context());
    expect(Buffer.byteLength(below.document?.html || '')).toBe(MAX_RETRIEVAL_RESPONSE_BYTES - 1);

    const atLimit = Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES, 97);
    const atLimitRequest = jest.fn(async () => response(Readable.from([atLimit])));
    const atLimitProvider = new DirectHttpProvider({ publicHttpClient: { request: atLimitRequest } });
    const accepted = await atLimitProvider.retrieve({
      url: 'https://publisher.example/at-limit',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context());
    expect(Buffer.byteLength(accepted.document?.html || '')).toBe(MAX_RETRIEVAL_RESPONSE_BYTES);

    const overLimitStream = Readable.from([Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES + 1, 97)]);
    const overLimitRequest = jest.fn(async () => response(overLimitStream));
    const overLimitProvider = new DirectHttpProvider({ publicHttpClient: { request: overLimitRequest } });
    await expect(overLimitProvider.retrieve({
      url: 'https://publisher.example/over-limit',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'response_too_large' });
    expect(overLimitStream.destroyed).toBe(true);
  });

  it('enforces the decompressed limit after gzip expansion', async () => {
    const expanded = Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES + 1, 97);
    const compressed = gzipSync(expanded);
    const stream = Readable.from([compressed]).pipe(createGunzip());
    const request = jest.fn(async () => response(stream));
    const provider = new DirectHttpProvider({ publicHttpClient: { request } });

    await expect(provider.retrieve({
      url: 'https://publisher.example/gzip-over-limit',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'response_too_large' });
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
    const request = jest.fn(async () => response(body));
    const provider = new DirectHttpProvider({ publicHttpClient: { request } });
    const pending = provider.retrieve({
      url: 'https://publisher.example/page',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context(controller.signal));
    await entered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(returnCalled).toBeGreaterThan(0);
  });

  it('preserves target validation failures as security errors', async () => {
    const request = jest.fn(async () => {
      throw new OutboundSecurityError('Private or non-public network targets are not allowed');
    });
    const provider = new DirectHttpProvider({ publicHttpClient: { request } });
    await expect(provider.retrieve({
      url: 'https://private.example/page',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'security' });
  });

  it('does not retry a failed single provider attempt and honors cancellation before dispatch', async () => {
    const request = jest.fn(async () => { throw new Error('network'); });
    const provider = new DirectHttpProvider({ publicHttpClient: { request } });
    await expect(provider.retrieve({
      url: 'https://publisher.example/fail',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context())).rejects.toMatchObject({ code: 'network' });
    expect(request).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(provider.retrieve({
      url: 'https://publisher.example/cancelled',
      purpose: 'publisher_discovery',
      strategy: 'direct',
      documentFormat: 'html'
    }, context(controller.signal))).rejects.toMatchObject({ code: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
