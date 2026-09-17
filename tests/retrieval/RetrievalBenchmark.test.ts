import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import corpus from '../fixtures/retrieval-benchmark/corpus.json';
import {
  acquireBenchmarkRunId,
  BenchmarkAdmissionError,
  BenchmarkOperationAdmission,
  BenchmarkRunAdmission,
  type RunReservation,
  buildBenchmarkPlan,
  calculateClassMetrics,
  determineBenchmarkStatus,
  createBenchmarkReport,
  createBenchmarkReportBundle,
  createOfflineCellExecutor,
  createTransportBackedCellExecutor,
  OfflineBenchmarkTransport,
  hashCorpus,
  nearestRank,
  runBenchmark,
  validateBenchmarkCorpus,
  validateBenchmarkReport,
  acquireBenchmarkRunFileLock,
  benchmarkFilesystemStem
} from '../../src/retrieval/benchmark/index.js';
import type { BenchmarkCellResult } from '../../src/retrieval/benchmark/types.js';
import type { BenchmarkTransportDispatchStarter, BenchmarkTransportRequest } from '../../src/retrieval/benchmark/transport.js';

const validation = validateBenchmarkCorpus(corpus);

function execution(overrides: Partial<BenchmarkCellResult> = {}): BenchmarkCellResult {
  return {
    cellId: 'production:publisher:r0:pub-01:production',
    sampleId: 'pub-01',
    sampleKind: 'publisher',
    round: 0,
    mode: 'production',
    combination: 'production',
    production: { verifyPdf: true },
    outcome: 'success',
    stage: 'pdf',
    reason: 'none',
    apiStatus: 200,
    targetStatus: 200,
    httpDispatchCount: 1,
    serviceAttemptCount: 1,
    elapsedMs: 10,
    admissionUsed: 1,
    reportedCredits: 1,
    costKnown: true,
    match: 'matched',
    pdfVerification: 'verified',
    localSessionState: 'not_applicable',
    ...overrides
  };
}

describe('retrieval benchmark core', () => {
  it('validates the frozen 20 DOI and 10 query corpus without network access', () => {
    expect(validation.corpus.publisher).toHaveLength(20);
    expect(validation.corpus.scholar).toHaveLength(10);
    expect(validation.publisherHosts.length).toBeGreaterThanOrEqual(5);
    expect(validation.corpusVersion).toBe('03f9f62fe6df7ed3d5a32c2d18dda88e8d0e0982c0f9ab47cc4719157864d883');
    expect(hashCorpus(validation.corpus)).toBe(validation.corpusVersion);
  });

  it.each([
    ['duplicate sample IDs', { ...corpus, scholar: [{ ...corpus.scholar[0], sampleId: corpus.publisher[0].sampleId }, ...corpus.scholar.slice(1)] }],
    ['placeholder DOI', { ...corpus, publisher: [{ ...corpus.publisher[0], doi: '10.1000/test' }, ...corpus.publisher.slice(1)] }],
    ['invalid evidence URL', { ...corpus, publisher: [{ ...corpus.publisher[0], evidenceUrl: 'https://example.com/paper' }, ...corpus.publisher.slice(1)] }],
    ['conflicting expected DOI', { ...corpus, publisher: [{ ...corpus.publisher[0], expectedDoi: '10.9999/other' }, ...corpus.publisher.slice(1)] }],
    ['conflicting candidate DOI', { ...corpus, publisher: [{ ...corpus.publisher[0], candidateUrls: ['https://journals.plos.org/plosone/article/file/10.9999/other.pdf'] }, ...corpus.publisher.slice(1)] }]
  ])('rejects %s', (_name, invalid) => {
    expect(() => validateBenchmarkCorpus(invalid)).toThrow();
  });

  it('builds the fixed 360-cell sequence and left rotation', () => {
    const plan = buildBenchmarkPlan(validation);
    expect(plan.cells).toHaveLength(360);
    expect(plan.cells.slice(0, 20).every(cell => cell.mode === 'production' && cell.sampleKind === 'publisher' && cell.round === 0)).toBe(true);
    expect(plan.cells[40].mode).toBe('production');
    expect(plan.cells[60].combination).toBe('direct');
    expect(plan.cells[65].combination).toBe('static:datacenter');
    expect(plan.cells[360 - 1].mode).toBe('comparison');
    const roundOne = plan.cells.filter(cell => cell.mode === 'comparison' && cell.sampleId === 'pub-01' && cell.round === 1);
    expect(roundOne.map(cell => cell.combination)).toEqual([
      'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential', 'direct'
    ]);
  });

  it('does not accept passing metrics after a run-level safety stop', () => {
    const passingMetrics = {
      publisher: { passed: true },
      scholar: { passed: true }
    } as any;
    expect(determineBenchmarkStatus('live', passingMetrics, [], true, true, true)).toBe('incomplete');
    expect(determineBenchmarkStatus('live', passingMetrics, [], true, true, false)).toBe('live_passed');
  });

  it('does not classify unknown billing as incomplete coverage', () => {
    const passingMetrics = {
      publisher: { passed: true },
      scholar: { passed: true }
    } as any;
    const coveredCell = { outcome: 'success' } as any;

    expect(determineBenchmarkStatus('live', passingMetrics, [coveredCell], true, false, false)).toBe('failed');
  });

  it('computes nearest-rank P95 and includes failed production cost', () => {
    expect(nearestRank([90_000, 1, 2, 3, 4], 0.95)).toBe(90_000);
    const cells = Array.from({ length: 40 }, (_value, index) => execution({
      cellId: `production:publisher:r${index < 20 ? 0 : 1}:pub-${String((index % 20) + 1).padStart(2, '0')}:production`,
      sampleId: `pub-${String((index % 20) + 1).padStart(2, '0')}`,
      round: index < 20 ? 0 : 1,
      outcome: index % 20 < 16 ? 'success' : 'failed',
      match: index % 20 < 16 ? 'matched' : 'not_evaluated',
      pdfVerification: index % 20 < 16 ? 'verified' : 'not_run',
      reportedCredits: 2,
      elapsedMs: index < 32 ? 1_000 : 2_000
    }));
    const metrics = calculateClassMetrics(cells, 'publisher');
    expect(metrics.planned).toBe(40);
    expect(metrics.successes).toBe(32);
    expect(metrics.reportedCredits).toBe(80);
    expect(metrics.averageCreditsPerSuccess).toBe(2.5);
    expect(metrics.passed).toBe(true);
    expect(calculateClassMetrics([
      ...cells,
      ...Array.from({ length: 40 }, (_value, index) => execution({
        cellId: `extra:${index}`,
        outcome: 'success',
        match: 'mismatched',
        pdfVerification: 'verified'
      }))
    ], 'publisher').successes).toBe(32);
  });

  it('keeps temporary reservation contention distinct from persistent exhaustion', () => {
    const operation = new BenchmarkOperationAdmission({ budget: 10, maxCreditsPerRequest: 5 });
    const first = operation.reserve(5);
    const second = operation.reserve(5);
    expect(() => operation.reserve(1)).toThrow();
    expect(operation.snapshot().paidClosed).toBe(false);
    first.release();
    second.release();
    const run = new BenchmarkRunAdmission({ runId: 'admission-test', mode: 'offline', startedAt: 0, now: () => 1, limits: { credits: 10, httpDispatches: 10, elapsedMs: 100 } });
    const runOperation = run.createOperation({ budget: 10, maxCreditsPerRequest: 10 });
    const reservation = run.reservePaid(runOperation, 5);
    reservation.markDispatched();
    reservation.settle(9);
    expect(run.snapshot().admissionUsed).toBe(9);
    expect(run.snapshot().paidClosed).toBe(false);
    expect(() => run.reservePaid(runOperation, 5)).toThrow(BenchmarkAdmissionError);
  });

  it('records unknown cost while continuing, but closes on a known request-limit violation', () => {
    const unknownRun = new BenchmarkRunAdmission({ runId: 'unknown-cost-test', mode: 'live', startedAt: 0, now: () => 1, limits: { credits: 10, httpDispatches: 10, elapsedMs: 100 } });
    const unknownOperation = unknownRun.createOperation({ budget: 10, maxCreditsPerRequest: 5 });
    const unknown = unknownRun.reservePaid(unknownOperation, 5);
    unknown.markDispatched();
    unknown.settle(null);
    expect(unknownRun.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 5,
      reportedCredits: 0,
      reportedCostKnown: false,
      unknownCostAttempts: 1,
      paidClosed: false
    }));
    const followup = unknownRun.reservePaid(unknownOperation, 5);
    expect(followup).toBeDefined();
    followup.release();

    const run = new BenchmarkRunAdmission({ runId: 'late-settlement-limit', mode: 'live', startedAt: 0, now: () => 1, limits: { credits: 10, httpDispatches: 10, elapsedMs: 100 } });
    const operation = run.createOperation({ budget: 10, maxCreditsPerRequest: 5 });
    const reservation = run.reservePaid(operation, 5);
    reservation.markDispatched();
    reservation.settle(null);
    reservation.settle(7);
    reservation.settle(7);
    expect(run.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 7,
      reportedCredits: 7,
      reportedCostKnown: true,
      unknownCostAttempts: 0,
      paidClosed: true,
      paidClosedReason: 'request_cost_limit'
    }));
    expect(() => run.reservePaid(operation, 1)).toThrow();

    const requestLimited = new BenchmarkRunAdmission({ runId: 'late-request-limit', mode: 'live', startedAt: 0, now: () => 1, limits: { credits: 20, httpDispatches: 10, elapsedMs: 100 } });
    const limitedOperation = requestLimited.createOperation({ budget: 20, maxCreditsPerRequest: 5 });
    const late = requestLimited.reservePaid(limitedOperation, 5);
    late.markDispatched();
    late.settle(null);
    late.settle(6);
    expect(limitedOperation.snapshot().paidClosedReason).toBe('request_cost_limit');

    const knownLimitedRun = new BenchmarkRunAdmission({ runId: 'known-request-limit', mode: 'live', startedAt: 0, now: () => 1, limits: { credits: 20, httpDispatches: 10, elapsedMs: 100 } });
    const knownLimitedOperation = knownLimitedRun.createOperation({ budget: 20, maxCreditsPerRequest: 5 });
    const knownLimited = knownLimitedRun.reservePaid(knownLimitedOperation, 5);
    knownLimited.markDispatched();
    knownLimited.settle(6);
    expect(knownLimitedOperation.snapshot().paidClosedReason).toBe('request_cost_limit');
  });

  it('rejects attempts to raise fixed run safety ceilings', () => {
    expect(() => new BenchmarkRunAdmission({ runId: 'too-many-credits', mode: 'live', limits: { credits: 15_001 } })).toThrow(/ceiling/i);
    expect(() => new BenchmarkRunAdmission({ runId: 'too-many-http', mode: 'live', limits: { httpDispatches: 1_501 } })).toThrow(/ceiling/i);
    expect(() => new BenchmarkRunAdmission({ runId: 'too-long', mode: 'live', limits: { elapsedMs: 7_200_001 } })).toThrow(/ceiling/i);
    const run = new BenchmarkRunAdmission({ runId: 'too-large-operation', mode: 'live' });
    expect(() => run.createOperation({ budget: 501 })).toThrow(/ceiling/i);
    expect(() => run.createOperation({ budget: 125, maxCreditsPerRequest: 126 })).toThrow(/ceiling/i);
  });

  it('rolls back every pre-dispatch failure and rejects duplicate dispatch', () => {
    const run = new BenchmarkRunAdmission({ runId: 'pre-dispatch-rollback', mode: 'live', startedAt: 0, now: () => 1, limits: { credits: 10, httpDispatches: 1, elapsedMs: 100 } });
    const operation = run.createOperation({ budget: 10, maxCreditsPerRequest: 5 });
    const reservation = run.reservePaid(operation, 5);
    const controller = new AbortController();
    controller.abort();
    expect(() => reservation.markDispatched(controller.signal)).toThrow(/cancel/i);
    expect(run.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0, httpDispatchCount: 0 }));

    const active = run.reservePaid(operation, 5);
    active.markDispatched();
    expect(() => active.markDispatched()).toThrow(/already/i);
    expect(run.snapshot().httpDispatchCount).toBe(1);
    active.settle(5);
  });

  it('rolls back the run reservation when operation commit fails', () => {
    const run = new BenchmarkRunAdmission({ runId: 'two-layer-rollback', mode: 'live', startedAt: 0, now: () => 1 });
    const operation = run.createOperation({ budget: 10, maxCreditsPerRequest: 5 });
    const reservation = run.reservePaid(operation, 5);
    operation.close('unknown_cost');
    expect(() => reservation.markDispatched()).toThrow(BenchmarkAdmissionError);
    expect(run.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0, admissionUsed: 0, httpDispatchCount: 0 }));
    expect(operation.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0 }));
  });

  it('enforces HTTP, deadline, and cancellation boundaries at dispatch', () => {
    const run = new BenchmarkRunAdmission({
      runId: 'dispatch-boundaries',
      mode: 'offline',
      startedAt: 0,
      now: () => 1,
      limits: { credits: 10, httpDispatches: 1, elapsedMs: 100 }
    });
    run.recordHttpDispatch();
    expect(() => run.recordHttpDispatch()).toThrow(BenchmarkAdmissionError);

    const countRun = new BenchmarkRunAdmission({
      runId: 'count-boundary',
      mode: 'offline',
      startedAt: 0,
      now: () => 1,
      limits: { credits: 10, httpDispatches: 1_500, elapsedMs: 100 }
    });
    for (let index = 0; index < 1_500; index++) countRun.recordHttpDispatch();
    expect(() => countRun.recordHttpDispatch()).toThrow(/limit/i);

    const deadlineRun = new BenchmarkRunAdmission({
      runId: 'deadline-boundary',
      mode: 'offline',
      startedAt: 0,
      now: () => 100,
      limits: { credits: 10, httpDispatches: 1, elapsedMs: 100 }
    });
    expect(() => deadlineRun.recordHttpDispatch()).toThrow(/deadline/i);

    const cancelledRun = new BenchmarkRunAdmission({ runId: 'cancel-boundary', mode: 'offline', startedAt: 0, now: () => 1 });
    const controller = new AbortController();
    controller.abort();
    expect(() => cancelledRun.recordHttpDispatch(controller.signal)).toThrow(/cancel/i);
  });

  it('runs the fixed plan through an injected transport response seam', async () => {
    const transport = new OfflineBenchmarkTransport();
    const dispatch = jest.fn((request: BenchmarkTransportRequest, start: BenchmarkTransportDispatchStarter) => transport.dispatch(request, start));
    const bundle = await runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'injected-transport-offline',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      executeCell: createTransportBackedCellExecutor({ dispatch }),
      now: () => 1_000
    });
    expect(bundle.report.runStatus).toBe('offline_passed');
    expect(dispatch).toHaveBeenCalledTimes(401);
    expect(dispatch.mock.calls[0][0]).toEqual(expect.objectContaining({ role: 'page', estimatedCredits: 0 }));
    expect(bundle.report.attempts.some(attempt => attempt.role === 'pdf')).toBe(true);
  });

  it('creates a complete offline report through the default transport fixture', async () => {
    const plan = buildBenchmarkPlan(validation);
    const bundle = await runBenchmark({
      validation,
      plan,
      runId: 'offline-core-test',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'offline-v1',
      executeCell: createOfflineCellExecutor(),
      now: () => 1_000
    });
    expect(bundle.report.cells).toHaveLength(360);
    expect(bundle.report.runStatus).toBe('offline_passed');
    expect(bundle.report.metrics.publisher.successes).toBe(40);
    expect(bundle.report.metrics.scholar.successes).toBe(20);
    expect(bundle.report.httpDispatchCount).toBeGreaterThan(0);
    expect(bundle.report.attempts.length).toBeGreaterThan(0);
    expect(bundle.report.attempts.some(attempt => attempt.combination === 'browser:residential' && attempt.reportedCredits === 125)).toBe(true);
    expect(bundle.json).not.toMatch(/https?:\/\/|query=|cookie|authorization/i);
    expect(bundle.markdown).toContain('offline_passed');
    expect(() => validateBenchmarkReport({ ...bundle.report, metrics: { ...bundle.report.metrics, publisher: { ...bundle.report.metrics.publisher, successes: 0 } } })).toThrow(/metrics/i);
    expect(() => validateBenchmarkReport({ ...bundle.report, mode: 'live' })).toThrow(/offline_passed/i);
    expect(() => validateBenchmarkReport({ ...bundle.report, attempts: [bundle.report.attempts[0], bundle.report.attempts[0], ...bundle.report.attempts.slice(1)] })).toThrow(/Duplicate benchmark attempt/i);
    expect(() => validateBenchmarkReport({ ...bundle.report, attempts: [{ ...bundle.report.attempts[0], dispatchCombination: 'production' }, ...bundle.report.attempts.slice(1)] })).toThrow(/combination/i);
    expect(() => validateBenchmarkReport({ ...bundle.report, cells: [{ ...bundle.report.cells[0], extra: true }, ...bundle.report.cells.slice(1)] })).toThrow(/unsupported|sensitive/i);
    expect(() => validateBenchmarkReport({ ...bundle.report, cells: [{ ...bundle.report.cells[0], httpDispatchCount: 0, serviceAttemptCount: 0 }, ...bundle.report.cells.slice(1)] })).toThrow(/dispatch trace/i);
  });

  it('never permits the offline transport to produce a live report', async () => {
    await expect(runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'offline-live-rejection',
      mode: 'live',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      executeCell: createOfflineCellExecutor()
    })).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('reconciles a paid attempt recorded before late cleanup billing', async () => {
    let first = true;
    const bundle = await runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'late-cleanup-accounting',
      mode: 'live',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      now: () => 1_000,
      limits: { credits: 10, httpDispatches: 10, elapsedMs: 7_200_000 },
      executeCell: (_cell, _sample, context) => {
        if (!first) return { outcome: 'failed', stage: 'unknown', reason: 'unknown', match: 'not_evaluated', pdfVerification: 'not_run', localSessionState: 'unknown' };
        first = false;
        const reservation = context.reservePaid(1);
        reservation.markDispatched(context.signal);
        context.recordAttempt({
          role: 'page',
          combination: 'production',
          dispatchCombination: 'direct',
          reason: 'none',
          estimate: 1,
          reportedCredits: null,
          costKnown: null,
          reservation
        });
        throw new Error('late executor failure');
      }
    });
    expect(bundle.report.runStatus).toBe('failed');
    expect(bundle.report.cells[0]).toEqual(expect.objectContaining({ httpDispatchCount: 1, admissionUsed: 1, costKnown: null }));
    expect(bundle.report.attempts[0].admissionUsed).toBe(1);
    expect(bundle.report.unknownCostAttempts).toBe(1);
  });

  it('binds out-of-order paid settlements to their own attempts before a free request', async () => {
    let first = true;
    const bundle = await runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'out-of-order-attempt-accounting',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      limits: { credits: 20, httpDispatches: 20, elapsedMs: 7_200_000 },
      executeCell: (_cell, _sample, context) => {
        if (first) {
          first = false;
          const firstReservation = context.reservePaid(1);
          const secondReservation = context.reservePaid(3);
          firstReservation.markDispatched(context.signal);
          secondReservation.markDispatched(context.signal);
          context.recordAttempt({ role: 'provider_api', combination: 'production', dispatchCombination: 'static:datacenter', reason: 'none', estimate: 1, reservation: firstReservation });
          context.recordAttempt({ role: 'provider_api', combination: 'production', dispatchCombination: 'static:datacenter', reason: 'none', estimate: 3, reservation: secondReservation });
          secondReservation.settle(3);
          firstReservation.settle(1);
          context.recordHttpDispatch();
          context.recordAttempt({ role: 'pdf', combination: 'production', dispatchCombination: 'direct', reason: 'none', estimate: 0, reportedCredits: 0, costKnown: true });
        }
        return { outcome: 'failed', stage: 'unknown', reason: 'unknown', match: 'not_evaluated', pdfVerification: 'not_run', localSessionState: 'unknown' };
      }
    });
    const firstCellAttempts = bundle.report.attempts.filter(attempt => attempt.cellId === bundle.report.cells[0].cellId);
    expect(firstCellAttempts.map(attempt => attempt.admissionUsed)).toEqual([1, 3, 0]);
    expect(bundle.report.cells[0].admissionUsed).toBe(4);
  });

  it('records unknown billing when a dispatched cell times out during cleanup', async () => {
    let releaseExecutor!: () => void;
    const pending = new Promise<void>(resolve => { releaseExecutor = resolve; });
    const bundle = await runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'timeout-cleanup-accounting',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      now: () => 1_000,
      limits: { credits: 10, httpDispatches: 10, elapsedMs: 1 },
      executeCell: async (_cell, _sample, context) => {
        const reservation = context.reservePaid(1);
        reservation.markDispatched(context.signal);
        context.recordAttempt({ role: 'page', combination: 'production', dispatchCombination: 'direct', reason: 'none', estimate: 1, reservation });
        await pending;
        return { outcome: 'failed', stage: 'unknown', reason: 'unknown', match: 'not_evaluated', pdfVerification: 'not_run', localSessionState: 'unknown' };
      }
    });
    releaseExecutor();
    expect(bundle.report.runStatus).toBe('incomplete');
    expect(bundle.report.cells[0]).toEqual(expect.objectContaining({ admissionUsed: 1, reportedCredits: null, costKnown: null }));
    expect(bundle.report.attempts[0]).toEqual(expect.objectContaining({ admissionUsed: 1, reportedCredits: null, costKnown: null }));
    expect(bundle.report.unknownCostAttempts).toBe(1);
  });

  it('updates a prior cell when late billing arrives during a later direct cell', async () => {
    let first = true;
    let lateReservation: RunReservation | undefined;
    const bundle = await runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'late-billing-next-cell',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      limits: { credits: 10, httpDispatches: 10, elapsedMs: 7_200_000 },
      executeCell: async (cell, _sample, context) => {
        if (first) {
          first = false;
          lateReservation = context.reservePaid(1);
          lateReservation.markDispatched(context.signal);
          context.recordAttempt({ role: 'page', combination: 'production', dispatchCombination: 'direct', reason: 'none', estimate: 1, reservation: lateReservation });
          setImmediate(() => lateReservation?.settle(2));
          throw new Error('late billing fixture failure');
        }
        if (cell.mode === 'comparison' && cell.combination === 'direct') {
          context.recordHttpDispatch();
          context.recordAttempt({ role: 'page', combination: cell.combination, dispatchCombination: 'direct', reason: 'none' });
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        return { outcome: 'failed', stage: 'unknown', reason: 'unknown', match: 'not_evaluated', pdfVerification: 'not_run', localSessionState: 'unknown' };
      }
    });
    expect(bundle.report.cells[0]).toEqual(expect.objectContaining({ admissionUsed: 2, reportedCredits: 2, costKnown: true }));
    expect(bundle.report.attempts[0]).toEqual(expect.objectContaining({ admissionUsed: 2, reportedCredits: 2, costKnown: true }));
    expect(bundle.report.unknownCostAttempts).toBe(0);
    expect(bundle.report.runStatus).toBe('incomplete');
  });

  it('preserves complete coverage while rejecting an unknown-billing qualification', async () => {
    const plan = buildBenchmarkPlan(validation);
    const baseExecutor = createOfflineCellExecutor();
    const finalCell = plan.cells[plan.cells.length - 1];
    const bundle = await runBenchmark({
      validation,
      plan,
      runId: 'final-comparison-unknown-cost',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      executeCell: async (cell, sample, context) => {
        if (cell.cellId !== finalCell.cellId) return baseExecutor(cell, sample, context);
        const reservation = context.reservePaid(125);
        reservation.markDispatched(context.signal);
        context.recordAttempt({
          role: 'provider_api',
          combination: cell.combination,
          dispatchCombination: 'browser:residential',
          reason: 'none',
          estimate: 125,
          reservation
        });
        return {
          outcome: 'failed',
          stage: 'response',
          reason: 'unknown_cost',
          match: 'not_evaluated',
          pdfVerification: 'not_requested',
          localSessionState: 'not_applicable'
        };
      }
    });
    expect(bundle.report.runStatus).toBe('failed');
    expect(bundle.report.cells).toHaveLength(360);
    expect(bundle.report.cells.every(cell => cell.outcome !== 'not_run')).toBe(true);
    expect(bundle.report.metrics.publisher).toEqual(expect.objectContaining({ passed: true, costKnown: true }));
    expect(bundle.report.metrics.scholar).toEqual(expect.objectContaining({ passed: true, costKnown: true }));
    expect(bundle.report.unknownCostAttempts).toBe(1);
    expect(bundle.report.reportedCredits).toBeNull();
    expect(bundle.report.attempts.at(-1)).toEqual(expect.objectContaining({
      dispatchCombination: 'browser:residential',
      reportedCredits: null,
      costKnown: null
    }));
  });

  it('reports paid-budget exhaustion without mislabeling comparison PDF work', async () => {
    const bundle = await runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'comparison-budget-exhaustion',
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      now: () => 1_000,
      limits: { credits: 0, httpDispatches: 1_500, elapsedMs: 7_200_000 },
      executeCell: createOfflineCellExecutor()
    });
    expect(bundle.report.runStatus).toBe('incomplete');
    expect(bundle.report.cells.some(cell => cell.mode === 'comparison' && cell.outcome === 'failed')).toBe(true);
    expect(bundle.report.cells.filter(cell => cell.mode === 'comparison' && cell.outcome !== 'not_run')
      .every(cell => cell.pdfVerification === 'not_requested')).toBe(true);
  });

  it('does not trust executor-supplied success totals without observed dispatches', async () => {
    await expect(runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'fabricated-summary',
      mode: 'live',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      now: () => 1_000,
      executeCell: cell => ({
        outcome: 'success',
        stage: 'parse',
        reason: 'none',
        httpDispatchCount: 999,
        serviceAttemptCount: 999,
        elapsedMs: 1,
        admissionUsed: 999,
        reportedCredits: 999,
        costKnown: true,
        match: 'matched',
        pdfVerification: cell.sampleKind === 'publisher' && cell.mode === 'production' ? 'verified' : 'not_requested',
        localSessionState: 'not_applicable'
      })
    })).rejects.toThrow(/dispatch trace/i);
  });

  it('turns an executor that ignores abort into an incomplete run', async () => {
    jest.useFakeTimers();
    try {
      const pending = runBenchmark({
        validation,
        plan: buildBenchmarkPlan(validation),
        runId: 'deadline-ignoring-executor',
        mode: 'live',
        codeVersion: 'code-v1',
        configVersion: 'config-v1',
        now: Date.now,
        limits: { elapsedMs: 1, credits: 100, httpDispatches: 10 },
        executeCell: () => new Promise(() => undefined)
      });
      await jest.advanceTimersByTimeAsync(2);
      const bundle = await pending;
      expect(bundle.report.runStatus).toBe('incomplete');
      expect(bundle.report.cells[0].outcome).toBe('failed');
      expect(bundle.report.cells.slice(1).every(cell => cell.outcome === 'not_run')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires every planned cell in a report and rejects sensitive fields', () => {
    const plan = buildBenchmarkPlan(validation);
    const run = new BenchmarkRunAdmission({ runId: 'report-test', mode: 'offline', startedAt: 0, now: () => 1 });
    const report = createBenchmarkReport({
      run: run.snapshot(),
      runLimits: run.limits,
      plan,
      corpusVersion: validation.corpusVersion,
      codeVersion: 'code-v1',
      configVersion: 'config-v1'
    });
    expect(report.runStatus).toBe('incomplete');
    expect(() => validateBenchmarkReport({ ...report, cells: [{ ...report.cells[0], url: 'https://secret.example' }, ...report.cells.slice(1)] }, plan)).toThrow(/sensitive/i);
  });

  it('accepts legacy and independently introduced attribution extensions', () => {
    const plan = buildBenchmarkPlan(validation);
    const run = new BenchmarkRunAdmission({ runId: 'legacy-attempt-report', mode: 'offline', startedAt: 0, now: () => 1 });
    run.recordHttpDispatch();
    const report = createBenchmarkReport({
      run: run.snapshot(),
      runLimits: run.limits,
      plan,
      corpusVersion: validation.corpusVersion,
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      cells: [execution({ httpDispatchCount: 1, serviceAttemptCount: 1, admissionUsed: 0, reportedCredits: 0, costKnown: true })],
      attempts: [{
        attemptId: 'attempt-legacy-check',
        dispatchId: 'dispatch-legacy-check',
        cellId: execution().cellId,
        role: 'page',
        combination: 'production',
        dispatchCombination: 'direct',
        submittedAt: new Date(0).toISOString(),
        elapsedMs: 1,
        apiStatus: 200,
        targetStatus: 200,
        reason: 'none',
        failureKind: null,
        estimate: 0,
        reportedCredits: 0,
        costKnown: true,
        admissionUsed: 0
      }]
    });
    const [{ dispatchId, failureKind, ...core }] = report.attempts;
    const variants = [
      core,
      { ...core, dispatchId },
      { ...core, failureKind },
      { ...core, dispatchId, failureKind }
    ];
    for (const attempt of variants) {
      expect(() => validateBenchmarkReport({ ...report, attempts: [attempt] }, plan)).not.toThrow();
    }
    expect(() => validateBenchmarkReport({
      ...report,
      attempts: [{ ...core, dispatchId: 'not safe' }]
    }, plan)).toThrow(/dispatchId/i);
    expect(() => validateBenchmarkReport({
      ...report,
      attempts: [{ ...core, failureKind: 'not-a-phase' }]
    }, plan)).toThrow(/failureKind/i);
    expect(() => validateBenchmarkReport({
      ...report,
      attempts: [{ ...core, unexpected: true }]
    }, plan)).toThrow(/unsupported|unexpected/i);
  });

  it('enforces process-local run exclusivity', () => {
    const release = acquireBenchmarkRunId('exclusive-test');
    try {
      expect(() => acquireBenchmarkRunId('exclusive-test')).toThrow(BenchmarkAdmissionError);
    } finally {
      release();
    }
  });

  it('leaves a completed file marker that blocks cross-process reruns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retrieval-benchmark-'));
    try {
      const runId = 'file-lock:01';
      const first = await acquireBenchmarkRunFileLock(runId, directory);
      expect(await readdir(directory)).toEqual([`${benchmarkFilesystemStem(runId)}.lock`]);
      await expect(acquireBenchmarkRunFileLock(runId, directory)).rejects.toThrow(/marker|active/i);
      await first.close(true);
      await expect(acquireBenchmarkRunFileLock(runId, directory)).rejects.toThrow(/marker|active/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
