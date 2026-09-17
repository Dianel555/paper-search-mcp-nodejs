let dispatchSequence = 0;

/**
 * Generate a bounded, process-local identifier for one actual transport
 * submission. It contains no URL, provider data, or credentials.
 */
export function createRetrievalDispatchId(): string {
  dispatchSequence = dispatchSequence >= Number.MAX_SAFE_INTEGER - 1 ? 1 : dispatchSequence + 1;
  return `dispatch-${dispatchSequence}`;
}
