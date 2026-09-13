export type ConcurrencyLimit = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

interface QueueEntry {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  started: boolean;
  settled: boolean;
  onAbort?: () => void;
}

/** Small dependency-free promise limiter used by network services and health checks. */
export function createConcurrencyLimiter(concurrency: number): ConcurrencyLimit {
  const max = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  let active = 0;
  const queue: QueueEntry[] = [];

  const drain = () => {
    while (active < max && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.settled) continue;

      entry.started = true;
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      active++;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  };

  return <T>(task: () => Promise<T>, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
    const entry: QueueEntry = {
      task,
      resolve: resolve as (value: unknown) => void,
      reject,
      signal,
      started: false,
      settled: false
    };

    const rejectIfAborted = () => {
      if (entry.started || entry.settled) return;
      entry.settled = true;
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      reject(createAbortError());
      drain();
    };

    entry.onAbort = rejectIfAborted;
    if (signal?.aborted) {
      rejectIfAborted();
      return;
    }
    signal?.addEventListener('abort', rejectIfAborted, { once: true });
    queue.push(entry);
    drain();
  });
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export default createConcurrencyLimiter;
