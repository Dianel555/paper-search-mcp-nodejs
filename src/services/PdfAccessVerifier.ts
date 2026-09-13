import { withTimeout } from '../utils/SecurityUtils.js';
import { disposeResponseBody, getHeaderValue, validatePublicHttpUrl, type PublicUrlValidation } from '../utils/PublicNetwork.js';
import { OutboundSecurityError, OutboundSecurityPolicy } from '../retrieval/OutboundSecurityPolicy.js';
import { PublicHttpClient, type PublicHttpRequester } from './PublicHttpClient.js';

export const PDF_PROBE_TIMEOUT_MS = 10_000;
export const MAX_PDF_PROBE_BYTES = 64 * 1024;

const disposedBodies = new WeakSet<object>();
const disposedIterators = new WeakSet<object>();

export interface PdfVerificationResult {
  readonly status: 'verified' | 'failed' | 'inconclusive';
  readonly reason?: string;
  readonly finalUrl?: string;
}

export interface PdfAccessVerifierOptions {
  publicHttpClient?: PublicHttpClient;
  publicHttpRequester?: PublicHttpRequester;
  validateUrl?: (url: string) => Promise<PublicUrlValidation>;
  timeoutMs?: number;
}

/** Performs only a bounded direct prefix probe; it never writes or downloads a PDF. */
export class PdfAccessVerifier {
  private readonly publicHttpClient: PublicHttpClient;
  private readonly timeoutMs: number;

  constructor(options: PdfAccessVerifierOptions = {}) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs || 0) > 0
      ? Math.min(options.timeoutMs as number, PDF_PROBE_TIMEOUT_MS)
      : PDF_PROBE_TIMEOUT_MS;
    const validateUrl = options.validateUrl || ((url: string) => validatePublicHttpUrl(url));
    const securityPolicy = new OutboundSecurityPolicy({ validatePublicUrl: validateUrl });
    this.publicHttpClient = options.publicHttpClient || new PublicHttpClient({
      client: options.publicHttpRequester,
      purpose: 'pdf_probe',
      securityPolicy
    });
  }

  async verify(url: string, parentSignal?: AbortSignal): Promise<PdfVerificationResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    let fetched: Awaited<ReturnType<PublicHttpClient['request']>> | undefined;
    let settled = false;
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const probe = (async (): Promise<PdfVerificationResult> => {
        const responsePromise = this.publicHttpClient.request(url, {
          method: 'GET',
          headers: { Range: `bytes=0-${MAX_PDF_PROBE_BYTES - 1}` },
          responseType: 'stream',
          timeout: this.timeoutMs,
          signal: controller.signal
        }).then(response => {
          if (settled || controller.signal.aborted) disposeUnknownResponseBody(response.response.data);
          else fetched = response;
          return response;
        });
        fetched = await responsePromise;
        const status = Number(fetched.response.status);
        const contentType = getHeaderValue(fetched.response.headers, 'content-type') || '';
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          return { status: 'failed', reason: `http_status_${Number.isFinite(status) ? status : 'unknown'}` };
        }
        if (!/^application\/pdf(?:\s*;|\s*$)/i.test(contentType)) {
          return { status: 'inconclusive', reason: 'pdf_mime_missing' };
        }
        const prefix = await readBoundedPrefix(fetched.response.data, controller.signal);
        if (!prefix.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          return { status: 'inconclusive', reason: 'pdf_signature_missing' };
        }
        return { status: 'verified', finalUrl: fetched.finalUrl };
      })();
      return await withTimeout(
        probe,
        this.timeoutMs,
        'PDF verification timed out',
        () => controller.abort()
      );
    } catch (error) {
      if (parentSignal?.aborted || controller.signal.aborted) return { status: 'inconclusive', reason: 'aborted_or_timeout' };
      if (error instanceof OutboundSecurityError) return { status: 'failed', reason: 'restricted_target' };
      return { status: 'failed', reason: 'pdf_probe_failed' };
    } finally {
      settled = true;
      disposeUnknownResponseBody(fetched?.response.data);
      parentSignal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}

async function readBoundedPrefix(body: unknown, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new Error('PDF probe aborted');
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return boundedStringPrefix(body);
  if (Buffer.isBuffer(body)) return Buffer.from(body.subarray(0, MAX_PDF_PROBE_BYTES));
  if (body instanceof Uint8Array) return Buffer.from(body.subarray(0, MAX_PDF_PROBE_BYTES));
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let total = 0;
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (total < MAX_PDF_PROBE_BYTES) {
        const next = await waitForAbort(Promise.resolve(iterator.next()), signal, () => disposeAsyncIterator(body, iterator));
        if (next.done) break;
        const chunk = next.value;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk));
        const remaining = MAX_PDF_PROBE_BYTES - total;
        const prefix = buffer.subarray(0, remaining);
        chunks.push(prefix);
        total += prefix.byteLength;
        // The five-byte magic is decisive. Closing here also handles a
        // server that ignores Range and sends a large first chunk.
        if (total >= 5) break;
      }
    } finally {
      disposeAsyncIterator(body, iterator);
    }
    return Buffer.concat(chunks, total);
  }
  return Buffer.alloc(0);
}

function boundedStringPrefix(value: string): Buffer {
  if (Buffer.byteLength(value) <= MAX_PDF_PROBE_BYTES) return Buffer.from(value);
  let end = 0;
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > MAX_PDF_PROBE_BYTES) break;
    bytes += size;
    end += character.length;
  }
  return Buffer.from(value.slice(0, end));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function disposeAsyncIterator(body: unknown, iterator: AsyncIterator<unknown>): void {
  if (isObject(body) && !disposedBodies.has(body)) {
    disposedBodies.add(body);
    disposeResponseBody(body);
  }
  if (isObject(iterator) && disposedIterators.has(iterator)) return;
  if (isObject(iterator)) disposedIterators.add(iterator);
  try {
    const closing = iterator.return?.();
    if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Cleanup must not replace the probe result.
  }
}

function disposeUnknownResponseBody(body: unknown): void {
  if (!isAsyncIterable(body)) {
    if (isObject(body) && !disposedBodies.has(body)) {
      disposedBodies.add(body);
      disposeResponseBody(body);
    } else if (!isObject(body)) {
      disposeResponseBody(body);
    }
    return;
  }
  try {
    disposeAsyncIterator(body, body[Symbol.asyncIterator]());
  } catch {
    if (isObject(body) && !disposedBodies.has(body)) {
      disposedBodies.add(body);
      disposeResponseBody(body);
    }
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('PDF probe aborted'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    const onAbort = () => {
      if (settled) return;
      abandoned = true;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new Error('PDF probe aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      if (settled) {
        if (abandoned) onLateValue?.(value);
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

export default PdfAccessVerifier;
