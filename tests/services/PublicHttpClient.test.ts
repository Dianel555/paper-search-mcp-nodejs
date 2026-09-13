import { describe, expect, it, jest } from '@jest/globals';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';
import { createPinnedLookup, type PublicUrlValidation } from '../../src/utils/PublicNetwork.js';

describe('PublicHttpClient', () => {
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
