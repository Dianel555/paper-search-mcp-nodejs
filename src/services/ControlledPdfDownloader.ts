import * as fs from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getHeaderValue, disposeResponseBody } from '../utils/PublicNetwork.js';
import { hasSensitiveCandidateCredentials, OutboundSecurityError } from '../retrieval/OutboundSecurityPolicy.js';
import { isPublicAddress } from '../utils/PublicNetwork.js';
import { sanitizeFilename } from '../utils/SecurityUtils.js';
import type { RetrievalOperationContext } from '../retrieval/types.js';
import { retrievalFailureKindForAbort } from '../retrieval/abortDiagnostics.js';
import { PublicHttpClient, type PublicHttpRequestConfig, type PublicHttpResponse } from './PublicHttpClient.js';

export type ControlledPdfDownloadMode = 'new_public' | 'legacy_scihub';

export interface ControlledPdfHttpClient {
  request(url: string, config?: PublicHttpRequestConfig): Promise<PublicHttpResponse<unknown>>;
}

export interface ControlledPdfDownloaderOptions {
  readonly httpClient?: ControlledPdfHttpClient;
  /** Test seam; production PublicHttpClient performs full DNS/redirect validation. */
  readonly validateUrl?: (url: string) => Promise<unknown>;
  readonly maxFileBytes?: number;
}

export interface ControlledPdfDownloadRequest {
  readonly platform: string;
  readonly normalizedPaperId: string;
  readonly candidates: readonly string[];
  readonly saveDirectory: string;
  readonly operation: RetrievalOperationContext;
  readonly mode: ControlledPdfDownloadMode;
}

export type ControlledPdfFailureReason =
  | 'destination_exists'
  | 'pdf_mime_mismatch'
  | 'pdf_magic_mismatch'
  | 'pdf_resource_limit'
  | 'download_failed'
  | 'target_rate_limited'
  | 'restricted_target'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'no_clobber_unsupported';

export class ControlledPdfDownloadError extends Error {
  readonly reason: ControlledPdfFailureReason;
  readonly status?: number;

  constructor(reason: ControlledPdfFailureReason, status?: number) {
    super(reason);
    this.name = 'ControlledPdfDownloadError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Local, bounded PDF handoff. It accepts already-selected candidates only; it
 * never performs DOI lookup or provider/page discovery and never exposes raw
 * provider data to callers.
 */
export class ControlledPdfDownloader {
  private readonly httpClient: ControlledPdfHttpClient;
  private readonly validateUrl?: (url: string) => Promise<unknown>;
  private readonly maxFileBytes: number;

  constructor(options: ControlledPdfDownloaderOptions = {}) {
    this.httpClient = options.httpClient || new PublicHttpClient({ purpose: 'pdf_download' });
    this.validateUrl = options.validateUrl;
    this.maxFileBytes = Number.isSafeInteger(options.maxFileBytes) && (options.maxFileBytes as number) > 0
      ? options.maxFileBytes as number
      : readMaxFileSize();
  }

  async download(request: ControlledPdfDownloadRequest): Promise<string> {
    const destination = request.mode === 'legacy_scihub'
      ? path.join(path.resolve(request.saveDirectory), `${sanitizeFilename(request.normalizedPaperId)}.pdf`)
      : publicPaperDestinationPath(request.saveDirectory, request.platform, request.normalizedPaperId);
    await ensureSafeDirectory(request.saveDirectory, destination);
    const existingDestination = await lstatIfPresent(destination);
    if (existingDestination) {
      if (existingDestination.isSymbolicLink() || !existingDestination.isFile()) {
        throw new ControlledPdfDownloadError('restricted_target');
      }
      if (request.mode === 'new_public') throw new ControlledPdfDownloadError('destination_exists');
    }

    const candidates = boundedCandidates(request.candidates);
    if (!candidates.length) throw new ControlledPdfDownloadError('download_failed');
    let lastFailure: ControlledPdfDownloadError | undefined;
    for (const candidate of candidates) {
      throwIfOperationAvailable(request.operation);
      try {
        await this.validateCandidate(candidate);
        const response = await this.requestCandidate(candidate, request);
        if (response.finalUrl) await this.validateCandidate(response.finalUrl);
        const status = Number(response.response.status);
        if (status === 404 || status === 410) {
          disposeResponseBody(response.response.data);
          lastFailure = new ControlledPdfDownloadError('download_failed', status);
          continue;
        }
        if (status === 429) {
          disposeResponseBody(response.response.data);
          throw new ControlledPdfDownloadError('target_rate_limited', status);
        }
        if (status === 401 || status === 403 || status === 407) {
          disposeResponseBody(response.response.data);
          throw new ControlledPdfDownloadError('restricted_target', status);
        }
        if (status < 200 || status >= 300) {
          disposeResponseBody(response.response.data);
          lastFailure = new ControlledPdfDownloadError('download_failed', status);
          continue;
        }

        const contentType = getHeaderValue(response.response.headers, 'content-type');
        if (request.mode === 'new_public' && !contentType) {
          disposeResponseBody(response.response.data);
          throw new ControlledPdfDownloadError('pdf_mime_mismatch', status);
        }
        if (contentType && !/^application\/(?:pdf|octet-stream)(?:\s*;|$)/i.test(contentType)) {
          disposeResponseBody(response.response.data);
          throw new ControlledPdfDownloadError('pdf_mime_mismatch', status);
        }
        const contentLength = Number(getHeaderValue(response.response.headers, 'content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.maxFileBytes) {
          disposeResponseBody(response.response.data);
          throw new ControlledPdfDownloadError('pdf_resource_limit', status);
        }

        try {
          await this.writeAndPublish(response, destination, request);
          return destination;
        } catch (error) {
          if (error instanceof ControlledPdfDownloadError) throw error;
          if (isOperationUnavailable(request.operation)) throw operationError(request.operation);
          lastFailure = new ControlledPdfDownloadError('download_failed', status);
        }
      } catch (error) {
        if (error instanceof ControlledPdfDownloadError) {
          if (error.reason === 'download_failed') {
            lastFailure = error;
            continue;
          }
          throw error;
        }
        if (isOperationUnavailable(request.operation)) throw operationError(request.operation);
        lastFailure = new ControlledPdfDownloadError('download_failed');
      }
    }
    throw lastFailure || new ControlledPdfDownloadError('download_failed');
  }

  private async validateCandidate(candidate: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new ControlledPdfDownloadError('restricted_target');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password
      || hasSensitiveCandidateCredentials(parsed.toString())
      || isPrivateHost(parsed.hostname)) {
      throw new ControlledPdfDownloadError('restricted_target');
    }
    if (this.validateUrl) {
      try {
        await this.validateUrl(parsed.toString());
      } catch {
        throw new ControlledPdfDownloadError('restricted_target');
      }
    }
  }

  private async requestCandidate(
    candidate: string,
    request: ControlledPdfDownloadRequest
  ): Promise<PublicHttpResponse<unknown>> {
    throwIfOperationAvailable(request.operation);
    try {
      return await this.httpClient.request(candidate, {
        method: 'GET',
        responseType: 'stream',
        timeout: Math.max(1, Math.min(120_000, request.operation.remainingMs())),
        deadlineAt: request.operation.deadlineAt,
        signal: request.operation.signal,
        ...(request.operation.dispatchObserver ? { dispatchObserver: request.operation.dispatchObserver } : {}),
        ...(request.operation.withDispatchSlot ? { dispatchSlot: request.operation.withDispatchSlot } : {})
      });
    } catch (error) {
      if (isOperationUnavailable(request.operation)) throw operationError(request.operation);
      const status = errorStatus(error);
      if (status === 429) throw new ControlledPdfDownloadError('target_rate_limited', status);
      if (status === 401 || status === 403 || status === 407) throw new ControlledPdfDownloadError('restricted_target', status);
      if (error instanceof OutboundSecurityError || error instanceof Error && /security|target|private|sensitive|userinfo/i.test(error.name)) {
        throw new ControlledPdfDownloadError('restricted_target', status);
      }
      if (error instanceof Error && /cooling down|rate limit/i.test(error.message)) {
        throw new ControlledPdfDownloadError('target_rate_limited', status);
      }
      throw new ControlledPdfDownloadError('download_failed', status);
    }
  }

  private async writeAndPublish(
    response: PublicHttpResponse<unknown>,
    destination: string,
    request: ControlledPdfDownloadRequest
  ): Promise<void> {
    const temporaryPath = `${destination}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
      await writeValidatedPdf(response.response.data, temporaryPath, this.maxFileBytes, request.operation);
      throwIfOperationAvailable(request.operation);
      const existing = await lstatIfPresent(destination);
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
        throw new ControlledPdfDownloadError('restricted_target');
      }
      if (existing && request.mode === 'new_public') throw new ControlledPdfDownloadError('destination_exists');
      if (request.mode === 'legacy_scihub') {
        await fs.promises.rename(temporaryPath, destination);
        return;
      }
      try {
        await fs.promises.link(temporaryPath, destination);
      } catch (error: any) {
        if (error?.code === 'EEXIST') throw new ControlledPdfDownloadError('destination_exists');
        if (error?.code === 'EXDEV' || error?.code === 'EPERM' || error?.code === 'ENOTSUP') {
          throw new ControlledPdfDownloadError('no_clobber_unsupported');
        }
        throw error;
      }
      await fs.promises.unlink(temporaryPath);
    } finally {
      disposeResponseBody(response.response.data);
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function publicPaperDestinationPath(
  saveDirectory: string,
  platform: string,
  normalizedPaperId: string
): string {
  const digest = createHash('sha256')
    .update(`${platform}\u0000${normalizedPaperId}`, 'utf8')
    .digest('hex');
  return path.join(path.resolve(saveDirectory), `${sanitizeFilename(platform)}-${digest}.pdf`);
}

async function ensureSafeDirectory(saveDirectory: string, destination: string): Promise<void> {
  const root = path.resolve(saveDirectory);
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(destination) !== root) {
    throw new ControlledPdfDownloadError('restricted_target');
  }
  await fs.promises.mkdir(root, { recursive: true });
  const stat = await fs.promises.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ControlledPdfDownloadError('restricted_target');
}

function boundedCandidates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 20) break;
  }
  return result;
}

async function writeValidatedPdf(
  data: unknown,
  temporaryPath: string,
  maxBytes: number,
  operation: RetrievalOperationContext
): Promise<void> {
  let bytes = 0;
  let header = Buffer.alloc(0);
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        callback(new ControlledPdfDownloadError('pdf_resource_limit'));
        return;
      }
      if (header.length < 5) header = Buffer.concat([header, buffer]).subarray(0, 5);
      callback(null, buffer);
    }
  });
  const source = isAsyncIterable(data)
    ? data as NodeJS.ReadableStream
    : Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : '')]);
  const destination = fs.createWriteStream(temporaryPath, { flags: 'wx' });
  try {
    throwIfOperationAvailable(operation);
    await pipeline(source as any, validator, destination, { signal: operation.signal });
    if (!header.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new ControlledPdfDownloadError('pdf_magic_mismatch');
    }
  } catch (error) {
    (source as any).destroy?.();
    destination.destroy();
    if (error instanceof ControlledPdfDownloadError) throw error;
    if (isOperationUnavailable(operation)) throw operationError(operation);
    throw new ControlledPdfDownloadError('download_failed');
  }
}

function isPrivateHost(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (value === 'localhost'
    || value === 'localhost.localdomain'
    || value === 'ip6-localhost'
    || value === 'metadata.google.internal'
    || value === 'metadata.google.com'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value.endsWith('.internal')) return true;

  return isIP(value) !== 0 && !isPublicAddress(value);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function');
}

function throwIfOperationAvailable(operation: RetrievalOperationContext): void {
  if (operation.signal.aborted || operation.remainingMs() <= 0) throw operationError(operation);
}

function isOperationUnavailable(operation: RetrievalOperationContext): boolean {
  return operation.signal.aborted || operation.remainingMs() <= 0;
}

function operationError(operation: RetrievalOperationContext): ControlledPdfDownloadError {
  return new ControlledPdfDownloadError(
    retrievalFailureKindForAbort(operation.signal, operation) === 'operation_deadline'
      ? 'deadline_exceeded'
      : 'cancelled'
  );
}

function errorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown } } | undefined;
  const value = candidate?.status ?? candidate?.response?.status;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

async function lstatIfPresent(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function readMaxFileSize(): number {
  const configured = Number(process.env.MAX_FILE_SIZE_MB);
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : 100;
  return megabytes * 1024 * 1024;
}

export default ControlledPdfDownloader;
