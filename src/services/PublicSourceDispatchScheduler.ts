export const DEFAULT_SOURCE_COOLDOWN_MS = 3_000;

export interface SourceDispatchSchedulerOptions {
  readonly now?: () => number;
  /** Injectable wait used by deterministic offline harnesses; production defaults to setTimeout. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type SourceDispatchLease = (() => void) & {
  /** Record the actual transport start after any external queue wait. */
  markStarted(deadlineAt?: number): void;
};

export interface SourceCooldownObservation {
  readonly cooldownUntil?: number;
  readonly blocked?: boolean;
}

interface SourceState {
  lastStart?: number;
  cooldownUntil: number;
  blocked: boolean;
  inFlight: boolean;
  readonly wakeWaiters: Set<() => void>;
}

/**
 * Process-local source scheduler. It reserves a source lease immediately
 * before transport preparation. Deferred leases mark the actual transport
 * start after any external queue wait, so queued cancellation cannot consume
 * a submission and concurrent waiters cannot share one start timestamp.
 */
export class PublicSourceDispatchScheduler {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly sources = new Map<string, SourceState>();

  constructor(options: SourceDispatchSchedulerOptions = {}) {
    this.now = options.now || Date.now;
    this.sleep = options.sleep || delayUntil;
  }

  /**
   * Acquire the one in-flight source slot immediately before submission.
   * Deferred callers must invoke lease.markStarted immediately before the
   * actual transport call, then release it after the response is received or
   * discarded. The older wait() helper remains a zero-duration compatibility
   * probe for callers that do not own a transport lease.
   */
  async acquire(
    origin: string,
    signal?: AbortSignal,
    deadlineAt?: number,
    minimumIntervalMs = 0,
    options: { readonly deferStart?: boolean } = {}
  ): Promise<SourceDispatchLease> {
    const state = this.state(origin);
    while (true) {
      throwIfAborted(signal);
      if (state.blocked) throw new SourceDispatchBlockedError();
      const now = this.now();
      if (state.inFlight) {
        await waitForSourceChange(state, signal, deadlineAt, this.now);
        continue;
      }
      const earliest = Math.max(
        state.cooldownUntil,
        (state.lastStart === undefined ? 0 : state.lastStart + Math.max(0, minimumIntervalMs))
      );
      if (earliest <= now) {
        if (deadlineAt !== undefined && now >= deadlineAt) throw new SourceDispatchDeadlineError();
        const deferStart = options.deferStart === true;
        const previousLastStart = state.lastStart;
        state.lastStart = now;
        state.inFlight = true;
        let released = false;
        let started = !deferStart;
        const lease = (() => {
          if (released) return;
          released = true;
          if (deferStart && !started) state.lastStart = previousLastStart;
          state.inFlight = false;
          this.notify(state);
        }) as SourceDispatchLease;
        lease.markStarted = (deadlineAt?: number) => {
          if (released || started) return;
          const startedAt = this.now();
          if (state.blocked) throw new SourceDispatchBlockedError();
          const currentEarliest = Math.max(
            state.cooldownUntil,
            (previousLastStart === undefined ? 0 : previousLastStart + Math.max(0, minimumIntervalMs))
          );
          if (currentEarliest > startedAt) {
            if (deadlineAt !== undefined && currentEarliest >= deadlineAt) throw new SourceDispatchDeadlineError();
            throw new SourceCooldownError('The public source cooldown changed before transport start');
          }
          if (deadlineAt !== undefined && startedAt >= deadlineAt) throw new SourceDispatchDeadlineError();
          started = true;
          state.lastStart = startedAt;
        };
        return lease;
      }
      if (deadlineAt !== undefined && earliest >= deadlineAt) throw new SourceDispatchDeadlineError();
      await this.sleep(earliest - now, signal);
    }
  }

  async wait(
    origin: string,
    signal?: AbortSignal,
    deadlineAt?: number,
    minimumIntervalMs = 0
  ): Promise<void> {
    const release = await this.acquire(origin, signal, deadlineAt, minimumIntervalMs);
    release();
  }

  observeRetryAfter(
    origin: string,
    status: number | undefined,
    headers: unknown
  ): SourceCooldownObservation {
    if (status !== 429) return {};
    const state = this.state(origin);
    const now = this.now();
    const retryAfter = getRetryAfter(headers, now);
    if (retryAfter.kind === 'blocked') {
      state.blocked = true;
      state.cooldownUntil = Number.MAX_SAFE_INTEGER;
      this.notify(state);
      return { blocked: true };
    }
    const cooldownUntil = now + (retryAfter.kind === 'delay' ? retryAfter.ms : DEFAULT_SOURCE_COOLDOWN_MS);
    if (!Number.isSafeInteger(cooldownUntil) || cooldownUntil < now) {
      state.blocked = true;
      state.cooldownUntil = Number.MAX_SAFE_INTEGER;
      return { blocked: true };
    }
    state.cooldownUntil = Math.max(state.cooldownUntil, cooldownUntil);
    return { cooldownUntil: state.cooldownUntil };
  }

  getState(origin: string): SourceCooldownObservation & { readonly lastStart?: number } {
    const state = this.state(origin);
    return {
      ...(state.cooldownUntil > this.now() ? { cooldownUntil: state.cooldownUntil } : {}),
      ...(state.blocked ? { blocked: true } : {}),
      ...(state.lastStart === undefined ? {} : { lastStart: state.lastStart })
    };
  }

  reset(): void {
    for (const state of this.sources.values()) this.notify(state);
    this.sources.clear();
  }

  private notify(state: SourceState): void {
    const waiters = [...state.wakeWaiters];
    state.wakeWaiters.clear();
    for (const wake of waiters) wake();
  }

  private state(origin: string): SourceState {
    const key = origin || 'unknown';
    let state = this.sources.get(key);
    if (!state) {
      state = { cooldownUntil: 0, blocked: false, inFlight: false, wakeWaiters: new Set() };
      this.sources.set(key, state);
    }
    return state;
  }
}

export class SourceCooldownError extends Error {
  constructor(message = 'The public source is cooling down') {
    super(message);
    this.name = 'SourceCooldownError';
  }
}

export class SourceDispatchBlockedError extends SourceCooldownError {
  constructor() {
    super('The public source is blocked until process restart');
    this.name = 'SourceDispatchBlockedError';
  }
}

export class SourceDispatchDeadlineError extends SourceCooldownError {
  constructor() {
    super('The public source cooldown exceeds the operation deadline');
    this.name = 'SourceDispatchDeadlineError';
  }
}

export const globalPublicSourceDispatchScheduler = new PublicSourceDispatchScheduler();

function getRetryAfter(headers: unknown, now: number):
  | { readonly kind: 'default' }
  | { readonly kind: 'delay'; readonly ms: number }
  | { readonly kind: 'blocked' } {
  const raw = getHeader(headers, 'retry-after');
  if (!raw) return { kind: 'default' };
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) return { kind: 'blocked' };
    return { kind: 'delay', ms: seconds * 1000 };
  }
  // Only IMF-fixdate is accepted. Date.parse's broader grammar would turn
  // malformed provider text into an accidental long or zero cooldown.
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return { kind: 'default' };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { kind: 'default' };
  if (timestamp <= now) return { kind: 'delay', ms: 0 };
  if (!Number.isSafeInteger(timestamp)) return { kind: 'blocked' };
  return { kind: 'delay', ms: timestamp - now };
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const entry = Object.entries(headers as Record<string, unknown>)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(entry)) return typeof entry[0] === 'string' ? entry[0] : undefined;
  return typeof entry === 'string' || typeof entry === 'number' ? String(entry) : undefined;
}

async function waitForSourceChange(
  state: SourceState,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  now: () => number
): Promise<void> {
  throwIfAborted(signal);
  if (deadlineAt !== undefined && now() >= deadlineAt) throw new SourceDispatchDeadlineError();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      state.wakeWaiters.delete(wake);
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const wake = () => finish(resolve);
    const onAbort = () => finish(() => reject(createAbortError()));
    state.wakeWaiters.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineAt !== undefined) {
      const remaining = Math.max(0, deadlineAt - now());
      timer = setTimeout(() => finish(() => reject(new SourceDispatchDeadlineError())), remaining);
    }
    if (signal?.aborted) onAbort();
  });
}

async function delayUntil(milliseconds: number, signal?: AbortSignal): Promise<void> {
  let remaining = milliseconds;
  while (remaining > 0) {
    throwIfAborted(signal);
    const chunk = Math.min(remaining, 2_147_000_000);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, chunk);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(createAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    remaining -= chunk;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

export default PublicSourceDispatchScheduler;
