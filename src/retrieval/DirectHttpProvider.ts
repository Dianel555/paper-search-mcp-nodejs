import { type AxiosRequestConfig } from 'axios';
import { TIMEOUTS } from '../config/constants.js';
import { disposeResponseBody, getHeaderValue } from '../utils/PublicNetwork.js';
import {
  RetrievalError,
  type FiniteDocument,
  type RetrievalOperationContext,
  type RetrievalProvider,
  type RetrievalPurpose,
  type RetrievalRequest,
  type RetrievalResponse
} from './types.js';
import { PublicHttpClient, type PublicHttpResponse } from '../services/PublicHttpClient.js';
import { OutboundSecurityError, SensitiveOutboundTargetError } from './OutboundSecurityPolicy.js';
import { SourceCooldownError, SourceDispatchDeadlineError } from '../services/PublicSourceDispatchScheduler.js';
import { relayAbortReason, retrievalFailureKindForAbort } from './abortDiagnostics.js';

export const MAX_RETRIEVAL_RESPONSE_BYTES = 5 * 1024 * 1024;

type DirectHttpClient = {
  request(url: string, config?: AxiosRequestConfig): Promise<PublicHttpResponse<unknown>>;
};

export interface DirectHttpProviderOptions {
  publicHttpClient?: DirectHttpClient;
  /** Internal purpose routing for isolated transports such as Scholar sessions. */
  publicHttpClients?: Partial<Record<RetrievalPurpose, DirectHttpClient>>;
  maxResponseBytes?: number;
}

/** One controlled direct HTTP attempt; retry ownership belongs to RetrievalService. */
export class DirectHttpProvider implements RetrievalProvider {
  readonly name = 'direct';
  readonly capabilities = {
    html: true,
    iframeDocuments: false,
    pdfCandidates: false,
    browser: false,
    paid: false,
    proxyTypes: ['datacenter'],
    combinations: ['direct:datacenter'],
    dispatchObservation: true,
    transportSlotManagement: true
  } as const;

  private readonly publicHttpClient: DirectHttpClient;
  private readonly publicHttpClients: Partial<Record<RetrievalPurpose, DirectHttpClient>>;
  private readonly maxResponseBytes: number;

  constructor(options: DirectHttpProviderOptions = {}) {
    this.publicHttpClient = options.publicHttpClient || new PublicHttpClient({ purpose: 'retrieval' });
    this.publicHttpClients = options.publicHttpClients || {};
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RETRIEVAL_RESPONSE_BYTES;
  }

  async retrieve(request: RetrievalRequest, context: RetrievalOperationContext): Promise<RetrievalResponse> {
    throwIfAborted(context);
    if (request.strategy !== 'direct') {
      throw new RetrievalError({
        code: 'invalid_request',
        message: 'Direct provider only accepts the direct retrieval strategy',
        provider: this.name
      });
    }

    const remainingMs = context.remainingMs();
    if (remainingMs <= 0) {
      throw new RetrievalError({ code: 'timeout', message: 'Retrieval operation timed out', provider: this.name, failureKind: 'operation_deadline' });
    }

    let response: PublicHttpResponse<unknown> | undefined;
    let responseBodyStarted = false;
    const linkedSignal = linkAbortSignals(context.signal, request.signal);
    const publicHttpClient = this.publicHttpClients[request.purpose] || this.publicHttpClient;
    try {
      throwIfAborted(context, linkedSignal.signal);
      response = await publicHttpClient.request(request.url, {
        method: 'GET',
        ...(request.query ? { params: request.query } : {}),
        responseType: 'stream',
        timeout: Math.min(TIMEOUTS.DEFAULT, remainingMs),
        deadlineAt: context.deadlineAt,
        signal: linkedSignal.signal,
        holdSourceLease: true,
        ...(request.dispatchObserver ? { dispatchObserver: request.dispatchObserver } : {}),
        ...(context.withDispatchSlot ? { dispatchSlot: context.withDispatchSlot } : {})
      } as AxiosRequestConfig & { dispatchObserver?: unknown; dispatchSlot?: unknown });
      throwIfAborted(context, linkedSignal.signal);
      const readBody = () => {
        responseBodyStarted = true;
        return readBoundedText(response!.response.data, this.maxResponseBytes, context, linkedSignal.signal);
      };
      const html = context.withDispatchSlot
        ? await context.withDispatchSlot(readBody, linkedSignal.signal)
        : await readBody();
      const targetStatus = Number(response.response.status);
      const document: FiniteDocument = {
        kind: 'html',
        html,
        iframes: [],
        source: {
          provenance: 'trusted_direct',
          finalUrl: response.finalUrl
        },
        ...(Number.isFinite(targetStatus) ? { targetStatus } : {})
      };

      return {
        provider: this.name,
        strategy: request.strategy,
        targetStatus: Number.isFinite(targetStatus) ? targetStatus : undefined,
        document,
        contentType: getHeaderValue(response.response.headers, 'content-type'),
        cost: { known: true, credits: 0 }
      };
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      if (error instanceof SourceDispatchDeadlineError) {
        throw new RetrievalError({ code: 'timeout', message: 'Direct retrieval timed out', provider: this.name, failureKind: 'operation_deadline' });
      }
      if (error instanceof SourceCooldownError) {
        throw new RetrievalError({ code: 'target_unavailable', message: 'Public source is cooling down', provider: this.name, targetStatus: 429 });
      }
      if (error instanceof OutboundSecurityError || error instanceof SensitiveOutboundTargetError) {
        throw new RetrievalError({ code: 'security', message: 'Retrieval target was rejected by outbound security policy', provider: this.name });
      }
      if (linkedSignal.signal.aborted || isAbortError(error)) {
        throw new RetrievalError({
          code: 'cancelled',
          message: 'Retrieval operation was cancelled',
          provider: this.name,
          failureKind: retrievalFailureKindForAbort(linkedSignal.signal, context)
        });
      }
      if (isTimeoutError(error) || context.remainingMs() <= 0) {
        throw new RetrievalError({
          code: 'timeout',
          message: 'Direct retrieval timed out',
          provider: this.name,
          failureKind: context.remainingMs() <= 0
            ? 'operation_deadline'
            : responseBodyStarted ? 'response_body' : 'transport_timeout'
        });
      }
      throw new RetrievalError({
        code: 'network',
        message: 'Direct retrieval failed',
        provider: this.name,
        retryable: true,
        ...(responseBodyStarted ? { failureKind: 'response_body' as const } : {})
      });
    } finally {
      if (response) {
        disposeUnknownResponseBody(response.response.data);
        response.release?.();
      }
      linkedSignal.dispose();
    }
  }
}

async function readBoundedText(
  body: unknown,
  maxBytes: number,
  context: RetrievalOperationContext,
  signal: AbortSignal
): Promise<string> {
  throwIfAborted(context, signal);
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') {
    ensureSize(Buffer.byteLength(body), maxBytes);
    return body;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    ensureSize(body.byteLength, maxBytes);
    return Buffer.from(body).toString('utf8');
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let total = 0;
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await waitForAbort(
          Promise.resolve(iterator.next()),
          signal,
          () => disposeAsyncIterator(body, iterator),
          () => retrievalFailureKindForAbort(signal, context)
        );
        if (next.done) break;
        throwIfAborted(context, signal);
        const chunk = next.value;
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
        total += buffer.byteLength;
        ensureSize(total, maxBytes, body);
        chunks.push(buffer);
      }
    } finally {
      disposeAsyncIterator(body, iterator);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  throw new RetrievalError({
    code: 'invalid_request',
    message: 'Direct retrieval returned an unsupported document body',
    provider: 'direct'
  });
}

function ensureSize(size: number, maxBytes: number, body?: unknown): void {
  if (size <= maxBytes) return;
  disposeResponseBody(body);
  throw new RetrievalError({
    code: 'response_too_large',
    message: 'Retrieval response exceeds the allowed size',
    provider: 'direct',
    failureKind: 'response_body'
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function disposeAsyncIterator(body: unknown, iterator: AsyncIterator<unknown>): void {
  disposeResponseBody(body);
  try {
    const closing = iterator.return?.();
    if (closing && typeof (closing as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(closing).catch(() => undefined);
    }
  } catch {
    // Cleanup must not replace the retrieval error.
  }
}

function disposeUnknownResponseBody(body: unknown): void {
  if (!isAsyncIterable(body)) {
    disposeResponseBody(body);
    return;
  }
  try {
    disposeAsyncIterator(body, body[Symbol.asyncIterator]());
  } catch {
    disposeResponseBody(body);
  }
}

function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
  failureKind?: () => RetrievalError['failureKind']
): Promise<T> {
  if (signal.aborted) return Promise.reject(new RetrievalError({
    code: 'cancelled',
    message: 'Retrieval operation was cancelled',
    provider: 'direct',
    failureKind: failureKind?.() || 'cancelled'
  }));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abandoned = false;
    const onAbort = () => {
      if (settled) return;
      abandoned = true;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new RetrievalError({
        code: 'cancelled',
        message: 'Retrieval operation was cancelled',
        provider: 'direct',
        failureKind: failureKind?.() || 'cancelled'
      }));
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

function throwIfAborted(context: RetrievalOperationContext, signal: AbortSignal = context.signal): void {
  if (context.signal.aborted || signal.aborted) {
    throw new RetrievalError({
      code: 'cancelled',
      message: 'Retrieval operation was cancelled',
      provider: 'direct',
      failureKind: retrievalFailureKindForAbort(signal, context)
    });
  }
}

function linkAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const relay = () => relayAbortReason(controller, primary.aborted ? primary : secondary!);
  if (primary.aborted || secondary.aborted) relay();
  else {
    primary.addEventListener('abort', relay, { once: true });
    secondary.addEventListener('abort', relay, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', relay);
      secondary.removeEventListener('abort', relay);
      controller.abort();
    }
  };
}

function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | undefined;
  return candidate?.name === 'AbortError' || candidate?.code === 'ERR_CANCELED';
}

function isTimeoutError(error: unknown): boolean {
  const candidate = error as { code?: string; name?: string } | undefined;
  return candidate?.code === 'ECONNABORTED' || candidate?.code === 'ETIMEDOUT' || candidate?.name === 'TimeoutError';
}

export default DirectHttpProvider;
