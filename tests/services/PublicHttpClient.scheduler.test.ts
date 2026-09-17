import { describe, expect, it, jest } from '@jest/globals';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { PublicSourceDispatchScheduler } from '../../src/services/PublicSourceDispatchScheduler.js';
import { createConcurrencyLimiter } from '../../src/utils/ConcurrencyLimiter.js';

const validateUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 as const }]
});

describe('PublicHttpClient source scheduling', () => {
  it('paces Scholar target submissions at the actual transport boundary', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: 'ok' }));
    const dispatchTimes: number[] = [];
    const client = new PublicHttpClient({
      purpose: 'scholar_search',
      sourceScheduler: scheduler,
      client: { request },
      validateUrl
    });
    const observer = { onDispatch: () => dispatchTimes.push(now) };
    try {
      await client.request('https://scholar.google.com/scholar?q=one', { dispatchObserver: observer, deadlineAt: 10_000 });
      const pending = client.request('https://scholar.google.com/scholar?q=two', { dispatchObserver: observer, deadlineAt: 10_000 });
      expect(request).toHaveBeenCalledTimes(1);
      now = 2_999;
      await jest.advanceTimersByTimeAsync(2_999);
      expect(request).toHaveBeenCalledTimes(1);
      now = 3_000;
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeDefined();
      expect(request).toHaveBeenCalledTimes(2);
      expect(dispatchTimes).toEqual([0, 3_000]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies spacing to every same-origin redirect hop', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const request: any = jest.fn();
    request.mockResolvedValueOnce({ status: 302, headers: { location: 'https://scholar.google.com/landing' }, data: undefined });
    request.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    const client = new PublicHttpClient({
      purpose: 'scholar_search',
      sourceScheduler: scheduler,
      client: { request },
      validateUrl
    });
    try {
      const pending = client.request('https://scholar.google.com/start', { deadlineAt: 10_000 });
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      now = 3_000;
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toEqual(expect.objectContaining({ finalUrl: 'https://scholar.google.com/landing' }));
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('holds a real shared slot until a bounded stream body is consumed', async () => {
    let releaseBody!: () => void;
    const bodyFinished = new Promise<void>(resolve => { releaseBody = resolve; });
    const body = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('%PDF-1.7', 'utf8');
        await bodyFinished;
      }
    };
    const request = (jest.fn() as any)
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'application/pdf' }, data: body })
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-2.0', 'utf8') });
    const client = new PublicHttpClient({ client: { request }, validateUrl });
    const dispatchSlot = createConcurrencyLimiter(1);
    const first = client.request('https://publisher.example/one.pdf', {
      responseType: 'stream',
      consumeStreamBodyWithinDispatchSlot: true,
      maxBodyBytes: 64,
      dispatchSlot
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = client.request('https://publisher.example/two.pdf', {
      responseType: 'stream',
      consumeStreamBodyWithinDispatchSlot: true,
      maxBodyBytes: 64,
      dispatchSlot
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    releaseBody();
    await expect(first).resolves.toEqual(expect.objectContaining({ finalUrl: 'https://publisher.example/one.pdf' }));
    await expect(second).resolves.toEqual(expect.objectContaining({ finalUrl: 'https://publisher.example/two.pdf' }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rechecks a deadline after the global transport slot is granted', async () => {
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const request = jest.fn(async () => ({ status: 200, headers: {}, data: 'late' }));
    const client = new PublicHttpClient({ sourceScheduler: scheduler, client: { request }, validateUrl });
    let releaseSlot!: () => void;
    const slotGate = new Promise<void>(resolve => { releaseSlot = resolve; });
    const dispatchSlot = async <T>(task: () => Promise<T>): Promise<T> => {
      await slotGate;
      return task();
    };
    const held = dispatchSlot(async () => new Promise<never>(() => undefined));
    const pending = client.request('https://publisher.example/deadline', {
      deadlineAt: 100,
      dispatchSlot
    });
    await Promise.resolve();
    now = 100;
    releaseSlot();
    await expect(pending).rejects.toThrow(/cooldown exceeds/i);
    expect(request).not.toHaveBeenCalled();
    // Keep the intentionally held slot promise out of the test's rejection path.
    void held;
  });

  it('shares target Retry-After cooldown across later Publisher requests', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const request: any = jest.fn();
    request.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '10' }, data: '' });
    request.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    const client = new PublicHttpClient({
      sourceScheduler: scheduler,
      client: { request },
      validateUrl
    });
    try {
      await client.request('https://publisher.example/article', { deadlineAt: 20_000 });
      const pending = client.request('https://publisher.example/article', { deadlineAt: 20_000 });
      expect(request).toHaveBeenCalledTimes(1);
      now = 9_999;
      await jest.advanceTimersByTimeAsync(9_999);
      expect(request).toHaveBeenCalledTimes(1);
      now = 10_000;
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeDefined();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
