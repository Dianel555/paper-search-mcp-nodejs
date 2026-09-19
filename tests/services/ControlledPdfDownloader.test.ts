import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  ControlledPdfDownloader,
  publicPaperDestinationPath,
  type ControlledPdfHttpClient
} from '../../src/services/ControlledPdfDownloader.js';
import type { RetrievalOperationContext } from '../../src/retrieval/types.js';

const roots: string[] = [];

function operation(): RetrievalOperationContext {
  const signal = new AbortController().signal;
  return {
    operationId: 'controlled-pdf-test',
    signal,
    deadlineAt: Date.now() + 120_000,
    remainingMs: () => 120_000,
    cost: {} as any
  };
}

function response(status: number, body: unknown, contentType?: string): any {
  return {
    response: {
      status,
      headers: contentType === undefined ? {} : { 'content-type': contentType },
      data: body
    },
    finalUrl: 'https://cdn.example/paper.pdf'
  };
}

function client(request: ControlledPdfHttpClient['request']): ControlledPdfHttpClient {
  return { request };
}

function directory(): string {
  const root = fs.mkdtempSync(path.resolve('downloads') + `${path.sep}controlled-pdf-`);
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ControlledPdfDownloader', () => {
  it('requires PDF MIME and magic, then publishes stable no-clobber bytes', async () => {
    const saveDirectory = directory();
    const request = jest.fn(async () => response(200, Readable.from([Buffer.from('%PDF-test bytes')]), 'application/pdf'));
    const downloader = new ControlledPdfDownloader({
      httpClient: client(request),
      validateUrl: async url => ({ url, hostname: new URL(url).hostname, addresses: [{ address: '93.184.216.34', family: 4 }] })
    });

    const filePath = await downloader.download({
      platform: 'publisher',
      normalizedPaperId: '10.1000/test',
      candidates: ['https://cdn.example/paper.pdf'],
      saveDirectory,
      operation: operation(),
      mode: 'new_public'
    });

    expect(filePath).toBe(publicPaperDestinationPath(saveDirectory, 'publisher', '10.1000/test'));
    expect(fs.readFileSync(filePath).toString()).toBe('%PDF-test bytes');
    expect(request).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(saveDirectory).some(name => name.includes('.tmp-'))).toBe(false);
  });

  it('terminates on MIME or magic failure and never writes the final destination', async () => {
    const saveDirectory = directory();
    const request = jest.fn(async () => response(200, Buffer.from('%PDF-but-html'), 'text/html'));
    const downloader = new ControlledPdfDownloader({ httpClient: client(request) });
    await expect(downloader.download({
      platform: 'publisher', normalizedPaperId: '10.1000/mime',
      candidates: ['https://cdn.example/mime.pdf'], saveDirectory, operation: operation(), mode: 'new_public'
    })).rejects.toMatchObject({ reason: 'pdf_mime_mismatch' });

    request.mockImplementation(async () => response(200, Buffer.from('<html>not pdf</html>'), 'application/pdf'));
    await expect(downloader.download({
      platform: 'publisher', normalizedPaperId: '10.1000/magic',
      candidates: ['https://cdn.example/magic.pdf'], saveDirectory, operation: operation(), mode: 'new_public'
    })).rejects.toMatchObject({ reason: 'pdf_magic_mismatch' });
    expect(fs.readdirSync(saveDirectory).filter(name => name.endsWith('.pdf'))).toHaveLength(0);
  });

  it('continues after a bounded 404 candidate but preserves legacy missing-MIME compatibility', async () => {
    const saveDirectory = directory();
    const request = jest.fn(async (url: string) => url.includes('missing')
      ? response(404, Buffer.from('missing'), 'text/html')
      : response(200, Buffer.from('%PDF-legacy'), undefined));
    const downloader = new ControlledPdfDownloader({ httpClient: client(request) });
    await expect(downloader.download({
      platform: 'scihub', normalizedPaperId: '10.1000/legacy',
      candidates: ['https://cdn.example/missing.pdf', 'https://cdn.example/legacy.pdf'],
      saveDirectory, operation: operation(), mode: 'legacy_scihub'
    })).resolves.toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy filename and overwrite behavior explicit', async () => {
    const saveDirectory = directory();
    const legacyPath = path.join(saveDirectory, '10.1000_legacy-overwrite.pdf');
    fs.writeFileSync(legacyPath, '%PDF-old');
    const request = jest.fn(async () => response(200, Buffer.from('%PDF-new'), undefined));
    const downloader = new ControlledPdfDownloader({ httpClient: client(request) });
    await expect(downloader.download({
      platform: 'scihub', normalizedPaperId: '10.1000/legacy-overwrite',
      candidates: ['https://cdn.example/legacy-overwrite.pdf'], saveDirectory, operation: operation(), mode: 'legacy_scihub'
    })).resolves.toBe(legacyPath);
    expect(fs.readFileSync(legacyPath).toString()).toBe('%PDF-new');
  });

  it('returns destination_exists before transport and does not replace a race winner', async () => {
    const saveDirectory = directory();
    const destination = publicPaperDestinationPath(saveDirectory, 'publisher', '10.1000/existing');
    fs.writeFileSync(destination, '%PDF-existing');
    const request = jest.fn(async () => response(200, Buffer.from('%PDF-new'), 'application/pdf'));
    const downloader = new ControlledPdfDownloader({ httpClient: client(request) });
    await expect(downloader.download({
      platform: 'publisher', normalizedPaperId: '10.1000/existing',
      candidates: ['https://cdn.example/existing.pdf'], saveDirectory, operation: operation(), mode: 'new_public'
    })).rejects.toMatchObject({ reason: 'destination_exists' });
    expect(request).not.toHaveBeenCalled();
    expect(fs.readFileSync(destination).toString()).toBe('%PDF-existing');
  });
});
