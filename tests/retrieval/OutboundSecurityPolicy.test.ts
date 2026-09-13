import { describe, expect, it, jest } from '@jest/globals';
import { hasSensitiveCandidateCredentials, OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import { PublicHttpClient } from '../../src/services/PublicHttpClient.js';

const publicValidation = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 as const }]
});

describe('OutboundSecurityPolicy', () => {
  it('enforces sensitive-target checks even when a low-level validator is injected', async () => {
    const publicValidator = jest.fn(publicValidation);
    const policy = new OutboundSecurityPolicy({ validatePublicUrl: publicValidator });

    await expect(policy.validate('https://api.clarivate.com/apis/wos-starter'))
      .rejects.toThrow(/sensitive|restricted/i);
    expect(publicValidator).not.toHaveBeenCalled();
  });

  it.each([
    'https://cdn.example/paper.pdf?token=secret',
    'https://cdn.example/paper.pdf?client_secret=secret',
    'https://cdn.example/paper.pdf?X-Goog-Signature=secret',
    'https://cdn.example/paper.pdf#jwt=secret'
  ])('identifies credential-bearing candidate %s', value => {
    expect(hasSensitiveCandidateCredentials(value)).toBe(true);
  });

  it('does not classify ordinary candidate parameters as credentials', () => {
    expect(hasSensitiveCandidateCredentials('https://cdn.example/paper.pdf?download=1#page=2')).toBe(false);
  });

  it('rejects userinfo and mixed DNS answers before a requester is called', async () => {
    const policy = new OutboundSecurityPolicy({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.10', family: 4 }
      ]
    });

    await expect(policy.validate('https://user:pass@example.com/page')).rejects.toThrow(/userinfo/i);
    await expect(policy.validate('https://example.com/page')).rejects.toThrow(/non-public/i);
  });

  it('makes PublicHttpClient own validation and strips transport overrides', async () => {
    const request: any = jest.fn();
    request
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://other.example/landing' }, data: undefined })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });
    const validateUrl = jest.fn(publicValidation);
    const client = new PublicHttpClient({ client: { request }, validateUrl, maxRedirects: 1 });
    const callerLookup = jest.fn();

    await client.request('https://source.example/start', {
      proxy: { host: 'attacker.example', port: 80 } as any,
      maxRedirects: 99,
      lookup: callerLookup,
      httpAgent: { fake: true } as any,
      httpsAgent: { fake: true } as any,
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'X-Trace': 'keep'
      }
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(validateUrl).toHaveBeenCalledTimes(2);
    expect(callerLookup).not.toHaveBeenCalled();
    expect(request.mock.calls[0][0]).not.toHaveProperty('httpAgent');
    expect(request.mock.calls[0][0]).not.toHaveProperty('httpsAgent');
    expect(request.mock.calls[0][0].proxy).toBe(false);
    expect(request.mock.calls[0][0].maxRedirects).toBe(0);
    expect(request.mock.calls[1][0].headers).toEqual({ 'X-Trace': 'keep' });
  });
});
