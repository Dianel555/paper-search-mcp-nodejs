import { describe, expect, it } from '@jest/globals';
import { isPublicAddress, validatePublicHttpUrl } from '../../src/utils/PublicNetwork.js';

describe('PublicNetwork', () => {
  it('rejects private, loopback, link-local, and IPv4-mapped IPv6 addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::ffff:7f00:1']) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('rejects non-http schemes and userinfo', async () => {
    await expect(validatePublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/HTTP/);
    await expect(validatePublicHttpUrl('https://user:pass@example.com', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    })).rejects.toThrow(/userinfo/);
  });

  it('requires every DNS answer to be public', async () => {
    await expect(validatePublicHttpUrl('https://example.com', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.10', family: 4 }
      ]
    })).rejects.toThrow(/non-public/);
  });
});
