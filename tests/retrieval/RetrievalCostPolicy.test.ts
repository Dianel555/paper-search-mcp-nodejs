import { describe, expect, it } from '@jest/globals';
import { parseRetrievalCredits, RetrievalCostPolicy } from '../../src/retrieval/RetrievalCostPolicy.js';

describe('RetrievalCostPolicy', () => {
  it('uses the finite host pricing snapshot with label-aware matching', () => {
    const policy = new RetrievalCostPolicy({ budget: 50, maxCreditsPerRequest: 10, enabled: true });

    expect(policy.estimate('https://scholar.google.com/scholar', 'static')).toEqual({ known: true, credits: 10 });
    expect(policy.estimate('HTTPS://SCHOLAR.GOOGLE.COM./scholar', 'static')).toEqual({ known: true, credits: 10 });
    expect(policy.estimate('https://scholar.google.com/scholar', 'browser')).toEqual({ known: true, credits: 10 });
    expect(policy.estimate('https://google.co.uk/search', 'static')).toEqual({ known: false, reason: 'pricing_unknown' });
    expect(policy.estimate('https://google.com.example.org/search', 'static')).toEqual({ known: false, reason: 'pricing_unknown' });
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
      unknownCostAttempts: 0
    }));
  });

  it('treats unknown cost as consumed and permanently closes paid admission', () => {
    const policy = new RetrievalCostPolicy({ budget: 10, enabled: true });
    const ledger = policy.createLedger();
    const reservation = ledger.admit('https://publisher.example/page', 'static')!;
    reservation.markDispatched();
    ledger.settle(reservation, { known: false, credits: null, reason: 'invalid_billing_header' });

    expect(ledger.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 1,
      reportedCredits: 0,
      reportedCreditsKnown: false,
      unknownCostAttempts: 1,
      paidClosed: true,
      paidClosedReason: 'unknown_cost'
    }));
    expect(ledger.admit('https://publisher.example/next', 'static')).toBeNull();
  });

  it('reconciles a late known cost once without reopening or changing a prior reservation', () => {
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
      paidClosed: true,
      paidClosedReason: 'unknown_cost'
    }));
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
