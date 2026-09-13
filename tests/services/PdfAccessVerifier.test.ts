import { describe, expect, it, jest } from '@jest/globals';
import { PdfAccessVerifier, MAX_PDF_PROBE_BYTES } from '../../src/services/PdfAccessVerifier.js';
import type { PublicHttpResponseData } from '../../src/services/PublicHttpClient.js';

const validUrl = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 }]
});

function makeVerifier(
  request: (config: any) => Promise<PublicHttpResponseData>,
  timeoutMs = 10_000
): PdfAccessVerifier {
  return new PdfAccessVerifier({
    publicHttpRequester: { request },
    validateUrl: validUrl,
    timeoutMs
  });
}

function response(data: unknown, status = 206, headers: Record<string, string> = { 'content-type': 'application/pdf' }): PublicHttpResponseData {
  return { status, headers, data };
}

async function* chunks(values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

describe('PdfAccessVerifier', () => {
  it.each([
    ['200', 200],
    ['206', 206]
  ])('accepts a bounded PDF prefix from HTTP %s', async (_label, status) => {
    const request = jest.fn(async (config: any) => response(Buffer.from('%PDF-1.7\nbody'), status));
    const result = await makeVerifier(request).verify('https://publisher.example/paper.pdf');

    expect(result.status).toBe('verified');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      responseType: 'stream',
      headers: { Range: `bytes=0-${MAX_PDF_PROBE_BYTES - 1}` }
    }));
  });

  it('is invariant to one-byte, five-byte, and oversized first chunks', async () => {
    const prefix = Buffer.from('%PDF-1.7\nbody');
    const variants = [
      Array.from(prefix, value => Uint8Array.from([value])),
      Array.from({ length: Math.ceil(prefix.length / 5) }, (_value, index) => Uint8Array.from(prefix.subarray(index * 5, (index + 1) * 5))),
      [Uint8Array.from(prefix)],
      [Uint8Array.from(Buffer.concat([prefix, Buffer.alloc(MAX_PDF_PROBE_BYTES * 2)]))]
    ];

    for (const variant of variants) {
      const destroy = jest.fn();
      const body = chunks(variant) as AsyncIterable<Uint8Array> & { destroy: jest.Mock };
      body.destroy = destroy;
      const request = jest.fn(async () => response(body));
      await expect(makeVerifier(request).verify('https://publisher.example/paper.pdf'))
        .resolves.toEqual(expect.objectContaining({ status: 'verified' }));
      expect(destroy).toHaveBeenCalledTimes(1);
    }
  });

  it.each([MAX_PDF_PROBE_BYTES, MAX_PDF_PROBE_BYTES + 1])('verifies a PDF prefix at the %i-byte probe boundary', async length => {
    const body = Buffer.alloc(length, 97);
    Buffer.from('%PDF-').copy(body);
    const destroy = jest.fn();
    const stream = body as Buffer & { destroy: jest.Mock };
    stream.destroy = destroy;
    const request = jest.fn(async () => response(stream));

    await expect(makeVerifier(request).verify('https://publisher.example/paper.pdf'))
      .resolves.toEqual(expect.objectContaining({ status: 'verified' }));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2, 3, 4])('does not verify a body shorter than the five-byte signature (%i bytes)', async length => {
    const request = jest.fn(async () => response(Buffer.alloc(length)));
    await expect(makeVerifier(request).verify('https://publisher.example/paper.pdf'))
      .resolves.toEqual(expect.objectContaining({ status: 'inconclusive', reason: 'pdf_signature_missing' }));
  });

  it('handles a Uint8Array body without converting bytes to comma text', async () => {
    const request = jest.fn(async () => response(Uint8Array.from(Buffer.from('%PDF-'))));
    await expect(makeVerifier(request).verify('https://publisher.example/paper.pdf'))
      .resolves.toEqual(expect.objectContaining({ status: 'verified' }));
  });

  it('accepts PDF MIME parameters case-insensitively and rejects non-PDF MIME', async () => {
    const accepted = makeVerifier(jest.fn(async () => response(Buffer.from('%PDF-'), 200, {
      'content-type': 'Application/PDF; charset=binary'
    })));
    await expect(accepted.verify('https://publisher.example/paper.pdf')).resolves.toEqual(expect.objectContaining({ status: 'verified' }));

    const rejected = makeVerifier(jest.fn(async () => response(Buffer.from('%PDF-'), 200, {
      'content-type': 'text/html'
    })));
    await expect(rejected.verify('https://publisher.example/paper.pdf')).resolves.toEqual(expect.objectContaining({
      status: 'inconclusive',
      reason: 'pdf_mime_missing'
    }));
  });

  it('rejects non-finite response statuses and never uses HEAD', async () => {
    const request = jest.fn(async (_config: any) => response(Buffer.from('%PDF-'), Number.NaN));
    const result = await makeVerifier(request).verify('https://publisher.example/paper.pdf');
    expect(result).toEqual(expect.objectContaining({ status: 'failed', reason: 'http_status_unknown' }));
    expect(request.mock.calls.every(call => call[0].method !== 'HEAD')).toBe(true);
  });

  it('validates every redirect and stops before a private login target', async () => {
    const request = jest.fn(async (config: any) => config.url.endsWith('/paper.pdf')
      ? response(undefined, 302, { location: 'https://login.publisher.example/sso' })
      : response(Buffer.from('%PDF-'), 200));
    const result = await makeVerifier(request).verify('https://publisher.example/paper.pdf');
    expect(result).toEqual(expect.objectContaining({ status: 'failed', reason: 'restricted_target' }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('allows five redirects but rejects a sixth redirect', async () => {
    const makeRedirectSequence = (redirects: number) => {
      let calls = 0;
      return jest.fn(async (_config: any): Promise<PublicHttpResponseData> => {
        const current = calls++;
        return current < redirects
          ? response(undefined, 302, { location: `https://publisher.example/hop-${current + 1}.pdf` })
          : response(Buffer.from('%PDF-'), 200);
      });
    };

    const fiveRedirects = makeRedirectSequence(5);
    await expect(makeVerifier(fiveRedirects).verify('https://publisher.example/hop-0.pdf'))
      .resolves.toEqual(expect.objectContaining({ status: 'verified' }));
    expect(fiveRedirects.mock.calls.map(call => call[0].url)).toEqual([
      'https://publisher.example/hop-0.pdf',
      'https://publisher.example/hop-1.pdf',
      'https://publisher.example/hop-2.pdf',
      'https://publisher.example/hop-3.pdf',
      'https://publisher.example/hop-4.pdf',
      'https://publisher.example/hop-5.pdf'
    ]);

    const sixRedirects = makeRedirectSequence(6);
    await expect(makeVerifier(sixRedirects).verify('https://publisher.example/hop-0.pdf'))
      .resolves.toEqual(expect.objectContaining({ status: 'failed', reason: 'pdf_probe_failed' }));
    expect(sixRedirects.mock.calls.map(call => call[0].url)).toEqual([
      'https://publisher.example/hop-0.pdf',
      'https://publisher.example/hop-1.pdf',
      'https://publisher.example/hop-2.pdf',
      'https://publisher.example/hop-3.pdf',
      'https://publisher.example/hop-4.pdf',
      'https://publisher.example/hop-5.pdf'
    ]);
  });

  it('uses one total deadline across redirect hops', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const urls: string[] = [];
      const request = jest.fn((config: any) => new Promise<PublicHttpResponseData>(resolve => {
        urls.push(config.url);
        const current = calls++;
        setTimeout(() => resolve(response(undefined, 302, { location: `https://publisher.example/hop-${current + 1}.pdf` })), 8);
      }));
      const verification = makeVerifier(request, 10).verify('https://publisher.example/hop-0.pdf');
      await jest.advanceTimersByTimeAsync(10);
      await expect(verification).resolves.toEqual(expect.objectContaining({
        status: 'inconclusive',
        reason: 'aborted_or_timeout'
      }));
      expect(urls).toEqual([
        'https://publisher.example/hop-0.pdf',
        'https://publisher.example/hop-1.pdf'
      ]);
      expect(new Set(urls).size).toBe(urls.length);
      await jest.advanceTimersByTimeAsync(10);
      expect(urls).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out a stalled body, disposes it, and disposes a late response', async () => {
    jest.useFakeTimers();
    try {
      const stalledDestroy = jest.fn();
      const stalled: AsyncIterable<Buffer> & { destroy: jest.Mock } = {
        destroy: stalledDestroy,
        [Symbol.asyncIterator]: () => ({
          next: async () => new Promise<IteratorResult<Buffer>>(() => undefined),
          return: async () => ({ done: true, value: undefined })
        })
      };
      const stalledRequest = jest.fn(async () => response(stalled));
      const stalledVerification = makeVerifier(stalledRequest, 10).verify('https://publisher.example/paper.pdf');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(10);
      await expect(stalledVerification).resolves.toEqual(expect.objectContaining({
        status: 'inconclusive',
        reason: 'aborted_or_timeout'
      }));
      expect(stalledDestroy).toHaveBeenCalledTimes(1);

      const lateDestroy = jest.fn();
      const lateBody = Buffer.from('%PDF-') as Buffer & { destroy?: jest.Mock };
      lateBody.destroy = lateDestroy;
      const lateRequest = jest.fn(() => new Promise<PublicHttpResponseData>(resolve => {
        setTimeout(() => resolve(response(lateBody)), 30);
      }));
      const lateVerification = makeVerifier(lateRequest, 10).verify('https://publisher.example/paper.pdf');
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(10);
      await expect(lateVerification).resolves.toEqual(expect.objectContaining({
        status: 'inconclusive',
        reason: 'aborted_or_timeout'
      }));
      await jest.advanceTimersByTimeAsync(30);
      await Promise.resolve();
      expect(lateDestroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not dispatch after caller cancellation', async () => {
    const request = jest.fn(async () => response(Buffer.from('%PDF-')));
    const controller = new AbortController();
    controller.abort();
    const result = await makeVerifier(request).verify('https://publisher.example/paper.pdf', controller.signal);
    expect(result).toEqual(expect.objectContaining({ status: 'inconclusive', reason: 'aborted_or_timeout' }));
    expect(request).not.toHaveBeenCalled();
  });
});
