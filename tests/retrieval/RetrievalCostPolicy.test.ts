import { describe, expect, it } from '@jest/globals';
import { parseRetrievalCredits, RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';

describe('RetrievalCostPolicy', () => {
  it('uses the finite host pricing snapshot with label-aware matching', () => {
    const policy = new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 125, enabled: true });

    expect(policy.estimate('https://scholar.google.com/scholar', 'static')).toEqual({ known: true, credits: 10 });
    expect(policy.estimate('HTTPS://SCHOLAR.GOOGLE.COM./scholar', 'static')).toEqual({ known: true, credits: 10 });
    expect(policy.estimate('https://scholar.google.com/scholar', 'browser')).toEqual({ known: true, credits: 10 });
    expect(policy.estimate('https://scholar.google.com/scholar', 'static', 'residential')).toEqual({ known: true, credits: 25 });
    expect(policy.estimate('https://scholar.google.com/scholar', 'browser', 'residential')).toEqual({ known: true, credits: 125 });
    expect(policy.estimate('https://google.co.uk/search', 'static')).toEqual({ known: false, reason: 'pricing_unknown' });
    expect(policy.estimate('https://google.com.example.org/search', 'static', 'residential')).toEqual({ known: false, reason: 'pricing_unknown' });
    expect(policy.estimate('https://www.googleapis.com/script', 'static')).toEqual({ known: false, reason: 'pricing_unknown' });
    expect(policy.estimate('https://mygoogle.example.org/page', 'static')).toEqual({ known: true, credits: 1 });
  });

  it('charges static and browser strategies independently of General or Extended format', () => {
    const policy = new RetrievalCostPolicy({ enabled: true });

    expect(policy.estimate('https://publisher.example/page', 'static')).toEqual({ known: true, credits: 1 });
    expect(policy.estimate('https://publisher.example/page', 'browser')).toEqual({ known: true, credits: 10 });
  });

  it('denies unknown pricing without turning it into a direct-target restriction', () => {
    const policy = new RetrievalCostPolicy({ budget: 50, enabled: true });
    const ledger = policy.createLedger();

    expect(policy.estimate('https://googleusercontent.com/page', 'static').known).toBe(false);
    expect(ledger.admit('https://googleusercontent.com/page', 'static')).toBeNull();
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      paidClosed: true,
      paidClosedReason: 'pricing_unknown'
    }));
  });

  it('rejects invalid combinations before dispatch without confusing them with target pricing', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, enabled: true });
    const ledger = policy.createLedger();

    expect(policy.estimate('https://publisher.example/page', 'unsupported' as any)).toEqual({
      known: false,
      reason: 'invalid_combination'
    });
    expect(ledger.admit('https://publisher.example/page', 'unsupported' as any)).toBeNull();
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      paidClosed: true,
      paidClosedReason: 'invalid_combination',
      admissionUsed: 0,
      reservedCredits: 0
    }));
  });

  it('does not close a ledger for temporary reservation contention', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const first = ledger.reserve(6);

    expect(first).not.toBeNull();
    expect(ledger.reserve(5)).toBeNull();
    expect(ledger.snapshot().paidClosed).toBe(false);

    first?.release();
    expect(ledger.reserve(5)).not.toBeNull();
  });

  it('closes for persistent insufficiency even when another reservation is outstanding', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    for (let index = 0; index < 9; index++) {
      const reservation = ledger.reserve(1)!;
      expect(reservation.markDispatched()).toBe(true);
      ledger.settle(reservation, { known: true, credits: 1 });
    }
    const outstanding = ledger.reserve(1)!;

    expect(ledger.reserve(10)).toBeNull();
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      paidClosed: true,
      paidClosedReason: 'operation_budget_exceeded',
      reservedCredits: 1
    }));
    outstanding.release();
  });

  it('rechecks headroom synchronously before dispatch after another attempt settles', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const first = ledger.reserve(5)!;
    const second = ledger.reserve(5)!;

    expect(first.markDispatched()).toBe(true);
    ledger.settle(first, { known: true, credits: 9 });
    expect(second.markDispatched()).toBe(false);
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 9,
      reservedCredits: 0,
      paidClosed: true,
      paidClosedReason: 'operation_budget_exceeded'
    }));
  });

  it('rolls back a marked reservation when transport admission fails before submission', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.reserve(4)!;

    expect(reservation.markDispatched()).toBe(true);
    expect(reservation.cancelBeforeTransport?.()).toBe(true);
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 0,
      reservedCredits: 0,
      unknownCostAttempts: 0,
      reportedCreditsKnown: true
    }));
    expect(reservation.cancelBeforeTransport?.()).toBe(false);
    ledger.settle(reservation, { known: false, credits: null });
    expect(ledger.snapshot().unknownCostAttempts).toBe(0);
  });

  it('atomically reserves the last budget unit per operation and isolates ledgers', () => {
    const policy = new RetrievalCostPolicy({ budget: 1, enabled: true });
    const first = policy.createLedger();
    const second = policy.createLedger();

    const reservation = first.admit('https://publisher.example/one', 'static');
    expect(reservation).not.toBeNull();
    expect(first.admit('https://publisher.example/two', 'static')).toBeNull();
    expect(first.snapshot().reservedCredits).toBe(1);
    expect(second.admit('https://publisher.example/other', 'static')).not.toBeNull();

    reservation?.release();
    expect(first.snapshot().reservedCredits).toBe(0);
    expect(reservation?.release()).toBeUndefined();
  });

  it('does not accept a reservation object from another operation ledger', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, enabled: true });
    const first = policy.createLedger();
    const second = policy.createLedger();
    const firstReservation = first.admit('https://publisher.example/first', 'static')!;
    const secondReservation = second.admit('https://publisher.example/second', 'static')!;
    firstReservation.markDispatched();
    secondReservation.markDispatched();

    second.settle(firstReservation, { known: true, credits: 9 });
    second.reconcile(firstReservation, { known: true, credits: 9 });

    expect(first.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 1, reportedCredits: 0 }));
    expect(second.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 1, reportedCredits: 0 }));
    second.settle(secondReservation, { known: true, credits: 1 });
    expect(second.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0, reportedCredits: 1 }));
  });

  it('keeps isolated known-zero and below-estimate actual costs observable without closing', () => {
    const policy = new RetrievalCostPolicy({ budget: 30, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const googleUrl = 'https://scholar.google.com/scholar';

    const zero = ledger.admit(googleUrl, 'static')!;
    expect(zero.markDispatched()).toBe(true);
    ledger.settle(zero, { known: true, credits: 0 });

    const belowEstimate = ledger.admit(googleUrl, 'static')!;
    expect(belowEstimate.estimate).toBe(10);
    expect(belowEstimate.markDispatched()).toBe(true);
    ledger.settle(belowEstimate, { known: true, credits: 3 });

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 20,
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
    expect(ledger.admit(googleUrl, 'static')).not.toBeNull();
  });

  it('settles zero, lower, and higher actual costs conservatively', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const settle = (credits: number) => {
      const reservation = ledger.admit('https://publisher.example/page', 'static')!;
      expect(reservation.markDispatched()).toBe(true);
      ledger.settle(reservation, { known: true, credits });
    };

    settle(0);
    settle(1);
    settle(4);
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 6,
      reservedCredits: 0,
      reportedCredits: 5,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
  });

  it('records unknown cost while continuing within the local admission budget', () => {
    const policy = new RetrievalCostPolicy({ budget: 3, enabled: true });
    const ledger = policy.createLedger();

    for (let index = 0; index < 3; index++) {
      const reservation = ledger.admit(`https://publisher.example/page-${index}`, 'static')!;
      reservation.markDispatched();
      ledger.settle(reservation, { known: false, credits: null, reason: 'invalid_billing_header' });
    }

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 3,
      reportedCredits: 0,
      reportedCreditsKnown: false,
      unknownCostAttempts: 3,
      paidClosed: false
    }));
    expect(ledger.admit('https://publisher.example/over-budget', 'static')).toBeNull();
    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      paidClosed: true,
      paidClosedReason: 'operation_budget_exceeded'
    }));
  });

  it('keeps every invalid post-dispatch billing value unknown while local headroom remains', () => {
    const invalidValues: unknown[] = [
      undefined,
      null,
      '',
      '  ',
      '-1',
      -1,
      '1.5',
      1.5,
      'NaN',
      NaN,
      'Infinity',
      Infinity,
      'not-a-number'
    ];
    const policy = new RetrievalCostPolicy({ budget: invalidValues.length + 1, enabled: true });
    const ledger = policy.createLedger();

    invalidValues.forEach((value, index) => {
      const observation = parseRetrievalCredits(value);
      expect(observation).toEqual(expect.objectContaining({ known: false, credits: null }));
      const reservation = ledger.admit(`https://publisher.example/invalid-${index}`, 'static');
      expect(reservation).not.toBeNull();
      expect(reservation!.markDispatched()).toBe(true);
      ledger.settle(reservation!, observation);
    });

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: invalidValues.length,
      reportedCredits: 0,
      reportedCreditsKnown: false,
      unknownCostAttempts: invalidValues.length,
      paidClosed: false
    }));
    expect(ledger.admit('https://publisher.example/follow-up', 'static')).not.toBeNull();
  });

  it('reconciles a late known cost once without closing a bounded ledger', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.reserve(5)!;
    reservation.markDispatched();
    ledger.settle(reservation, { known: false, credits: null });
    ledger.reconcile(reservation, { known: true, credits: 7 });
    ledger.reconcile(reservation, { known: true, credits: 7 });

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 7,
      reportedCredits: 7,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
    expect(ledger.admit('https://publisher.example/next', 'static')).not.toBeNull();
  });

  it('reconciles a late known cost from an admitted unknown attempt', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.admit('https://publisher.example/page', 'static')!;
    reservation.markDispatched();
    ledger.settle(reservation, { known: false, credits: null });
    ledger.reconcile(reservation, { known: true, credits: 3 });
    ledger.reconcile(reservation, { known: true, credits: 3 });

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 3,
      reportedCredits: 3,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: false
    }));
    expect(ledger.admit('https://publisher.example/next', 'static')).not.toBeNull();
  });

  it('closes on a late actual cost above the per-request limit and reconciles it once', () => {
    const policy = new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 5, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.admit('https://publisher.example/page', 'static')!;
    reservation.markDispatched();
    ledger.settle(reservation, { known: false, credits: null });

    ledger.reconcile(reservation, { known: true, credits: 6 });
    const reconciled = ledger.snapshot();
    expect(reconciled).toEqual(expect.objectContaining({
      admissionUsed: 6,
      reportedCredits: 6,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: true,
      paidClosedReason: 'actual_cost_exceeded'
    }));
    ledger.reconcile(reservation, { known: true, credits: 7 });
    expect(ledger.snapshot()).toEqual(reconciled);
    expect(ledger.admit('https://publisher.example/next', 'static')).toBeNull();
  });

  it('preserves an independent closure reason when late cost exceeds the budget', () => {
    const policy = new RetrievalCostPolicy({ budget: 5, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.admit('https://publisher.example/page', 'static')!;
    reservation.markDispatched();
    ledger.settle(reservation, { known: false, credits: null });
    ledger.close('provider_error');

    ledger.reconcile(reservation, { known: true, credits: 6 });
    const reconciled = ledger.snapshot();
    expect(reconciled).toEqual(expect.objectContaining({
      admissionUsed: 6,
      reportedCredits: 6,
      reportedCreditsKnown: true,
      unknownCostAttempts: 0,
      paidClosed: true,
      paidClosedReason: 'provider_error'
    }));
    ledger.reconcile(reservation, { known: true, credits: 6 });
    expect(ledger.snapshot()).toEqual(reconciled);
    expect(ledger.admit('https://publisher.example/next', 'static')).toBeNull();
  });

  it('classifies only non-negative safe integer billing values as known', () => {
    expect(parseRetrievalCredits('0')).toEqual({ known: true, credits: 0 });
    for (const value of [undefined, '', '  ', '-1', '1.5', 'NaN', 'Infinity', 'not-a-number', '9007199254740992']) {
      expect(parseRetrievalCredits(value)).toEqual(expect.objectContaining({ known: false, credits: null }));
    }
  });

  it('keeps a high actual cost visible and closes future admission', () => {
    const policy = new RetrievalCostPolicy({ budget: 5, maxCreditsPerRequest: 10, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.admit('https://publisher.example/page', 'static')!;
    reservation.markDispatched();
    ledger.settle(reservation, { known: true, credits: 6 });

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 6,
      reportedCredits: 6,
      paidClosed: true,
      paidClosedReason: 'actual_cost_exceeded'
    }));
    expect(ledger.admit('https://publisher.example/next', 'static')).toBeNull();
  });
});
