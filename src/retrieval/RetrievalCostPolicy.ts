import {
  normalizeRetrievalCombination,
  type RetrievalCombination,
  type RetrievalCostController,
  type RetrievalCostObservation,
  type RetrievalCostReservation,
  type RetrievalCostSnapshot,
  type RetrievalProxyType,
  type RetrievalStrategy
} from './types.js';

export type RetrievalPriceEstimate =
  | { readonly known: true; readonly credits: number }
  | { readonly known: false; readonly reason: 'pricing_unknown' | 'invalid_url' | 'invalid_combination' };

export function parseRetrievalCredits(value: unknown): RetrievalCostObservation {
  const text = value === undefined || value === null ? '' : String(value);
  if (!/^\s*\d+\s*$/.test(text)) {
    return { known: false, credits: null, reason: text ? 'invalid_billing_header' : 'missing_billing_header' };
  }
  const credits = Number(text.trim());
  if (!Number.isSafeInteger(credits) || credits < 0) {
    return { known: false, credits: null, reason: 'invalid_billing_header' };
  }
  return { known: true, credits };
}

export interface RetrievalCostPolicyOptions {
  budget?: number;
  maxCreditsPerRequest?: number;
  enabled?: boolean;
}

const GOOGLE_ROOT = 'google.com';
const UNKNOWN_PRICING_ROOTS = [
  'googleapis.com',
  'googleusercontent.com',
  'gstatic.com',
  'youtube.com',
  'youtu.be'
] as const;

/**
 * Finite, conservative local pricing snapshot. It is not an access allowlist
 * and never replaces outbound target validation.
 */
export class RetrievalCostPolicy {
  readonly budget: number;
  readonly maxCreditsPerRequest: number;
  readonly enabled: boolean;

  constructor(options: RetrievalCostPolicyOptions = {}) {
    this.budget = isPositiveSafeInteger(options.budget) ? options.budget : 50;
    this.maxCreditsPerRequest = isPositiveSafeInteger(options.maxCreditsPerRequest) ? options.maxCreditsPerRequest : 10;
    this.enabled = options.enabled !== false &&
      isPositiveSafeInteger(options.budget ?? this.budget) &&
      isPositiveSafeInteger(options.maxCreditsPerRequest ?? this.maxCreditsPerRequest);
  }

  estimate(url: string, strategy: RetrievalStrategy, proxyType?: RetrievalProxyType): RetrievalPriceEstimate;
  estimate(url: string, combination: Pick<RetrievalCombination, 'strategy' | 'proxyType'>): RetrievalPriceEstimate;
  estimate(
    url: string,
    strategyOrCombination: RetrievalStrategy | Pick<RetrievalCombination, 'strategy' | 'proxyType'>,
    proxyType: RetrievalProxyType = 'datacenter'
  ): RetrievalPriceEstimate {
    const combination = typeof strategyOrCombination === 'string'
      ? normalizeRetrievalCombination(strategyOrCombination, proxyType)
      : normalizeRetrievalCombination(strategyOrCombination.strategy, strategyOrCombination.proxyType);
    if (!combination) return { known: false, reason: 'invalid_combination' };

    const hostname = normalizeHostname(url);
    if (!hostname) return { known: false, reason: 'invalid_url' };
    if (combination.strategy === 'direct') return { known: true, credits: 0 };

    const googleClass = classifyGoogleHost(hostname);
    if (googleClass === 'unknown') return { known: false, reason: 'pricing_unknown' };
    if (googleClass === 'known' && combination.proxyType === 'datacenter') {
      return { known: true, credits: 10 };
    }
    if (combination.proxyType === 'residential') {
      return { known: true, credits: combination.strategy === 'browser' ? 125 : 25 };
    }
    return { known: true, credits: combination.strategy === 'browser' ? 10 : 1 };
  }

  createLedger(options: Partial<LedgerOptions> = {}): RetrievalCostLedger {
    return new RetrievalCostLedger({
      budget: options.budget ?? this.budget,
      maxCreditsPerRequest: options.maxCreditsPerRequest ?? this.maxCreditsPerRequest,
      enabled: options.enabled ?? this.enabled
    });
  }
}

interface LedgerOptions {
  budget: number;
  maxCreditsPerRequest: number;
  enabled: boolean;
}

interface ReservationState {
  readonly id: string;
  readonly estimate: number;
  dispatched: boolean;
  released: boolean;
  settled: boolean;
  unknownCost: boolean;
  reconciled: boolean;
  pendingReconciliation?: RetrievalCostObservation;
}

/** Atomic per-top-level-operation admission ledger. */
export class RetrievalCostLedger implements RetrievalCostController {
  readonly budget: number;
  private readonly maxCreditsPerRequest: number;
  private readonly enabled: boolean;
  private admissionUsed = 0;
  private reservedCredits = 0;
  private reportedCredits = 0;
  private reportedCreditsKnown = true;
  private unknownCostAttempts = 0;
  private paidClosed: boolean;
  private paidClosedReason?: string;
  private sequence = 0;
  private readonly reservationObjects = new WeakMap<object, ReservationState>();

  constructor(options: LedgerOptions) {
    this.budget = options.budget;
    this.maxCreditsPerRequest = options.maxCreditsPerRequest;
    this.enabled = options.enabled;
    this.paidClosed = !options.enabled;
    if (!options.enabled) this.paidClosedReason = 'not_authorized';
  }

  /** Admit a priced strategy, closing the operation when pricing is unknown. */
  admit(url: string, strategy: RetrievalStrategy, policy?: RetrievalCostPolicy): RetrievalCostReservation | null;
  admit(url: string, strategy: RetrievalStrategy, proxyType: RetrievalProxyType, policy?: RetrievalCostPolicy): RetrievalCostReservation | null;
  admit(url: string, combination: Pick<RetrievalCombination, 'strategy' | 'proxyType'>, policy?: RetrievalCostPolicy): RetrievalCostReservation | null;
  admit(
    url: string,
    strategyOrCombination: RetrievalStrategy | Pick<RetrievalCombination, 'strategy' | 'proxyType'>,
    proxyTypeOrPolicy?: RetrievalProxyType | RetrievalCostPolicy,
    policy?: RetrievalCostPolicy
  ): RetrievalCostReservation | null {
    const proxyType = typeof proxyTypeOrPolicy === 'string' ? proxyTypeOrPolicy : 'datacenter';
    const pricingPolicy = isCostPolicy(proxyTypeOrPolicy)
      ? proxyTypeOrPolicy
      : policy || new RetrievalCostPolicy({
        budget: this.budget,
        maxCreditsPerRequest: this.maxCreditsPerRequest,
        enabled: this.enabled
      });
    const estimate = typeof strategyOrCombination === 'string'
      ? pricingPolicy.estimate(url, strategyOrCombination, proxyType)
      : pricingPolicy.estimate(url, strategyOrCombination);
    if (!estimate.known) {
      this.close(estimate.reason);
      return null;
    }
    return this.reserve(estimate.credits);
  }

  reserve(estimate: number): RetrievalCostReservation | null {
    if (!this.enabled || this.paidClosed) return null;
    if (!isPositiveSafeInteger(estimate)) {
      this.close('invalid_estimate');
      return null;
    }
    if (estimate > this.maxCreditsPerRequest) {
      this.close('request_cost_limit');
      return null;
    }
    if (this.admissionUsed + estimate > this.budget) {
      // This request cannot fit even if every other outstanding reservation is
      // released. That is persistent exhaustion and closes paid admission.
      this.close('operation_budget_exceeded');
      return null;
    }
    if (this.admissionUsed + this.reservedCredits + estimate > this.budget) {
      // Another outstanding reservation temporarily consumes the remaining
      // capacity. Reject only this contender; already admitted work remains
      // eligible for its own submit-time recheck.
      return null;
    }

    const state: ReservationState = {
      id: `retrieval-attempt-${++this.sequence}`,
      estimate,
      dispatched: false,
      released: false,
      settled: false,
      unknownCost: false,
      reconciled: false
    };
    const reservation: RetrievalCostReservation = {
      attemptId: state.id,
      estimate: state.estimate,
      markDispatched: () => {
        if (state.released || state.settled) return false;
        if (state.dispatched) return true;
        if (this.paidClosed) {
          this.release(state);
          return false;
        }
        // Settlement of another attempt can consume headroom while this
        // reservation is queued. This check is deliberately synchronous with
        // the dispatch marker and therefore cannot be bypassed by an await.
        if (this.admissionUsed + this.reservedCredits > this.budget) {
          this.release(state);
          if (this.admissionUsed + state.estimate > this.budget) {
            this.close('operation_budget_exceeded');
          }
          return false;
        }
        state.dispatched = true;
        return true;
      },
      cancelBeforeTransport: () => {
        if (state.released || state.settled || !state.dispatched) return false;
        state.dispatched = false;
        this.release(state);
        return true;
      },
      release: () => this.release(state)
    };
    this.reservationObjects.set(reservation, state);
    this.reservedCredits += estimate;
    return reservation;
  }

  settle(reservation: RetrievalCostReservation, observation: RetrievalCostObservation): void {
    const state = this.reservationState(reservation);
    if (!state || state.released || state.settled || !state.dispatched) return;
    state.settled = true;
    this.reservedCredits = Math.max(0, this.reservedCredits - state.estimate);
    const normalized = normalizeObservation(observation);
    if (normalized.known) {
      this.reportedCredits += normalized.credits;
      this.admissionUsed += Math.max(state.estimate, normalized.credits);
      if (normalized.credits > this.maxCreditsPerRequest || this.admissionUsed > this.budget) {
        this.close('actual_cost_exceeded');
      }
      state.pendingReconciliation = undefined;
    } else {
      state.unknownCost = true;
      // Unknown provider billing consumes the local estimate and remains
      // visible, but it is not itself a reason to stop an otherwise bounded
      // retry/fallback chain. Budget and request-limit admission still apply.
      this.admissionUsed += state.estimate;
      this.unknownCostAttempts++;
      this.reportedCreditsKnown = false;
      const pending = state.pendingReconciliation;
      state.pendingReconciliation = undefined;
      if (pending) this.reconcile(reservation, pending);
    }
  }

  /** Reconcile one previously unknown, already-dispatched attempt exactly once. */
  reconcile(reservation: RetrievalCostReservation, observation: RetrievalCostObservation): void {
    const state = this.reservationState(reservation);
    if (!state || state.released || state.reconciled) return;
    const normalized = normalizeObservation(observation);
    if (!state.settled) {
      if (state.dispatched && normalized.known) state.pendingReconciliation = normalized;
      return;
    }
    if (!state.unknownCost || !normalized.known) return;
    state.reconciled = true;
    this.reportedCredits += normalized.credits;
    this.unknownCostAttempts = Math.max(0, this.unknownCostAttempts - 1);
    this.reportedCreditsKnown = this.unknownCostAttempts === 0;
    this.admissionUsed += Math.max(0, Math.max(state.estimate, normalized.credits) - state.estimate);
    if (normalized.credits > this.maxCreditsPerRequest || this.admissionUsed > this.budget) {
      this.close('actual_cost_exceeded');
    }
  }

  close(reason: string): void {
    if (this.paidClosed) return;
    this.paidClosed = true;
    this.paidClosedReason = reason;
  }

  snapshot(): RetrievalCostSnapshot {
    return {
      budget: this.budget,
      admissionUsed: this.admissionUsed,
      reservedCredits: this.reservedCredits,
      reportedCredits: this.reportedCredits,
      reportedCreditsKnown: this.reportedCreditsKnown,
      unknownCostAttempts: this.unknownCostAttempts,
      paidClosed: this.paidClosed,
      paidClosedReason: this.paidClosedReason
    };
  }

  private reservationState(reservation: RetrievalCostReservation): ReservationState | undefined {
    return reservation && typeof reservation === 'object'
      ? this.reservationObjects.get(reservation)
      : undefined;
  }

  private release(state: ReservationState): void {
    if (state.released || state.settled) return;
    if (!state.dispatched) {
      state.released = true;
      this.reservedCredits = Math.max(0, this.reservedCredits - state.estimate);
    }
  }
}

function normalizeObservation(observation: RetrievalCostObservation): RetrievalCostObservation {
  if (observation?.known === true && isNonNegativeSafeInteger(observation.credits)) {
    return { known: true, credits: observation.credits };
  }
  return {
    known: false,
    credits: null,
    reason: observation?.known === false ? observation.reason : 'invalid_billing_value'
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeHostname(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname.split('.').some(label => label.length === 0)) return undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

function classifyGoogleHost(hostname: string): 'known' | 'unknown' | 'other' {
  if (isRootOrSubdomain(hostname, GOOGLE_ROOT)) return 'known';
  if (UNKNOWN_PRICING_ROOTS.some(root => isRootOrSubdomain(hostname, root))) return 'unknown';
  if (hostname.split('.').some(label => label === 'google')) return 'unknown';
  return 'other';
}

function isRootOrSubdomain(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCostPolicy(value: unknown): value is RetrievalCostPolicy {
  return value instanceof RetrievalCostPolicy;
}

export default RetrievalCostPolicy;
