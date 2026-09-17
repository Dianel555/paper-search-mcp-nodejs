import type { RetrievalFailureKind, RetrievalOperationContext } from './types.js';

/** Internal AbortSignal reason used only for a bounded discovery/PDF scope. */
export const RETRIEVAL_SCOPE_DEADLINE_REASON = 'retrieval_scope_deadline';
export const RETRIEVAL_OPERATION_DEADLINE_REASON = 'retrieval_operation_deadline';

export function abortForRetrievalScope(controller: AbortController): void {
  controller.abort(RETRIEVAL_SCOPE_DEADLINE_REASON);
}

export function abortForRetrievalOperation(controller: AbortController): void {
  controller.abort(RETRIEVAL_OPERATION_DEADLINE_REASON);
}

export function retrievalFailureKindForAbort(
  signal: AbortSignal,
  context: RetrievalOperationContext,
  operationTimedOut = false
): RetrievalFailureKind {
  if (signal.reason === RETRIEVAL_SCOPE_DEADLINE_REASON) return 'scope_deadline';
  if (signal.reason === RETRIEVAL_OPERATION_DEADLINE_REASON
    || operationTimedOut
    || context.remainingMs() <= 0) return 'operation_deadline';
  return 'cancelled';
}

export function relayAbortReason(target: AbortController, source: AbortSignal): void {
  target.abort(source.reason);
}
