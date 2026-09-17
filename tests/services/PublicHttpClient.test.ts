import { describe, expect, it, jest } from '@jest/globals';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { PublicSourceDispatchScheduler, type SourceDispatchLease } from '../../src/services/PublicSourceDispatchScheduler.js';
import { createPinnedLookup, type PublicUrlValidation } from '../../src/utils/PublicNetwork.js';

describe('PublicHttpClient', () => {
  it('observes each submitted redirect hop without forwarding the observer to transport', async () => {
    const request: any = jest.fn();
    request.mockResolvedValueOnce({ status: 302, headers: { location: 'https://other.example/landing' }, data: undefined });
    request.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    const onDispatch = jest.fn();
    const onResponse = jest.fn();
    const client = new PublicHttpClient({
      client: { request },
      validateUrl: async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }]
      })
    });

    await client.request('https://source.example/start', {
      dispatchObserver: { onDispatch, onResponse }
    });

    expect(onDispatch).toHaveBeenCalledTimes(2);
    const dispatches = onDispatch.mock.calls.map(([observation]) => observation as any);
    const responses = onResponse.mock.calls.map(([observation]: any[]) => observation as any);
    expect(dispatches).toEqual([
      expect.objectContaining({ role: 'target', origin: 'https://source.example', dispatchId: expect.any(String) }),
      expect.objectContaining({ role: 'target', origin: 'https://other.example', dispatchId: expect.any(String) })
    ]);
    expect(new Set(dispatches.map(observation => observation.dispatchId)).size).toBe(2);
    expect(responses.map(observation => observation.status)).toEqual([302, 200]);
    expect(responses.map(observation => observation.dispatchId)).toEqual(dispatches.map(observation => observation.dispatchId));
    expect(request.mock.calls.every(([config]: any[]) => !('dispatchObserver' in config))).toBe(true);
  });

  it('reports only safe dispatch failure facts and isolates observer exceptions', async () => {
    const request = jest.fn(async () => {
      const error = new Error('raw transport secret') as Error & { code?: string };
      error.code = 'ETIMEDOUT';
      throw error;
    });
    const onError = jest.fn(() => { throw new Error('observer failure'); });
    const client = new PublicHttpClient({
      client: { request },
      validateUrl: async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }]
      })
    });

    await expect(client.request('https://failure.example/article', {
      dispatchObserver: { onError }
    })).rejects.toThrow('raw transport secret');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      dispatchId: expect.any(String),
      failureKind: 'transport_timeout'
    }));
    expect(JSON.stringify(onError.mock.calls)).not.toContain('raw transport secret');
  });

  it('does not let a response observer exception change a completed response', async () => {
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: 'ok' }));
    const onResponse = jest.fn(() => { throw new Error('observer failure'); });
    const client = new PublicHttpClient({
      client: { request },
      validateUrl: async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }]
      })
    });

    await expect(client.request('https://success.example/article', {
      dispatchObserver: { onResponse }
    })).resolves.toMatchObject({ response: { status: 200, data: 'ok' } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it('correlates concurrent responses by dispatch ID rather than completion order', async () => {
    let resolveOne!: (response: any) => void;
    let resolveTwo!: (response: any) => void;
    let resolveBothStarted!: () => void;
    let started = 0;
    const bothStarted = new Promise<void>(resolve => { resolveBothStarted = resolve; });
    const responseOne = new Promise<any>(resolve => { resolveOne = resolve; });
    const responseTwo = new Promise<any>(resolve => { resolveTwo = resolve; });
    const request = jest.fn(async (config: any) => {
      started++;
      if (started === 2) resolveBothStarted();
      return config.url === 'https://one.example/article' ? responseOne : responseTwo;
    });
    const dispatches: any[] = [];
    const responses: any[] = [];
    const client = new PublicHttpClient({
      client: { request },
      validateUrl: async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }]
      })
    });

    const first = client.request('https://one.example/article', {
      dispatchObserver: { onDispatch: observation => dispatches.push(observation), onResponse: observation => responses.push(observation) }
    });
    const second = client.request('https://two.example/article', {
      dispatchObserver: { onDispatch: observation => dispatches.push(observation), onResponse: observation => responses.push(observation) }
    });
    await bothStarted;
    resolveTwo({ status: 202, headers: {}, data: 'two' });
    resolveOne({ status: 201, headers: {}, data: 'one' });
    await Promise.all([first, second]);

    expect(dispatches).toHaveLength(2);
    expect(responses).toHaveLength(2);
    const originById = new Map(dispatches.map(observation => [observation.dispatchId, observation.origin]));
    expect(responses.map(observation => ({
      origin: originById.get(observation.dispatchId),
      status: observation.status
    }))).toEqual(expect.arrayContaining([
      { origin: 'https://one.example', status: 201 },
      { origin: 'https://two.example', status: 202 }
    ]));
  });

  it('pins validated addresses, disables ambient proxies, and strips credentials across origins', async () => {
    const validateUrl = jest.fn(async (url: string) => ({
      url,
      hostname: new URL(url).hostname,
      addresses: [{ address: '93.184.216.34', family: 4 }]
    }));
    const request: any = jest.fn();
    request.mockResolvedValueOnce({ status: 302, headers: { location: 'https://other.example/landing' }, data: undefined });
    request.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    const client = new PublicHttpClient({
      client: { request },
      validateUrl
    });

    await client.request('https://source.example/start', {
      headers: { Authorization: 'Bearer test-token', Cookie: 'session=test', 'X-Trace': 'keep' }
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0].proxy).toBe(false);
    expect(request.mock.calls[1][0].proxy).toBe(false);
    expect(request.mock.calls[1][0].headers).toEqual({ 'X-Trace': 'keep' });
    expect(validateUrl).toHaveBeenCalledTimes(2);
  });

  it('releases a granted source lease when cancellation occurs before promise creation', async () => {
    const controller = new AbortController();
    class AbortAfterAcquireScheduler extends PublicSourceDispatchScheduler {
      override async acquire(
        origin: string,
        signal?: AbortSignal,
        deadlineAt?: number,
        minimumIntervalMs = 0,
        options: { readonly deferStart?: boolean } = {}
      ): Promise<SourceDispatchLease> {
        const lease = await super.acquire(origin, signal, deadlineAt, minimumIntervalMs, options);
        controller.abort();
        return lease;
      }
    }
    const scheduler = new AbortAfterAcquireScheduler();
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: 'ok' }));
    const client = new PublicHttpClient({
      client: { request },
      sourceScheduler: scheduler,
      validateUrl: async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }]
      })
    });

    await expect(client.request('https://lease.example/start', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();

    await expect(client.request('https://lease.example/next')).resolves.toEqual(expect.objectContaining({
      finalUrl: 'https://lease.example/next'
    }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not observe or count a target rejected before transport dispatch', async () => {
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: 'ok' }));
    const onDispatch = jest.fn();
    const client = new PublicHttpClient({
      client: { request },
      validateUrl: async () => { throw new Error('private target'); }
    });

    await expect(client.request('https://private.example/admin', {
      dispatchObserver: { onDispatch }
    })).rejects.toThrow(/private target/);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not follow a redirect that fails public-target validation', async () => {
    const request = jest.fn(async (_config: any) => ({
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
      data: undefined
    }));
    const validateUrl = jest.fn(async (url: string) => {
      if (url.includes('127.0.0.1')) throw new Error('private target');
      return { url, hostname: new URL(url).hostname, addresses: [{ address: '93.184.216.34', family: 4 }] };
    });
    const client = new PublicHttpClient({ client: { request }, validateUrl });
    await expect(client.request('https://source.example/start')).rejects.toThrow(/private target/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled initial target validation before dispatch', async () => {
    let releaseValidation!: (value: PublicUrlValidation) => void;
    let validationStarted!: () => void;
    const validation = new Promise<PublicUrlValidation>(resolve => { releaseValidation = resolve; });
    const started = new Promise<void>(resolve => { validationStarted = resolve; });
    const validateUrl = jest.fn(async (url: string) => {
      validationStarted();
      return validation;
    });
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: 'ok' }));
    const client = new PublicHttpClient({ client: { request }, validateUrl });
    const controller = new AbortController();

    const pending = client.request('https://source.example/start', { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    releaseValidation({
      url: 'https://source.example/start',
      hostname: 'source.example',
      addresses: [{ address: '93.184.216.34', family: 4 }]
    });
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels a stalled redirect target validation without a second dispatch', async () => {
    let releaseValidation!: (value: PublicUrlValidation) => void;
    let redirectValidationStarted!: () => void;
    const redirectValidation = new Promise<PublicUrlValidation>(resolve => { releaseValidation = resolve; });
    const started = new Promise<void>(resolve => { redirectValidationStarted = resolve; });
    let validationCount = 0;
    const validateUrl = jest.fn(async (url: string) => {
      if (validationCount++ === 1) {
        redirectValidationStarted();
        return redirectValidation;
      }
      return {
        url,
        hostname: new URL(url).hostname,
        addresses: [{ address: '93.184.216.34', family: 4 }]
      };
    });
    const request = jest.fn(async () => ({
      status: 302,
      headers: { location: 'https://target.example/landing' },
      data: undefined
    }));
    const client = new PublicHttpClient({ client: { request }, validateUrl });
    const controller = new AbortController();

    const pending = client.request('https://source.example/start', { signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    releaseValidation({
      url: 'https://target.example/landing',
      hostname: 'target.example',
      addresses: [{ address: '93.184.216.34', family: 4 }]
    });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(validateUrl).toHaveBeenCalledTimes(2);
  });

  it('supports Node lookups that request all addresses', () => {
    const lookup = createPinnedLookup([{ address: '93.184.216.34', family: 4 }]);
    lookup('example.com', { all: true }, (error: Error | null, address?: unknown) => {
      expect(error).toBeNull();
      expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
  });
});
