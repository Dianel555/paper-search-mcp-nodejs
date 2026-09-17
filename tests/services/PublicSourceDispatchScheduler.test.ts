import { describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULT_SOURCE_COOLDOWN_MS,
  PublicSourceDispatchScheduler,
  SourceDispatchBlockedError,
  SourceDispatchDeadlineError,
  SourceCooldownError
} from '../../src/services/PublicSourceDispatchScheduler.js';

describe('PublicSourceDispatchScheduler', () => {
  it('spaces concurrent Scholar starts without charging a cancelled waiter', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    try {
      await scheduler.wait('https://scholar.google.com', undefined, 10_000, 3_000);
      const controller = new AbortController();
      const cancelled = scheduler.wait('https://scholar.google.com', controller.signal, 10_000, 3_000);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

      const next = scheduler.wait('https://scholar.google.com', undefined, 10_000, 3_000);
      now = 2_999;
      await jest.advanceTimersByTimeAsync(2_999);
      expect(scheduler.getState('https://scholar.google.com').lastStart).toBe(0);
      now = 3_000;
      await jest.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toBeUndefined();
      expect(scheduler.getState('https://scholar.google.com').lastStart).toBe(3_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a deferred lease when cooldown or blocking changes before start', async () => {
    const scheduler = new PublicSourceDispatchScheduler({ now: () => 0 });
    const cooldownLease = await scheduler.acquire('https://publisher.example', undefined, 20_000, 0, { deferStart: true });
    scheduler.observeRetryAfter('https://publisher.example', 429, { 'retry-after': '10' });
    expect(() => cooldownLease.markStarted(20_000)).toThrow(SourceCooldownError);
    cooldownLease();

    const blockedLease = await scheduler.acquire('https://blocked.example', undefined, 20_000, 0, { deferStart: true });
    scheduler.observeRetryAfter('https://blocked.example', 429, { 'retry-after': '999999999999999999999999' });
    expect(() => blockedLease.markStarted(20_000)).toThrow(SourceDispatchBlockedError);
    blockedLease();
  });

  it('does not charge a deferred lease that is cancelled before actual transport', async () => {
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const lease = await scheduler.acquire('https://scholar.google.com', undefined, 10_000, 3_000, { deferStart: true });
    lease();
    expect(scheduler.getState('https://scholar.google.com').lastStart).toBeUndefined();

    const next = await scheduler.acquire('https://scholar.google.com', undefined, 10_000, 3_000, { deferStart: true });
    now = 7_000;
    next.markStarted();
    expect(scheduler.getState('https://scholar.google.com').lastStart).toBe(7_000);
    next();
  });

  it('does not overlap same-origin transports even after the pacing interval', async () => {
    jest.useFakeTimers();
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    try {
      const releaseFirst = await scheduler.acquire('https://scholar.google.com', undefined, 20_000, 3_000);
      let secondSettled = false;
      const second = scheduler.acquire('https://scholar.google.com', undefined, 20_000, 3_000)
        .then(release => {
          secondSettled = true;
          return release;
        });
      now = 3_000;
      await jest.advanceTimersByTimeAsync(3_000);
      expect(secondSettled).toBe(false);

      const otherOrigin = await scheduler.acquire('https://publisher.example', undefined, 20_000);
      otherOrigin();
      releaseFirst();
      const releaseSecond = await second;
      releaseSecond();
      expect(scheduler.getState('https://scholar.google.com').lastStart).toBe(3_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares and extends target cooldowns across waiters', async () => {
    jest.useFakeTimers();
    let now = 10_000;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    try {
      expect(scheduler.observeRetryAfter('https://publisher.example', 429, {})).toEqual({
        cooldownUntil: now + DEFAULT_SOURCE_COOLDOWN_MS
      });
      expect(scheduler.observeRetryAfter('https://publisher.example', 429, { 'retry-after': '10' })).toEqual({
        cooldownUntil: now + 10_000
      });
      const pending = scheduler.wait('https://publisher.example', undefined, 25_000);
      now = 19_999;
      await jest.advanceTimersByTimeAsync(9_999);
      now = 20_000;
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    undefined,
    '',
    '-1',
    '1.5',
    'not-a-date'
  ])('uses the safe default for invalid Retry-After %s', value => {
    let now = 1_000;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    const result = scheduler.observeRetryAfter('https://publisher.example', 429, value === undefined ? {} : { 'retry-after': value });
    expect(result.cooldownUntil).toBe(now + DEFAULT_SOURCE_COOLDOWN_MS);
  });

  it('treats zero and past HTTP dates as no additional cooldown', () => {
    const now = 1_000;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    expect(scheduler.observeRetryAfter('https://publisher.example', 429, { 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' })).toEqual({
      cooldownUntil: now
    });
    expect(scheduler.observeRetryAfter('https://other-publisher.example', 429, { 'retry-after': '0' })).toEqual({
      cooldownUntil: now
    });
  });

  it('accepts a strict future HTTP date and blocks unsafe values', async () => {
    const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    expect(scheduler.observeRetryAfter('https://publisher.example', 429, {
      'Retry-After': 'Wed, 21 Oct 2015 07:28:05 GMT'
    })).toEqual({ cooldownUntil: now + 5_000 });

    const blocked = new PublicSourceDispatchScheduler({ now: () => now });
    expect(blocked.observeRetryAfter('https://publisher.example', 429, { 'Retry-After': '999999999999999999999999' })).toEqual({ blocked: true });
    await expect(blocked.wait('https://publisher.example')).rejects.toBeInstanceOf(SourceDispatchBlockedError);
  });

  it('does not dispatch when the earliest safe start equals the deadline', async () => {
    let now = 0;
    const scheduler = new PublicSourceDispatchScheduler({ now: () => now });
    await scheduler.wait('https://publisher.example', undefined, 1000);
    await expect(scheduler.wait('https://publisher.example', undefined, 1000, 1000)).rejects.toBeInstanceOf(SourceDispatchDeadlineError);
  });
});
