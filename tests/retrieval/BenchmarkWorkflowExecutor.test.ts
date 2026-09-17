import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  BenchmarkOperationAdmission,
  BenchmarkRunAdmission,
  buildBenchmarkPlan,
  createProductionBenchmarkCellExecutor,
  defaultFixtureResolver,
  runBenchmark,
  validateBenchmarkCorpus,
  type BenchmarkCellExecutionContext,
  type BenchmarkWorkflowFixtureRequest,
  type BenchmarkWorkflowFixtureResponse,
  type RunReservation
} from '../../src/retrieval/benchmark/index.js';
import type { BenchmarkAttempt, BenchmarkCell, BenchmarkSample } from '../../src/retrieval/benchmark/types.js';
import { parseRetrievalConfiguration } from '../../src/retrieval/Configuration.js';
import {
  DEFAULT_PUBLISHER_WORKFLOW_FIXTURES,
  DEFAULT_SCHOLAR_WORKFLOW_FIXTURES
} from '../../src/retrieval/benchmark/defaultFixtures.js';
import corpus from '../fixtures/retrieval-benchmark/corpus.json';
import { MAX_RETRIEVAL_RESPONSE_BYTES } from '../../src/retrieval/DirectHttpProvider.js';

const validation = validateBenchmarkCorpus(corpus);

interface HarnessContext {
  readonly run: BenchmarkRunAdmission;
  readonly context: BenchmarkCellExecutionContext;
  readonly attempts: BenchmarkAttempt[];
  readonly reservations: RunReservation[];
  readonly finish: () => void;
}

function createContext(
  runId: string,
  mode: 'offline' | 'live' = 'offline',
  cell: BenchmarkCell = buildBenchmarkPlan(validation).cells[0],
  existingRun?: BenchmarkRunAdmission,
  elapsedMs = 120_000,
  limits?: { credits: number; httpDispatches: number; elapsedMs: number },
  clock: () => number = Date.now
): HarnessContext {
  const now = clock;
  const run = existingRun || new BenchmarkRunAdmission({
    runId,
    mode,
    startedAt: now(),
    now,
    limits: limits || { credits: 500, httpDispatches: 100, elapsedMs }
  });
  const operation = run.createOperation({ budget: 500, maxCreditsPerRequest: 125, operationId: `${runId}:operation` });
  const controller = new AbortController();
  const attempts: BenchmarkAttempt[] = [];
  const reservations: RunReservation[] = [];
  let sequence = 0;
  const context: BenchmarkCellExecutionContext = {
    run,
    operation,
    signal: controller.signal,
    now,
    deadlineAt: run.deadlineAt,
    reservePaid: estimate => {
      const reservation = run.reservePaid(operation, estimate);
      reservations.push(reservation);
      return reservation;
    },
    recordHttpDispatch: () => run.recordHttpDispatch(controller.signal),
    recordAttempt: input => {
      const attempt: BenchmarkAttempt = {
        attemptId: `${runId}:attempt-${++sequence}`,
        dispatchId: input.dispatchId ?? null,
        cellId: cell.cellId,
        role: input.role,
        combination: input.combination,
        dispatchCombination: input.dispatchCombination ?? input.combination,
        submittedAt: new Date(now()).toISOString(),
        elapsedMs: input.elapsedMs || 0,
        apiStatus: input.apiStatus ?? null,
        targetStatus: input.targetStatus ?? null,
        reason: input.reason,
        failureKind: input.failureKind ?? null,
        estimate: input.estimate ?? null,
        reportedCredits: input.reportedCredits ?? null,
        costKnown: input.costKnown ?? null,
        admissionUsed: input.reservation?.settlementObserved ? input.reservation.admissionUsed : 0
      };
      attempts.push(attempt);
      return {
        ...attempt,
        complete: update => {
          const index = attempts.findIndex(candidate => candidate.attemptId === attempt.attemptId);
          attempts[index] = { ...attempts[index], ...update };
        }
      };
    }
  };
  return {
    run,
    context,
    attempts,
    reservations,
    finish: () => {
      for (const reservation of reservations) {
        if (reservation.settled) continue;
        if (reservation.dispatched) reservation.settle(null);
        else reservation.release();
      }
      controller.abort();
    }
  };
}

function publisherPage(sample: Extract<BenchmarkSample, { kind: 'publisher' }>): string {
  return `<html><head><link rel="alternate" type="application/pdf" href="${sample.candidateUrls[0]}"></head><body>fixture</body></html>`;
}

function publisherResolver(
  request: BenchmarkWorkflowFixtureRequest,
  directStatus: number = 200
): BenchmarkWorkflowFixtureResponse {
  if (request.role === 'doi') return { status: 302, headers: { location: request.sample.evidenceUrl } };
  if (request.role === 'redirect') return { status: 200, data: '' };
  if (request.role === 'pdf') return { status: 200, headers: { 'content-type': 'application/pdf' }, data: '%PDF-1.7 fixture' };
  if (request.role === 'provider_api') {
    const sample = request.sample as Extract<BenchmarkSample, { kind: 'publisher' }>;
    return {
      status: 200,
      headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
      data: JSON.stringify({ html: publisherPage(sample), status_code: 200 })
    };
  }
  if (request.sample.kind === 'publisher') {
    return { status: directStatus, data: publisherPage(request.sample) };
  }
  return { status: 200, data: '' };
}

describe('production benchmark workflow executor', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects the real workflow fixture adapter in live mode before run admission', async () => {
    await expect(runBenchmark({
      validation,
      plan: buildBenchmarkPlan(validation),
      runId: 'workflow-live-rejected',
      mode: 'live',
      codeVersion: 'workflow-test',
      configVersion: 'workflow-fixtures',
      executeCell: createProductionBenchmarkCellExecutor()
    })).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('keeps a runner report immutable when a cancelled production provider settles late', async () => {
    jest.useFakeTimers();
    const plan = buildBenchmarkPlan(validation);
    const sample = validation.corpus.publisher[0];
    let providerRequest: BenchmarkWorkflowFixtureRequest | undefined;
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    let releaseProvider!: (response: BenchmarkWorkflowFixtureResponse) => void;
    let signalLateSettlement!: () => void;
    const lateSettlement = new Promise<void>(resolve => { signalLateSettlement = resolve; });
    const pendingProvider = new Promise<BenchmarkWorkflowFixtureResponse>(resolve => { releaseProvider = resolve; });
    const executor = createProductionBenchmarkCellExecutor({
      delay: async () => undefined,
      retrySleep: async () => undefined,
      onPaidSettlement: phase => {
        if (phase === 'reconcile') signalLateSettlement();
      },
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') return publisherResolver(request, 500);
        if (request.role === 'provider_api') {
          providerRequest = request;
          started();
          return pendingProvider;
        }
        return publisherResolver(request);
      }
    });
    const pending = runBenchmark({
      validation,
      plan,
      runId: 'workflow-runner-late-report',
      mode: 'offline',
      codeVersion: 'workflow-test',
      configVersion: 'workflow-fixtures',
      now: Date.now,
      limits: { credits: 500, httpDispatches: 100, elapsedMs: 61_000 },
      executeCell: executor
    });
    await providerStarted;
    await jest.advanceTimersByTimeAsync(61_001);
    const bundle = await pending;
    const snapshot = JSON.stringify(bundle.report);
    expect(bundle.report.runStatus).toBe('incomplete');
    expect(bundle.report.unknownCostAttempts).toBe(1);
    expect(bundle.report.attempts.some(attempt => attempt.role === 'provider_api' && attempt.costKnown === null)).toBe(true);
    releaseProvider(publisherResolver(providerRequest!));
    await lateSettlement;
    expect(JSON.stringify(bundle.report)).toBe(snapshot);
  });

  it('rejects fixture requests with mismatched cell and sample identities', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const wrongSample = validation.corpus.publisher[1];
    const harness = createContext('workflow-cell-identity-mismatch', 'offline', cell);
    const result = await createProductionBenchmarkCellExecutor()(cell, wrongSample, harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(0);

    const wrongSampleId = { ...validation.corpus.publisher[0], sampleId: 'pub-unknown' };
    const secondHarness = createContext('workflow-sample-identity-mismatch', 'offline', cell);
    const secondResult = await createProductionBenchmarkCellExecutor()(cell, wrongSampleId, secondHarness.context);
    secondHarness.finish();
    expect(secondResult.outcome).toBe('failed');
    expect(secondHarness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(0);
  });

  it('preserves the target status and exact elapsed time for a body-limit failure', async () => {
    let clock = 0;
    const now = () => clock;
    const cell = buildBenchmarkPlan(validation).cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    const harness = createContext(
      'workflow-body-limit-attribution',
      'offline',
      cell,
      undefined,
      120_000,
      undefined,
      now
    );
    let emitted = false;
    const oversizedBody = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES + 1) };
          },
          return: async () => ({ done: true, value: undefined })
        };
      }
    };
    const executor = createProductionBenchmarkCellExecutor({
      now,
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') {
          clock += 37;
          return { status: 200, data: oversizedBody };
        }
        return publisherResolver(request);
      }
    });

    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    const pageAttempt = harness.attempts.find(attempt => attempt.role === 'page');
    expect(result.reason).toBe('parse_failed');
    expect(pageAttempt).toEqual(expect.objectContaining({
      targetStatus: 200,
      reason: 'parse_failed',
      failureKind: 'response_body',
      elapsedMs: 37
    }));
    harness.finish();
  });

  it('keeps the final redirect hop correlated through body failure', async () => {
    let emitted = false;
    const oversizedBody = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: Buffer.alloc(MAX_RETRIEVAL_RESPONSE_BYTES + 1) };
          },
          return: async () => ({ done: true, value: undefined })
        };
      }
    };
    const cell = buildBenchmarkPlan(validation).cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    const harness = createContext('workflow-redirect-body-failure', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') {
          return { status: 302, headers: { location: 'https://publisher.example/final' }, data: '' };
        }
        if (request.role === 'redirect' && request.url === 'https://publisher.example/final') {
          return { status: 200, data: oversizedBody };
        }
        return publisherResolver(request);
      }
    });

    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    const finalRedirect = harness.attempts
      .filter(attempt => attempt.role === 'redirect' && attempt.targetStatus === 200)
      .pop();
    expect(result.reason).toBe('parse_failed');
    expect(finalRedirect).toEqual(expect.objectContaining({
      targetStatus: 200,
      reason: 'parse_failed',
      failureKind: 'response_body'
    }));
    harness.finish();
  });

  it('rejects a fixture request with the wrong DOI identity', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const sample = { ...validation.corpus.publisher[0], doi: '10.9999/fixture-mismatch' };
    const harness = createContext('workflow-fixture-identity-mismatch', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor();
    const result = await executor(cell, sample, harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(0);
    expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
  });

  it('rejects Scholar query, offset, and target identity mismatches', () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison'
      && candidate.sampleKind === 'scholar'
      && candidate.combination === 'direct')!;
    const sample = validation.corpus.scholar[0];
    const base = {
      cell,
      sample,
      role: 'page' as const,
      transport: 'direct' as const,
      combination: 'direct' as const,
      estimatedCredits: 0,
      method: 'GET',
      headers: {}
    };
    expect(defaultFixtureResolver({
      ...base,
      url: `https://scholar.google.com/scholar?q=${encodeURIComponent(sample.query)}&start=10&hl=en&as_sdt=0%2C5&as_vis=1`
    }).status).toBe(404);
    expect(defaultFixtureResolver({
      ...base,
      url: `https://scholar.google.com/scholar?q=${encodeURIComponent('wrong query')}&start=0&hl=en&as_sdt=0%2C5&as_vis=1`
    }).status).toBe(404);
    expect(defaultFixtureResolver({
      ...base,
      url: `https://scholar.google.com.example/scholar?q=${encodeURIComponent(sample.query)}&start=0&hl=en&as_sdt=0%2C5&as_vis=1`
    }).status).toBe(404);
  });

  it('catalogues every frozen sample with exact identity and diverse publisher hosts', () => {
    expect(Object.keys(DEFAULT_PUBLISHER_WORKFLOW_FIXTURES).sort()).toEqual(validation.corpus.publisher.map(sample => sample.sampleId).sort());
    expect(Object.keys(DEFAULT_SCHOLAR_WORKFLOW_FIXTURES).sort()).toEqual(validation.corpus.scholar.map(sample => sample.sampleId).sort());
    for (const sample of validation.corpus.publisher) {
      const fixture = DEFAULT_PUBLISHER_WORKFLOW_FIXTURES[sample.sampleId];
      expect(fixture).toEqual(expect.objectContaining({
        doi: sample.doi,
        title: sample.expectedTitle,
        candidateUrl: sample.candidateUrls[0],
        landingUrl: sample.evidenceUrl
      }));
    }
    for (const sample of validation.corpus.scholar) {
      expect(DEFAULT_SCHOLAR_WORKFLOW_FIXTURES[sample.sampleId]).toEqual({
        query: sample.query,
        title: sample.expected.title
      });
    }
    const hosts = new Set(Object.values(DEFAULT_PUBLISHER_WORKFLOW_FIXTURES).flatMap(fixture => [
      new URL(fixture.landingUrl).host,
      new URL(fixture.candidateUrl).host
    ]));
    expect(hosts.size).toBeGreaterThanOrEqual(5);
  });

  it('propagates an injected clock to the default source scheduler', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const clock = () => 1_000_000;
    const harness = createContext('workflow-default-clock', 'offline', cell, undefined, 120_000, undefined, clock);
    const executor = createProductionBenchmarkCellExecutor({ now: clock, retrySleep: async () => undefined });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('success');
    expect(harness.attempts.filter(attempt => attempt.role === 'doi')).toHaveLength(1);
  });

  it('uses an independent raw fixture catalog for the default positive control', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const harness = createContext('workflow-publisher-default', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({ retrySleep: async () => undefined });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('success');
    expect(result.match).toBe('matched');
    expect(result.pdfVerification).toBe('verified');
    expect(harness.attempts.map(attempt => attempt.role)).toEqual(
      expect.arrayContaining(['doi', 'redirect', 'page', 'pdf'])
    );
  });

  it('runs Publisher production through DOI, real parsing, paid fallback and PDF verification', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    let directCalls = 0;
    const harness = createContext('workflow-publisher-fallback', 'offline', cell);
    // The production executor receives the selected cell/sample directly, so
    // the callback is keyed by those identities rather than returning results.
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') {
          directCalls++;
          return publisherResolver(request, 500);
        }
        return publisherResolver(request);
      },
      delay: async () => undefined,
      retrySleep: async () => undefined
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('success');
    expect(result.match).toBe('matched');
    expect(result.pdfVerification).toBe('verified');
    expect(directCalls).toBeGreaterThan(0);
    expect(harness.attempts.map(attempt => attempt.role)).toEqual(
      expect.arrayContaining(['doi', 'redirect', 'page', 'provider_api', 'pdf'])
    );
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')?.dispatchCombination).toBe('static:datacenter');
  });

  it('classifies an HTTP PDF verification rejection as a target failure, not parsing failure', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const harness = createContext('workflow-pdf-http-rejection', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => request.role === 'pdf'
        ? { status: 403, data: '' }
        : publisherResolver(request),
      retrySleep: async () => undefined
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result).toEqual(expect.objectContaining({
      outcome: 'failed',
      reason: 'target_failed',
      match: 'matched',
      pdfVerification: 'failed'
    }));
    expect(harness.attempts.find(attempt => attempt.role === 'pdf')).toEqual(
      expect.objectContaining({ targetStatus: 403, reason: 'target_failed' })
    );
  });

  it('stops paid escalation after provider retry exhaustion and preserves provider closure', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const harness = createContext('workflow-provider-closure', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') return publisherResolver(request, 500);
        if (request.role === 'provider_api') {
          const response = publisherResolver(request);
          return { ...response, status: 500 };
        }
        return publisherResolver(request);
      },
      retrySleep: async () => undefined
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(3);
    expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
    expect(harness.context.operation.snapshot().paidClosedReason).toBe('provider_error');
  });

  it('keeps retryable provider attempts isolated before a later success', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    let providerCalls = 0;
    const harness = createContext('workflow-attempt-isolation', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') return publisherResolver(request, 500);
        if (request.role === 'provider_api' && providerCalls++ === 0) {
          return {
            status: 500,
            headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
            data: JSON.stringify({ html: '' })
          };
        }
        return publisherResolver(request);
      },
      retrySleep: async () => undefined
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    const providerAttempts = harness.attempts.filter(attempt => attempt.role === 'provider_api');
    expect(result.outcome).toBe('success');
    expect(providerAttempts).toHaveLength(2);
    expect(providerAttempts[0]).toEqual(expect.objectContaining({ apiStatus: 500, reason: 'target_failed' }));
    expect(providerAttempts[1]).toEqual(expect.objectContaining({ apiStatus: 200, targetStatus: 200, reason: 'none' }));
  });

  it('records the provider-normalized target status rather than reparsing raw payloads', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:datacenter')!;
    const harness = createContext('workflow-normalized-status', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'provider_api') {
          const sample = request.sample as Extract<BenchmarkSample, { kind: 'publisher' }>;
          return {
            status: 200,
            headers: {
              'Ant-credits-cost': String(request.estimatedCredits),
              'Ant-page-status-code': '503'
            },
            data: JSON.stringify({ html: publisherPage(sample), status_code: 'not-a-status' })
          };
        }
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(result.targetStatus).toBe(503);
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')).toEqual(expect.objectContaining({ targetStatus: 503 }));
  });

  it('keeps a comparison Publisher cell to one selected strategy and no PDF probe', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.combination === 'browser:residential' && candidate.sampleKind === 'publisher')!;
    const harness = createContext('workflow-publisher-comparison', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => publisherResolver(request)
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('success');
    expect(result.pdfVerification).toBe('not_requested');
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(0);
    expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')?.combination).toBe('browser:residential');
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')?.dispatchCombination).toBe('browser:residential');
  });

  it('rolls back both admissions when the run rejects a paid dispatch before transport', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const harness = createContext(
      'workflow-pre-transport-run-limit',
      'offline',
      cell,
      undefined,
      120_000,
      { credits: 500, httpDispatches: 5, elapsedMs: 120_000 }
    );
    let providerCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      retrySleep: async () => undefined,
      resolveFixture: request => {
        if (request.role === 'provider_api') {
          providerCalls++;
          throw new Error('paid transport must not be called');
        }
        return publisherResolver(request, request.role === 'page' ? 500 : 200);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    expect(result.outcome).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(harness.run.snapshot()).toEqual(expect.objectContaining({
      admissionUsed: 0,
      reservedCredits: 0,
      unknownCostAttempts: 0
    }));
    expect(harness.context.operation.snapshot()).toEqual(expect.objectContaining({
      reservedCredits: 0,
      unknownCostAttempts: 0
    }));
    expect(harness.reservations.length).toBeGreaterThan(0);
    expect(harness.reservations.every(reservation => reservation.settled
      && reservation.settlementObserved
      && !reservation.dispatched
      && reservation.admissionUsed === 0
      && reservation.costKnown === true)).toBe(true);
    expect(harness.attempts.some(attempt => attempt.role === 'provider_api')).toBe(false);
    harness.finish();
  });

  it('releases both ledgers when the provider deadline guard rejects before dispatch', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison'
      && candidate.sampleKind === 'publisher'
      && candidate.combination === 'static:datacenter')!;
    const harness = createContext(
      'workflow-provider-deadline-before-dispatch',
      'offline',
      cell,
      undefined,
      59_999
    );
    let providerCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'provider_api') providerCalls++;
        return publisherResolver(request);
      }
    });

    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    try {
      expect(result.outcome).toBe('failed');
      expect(providerCalls).toBe(0);
      expect(harness.attempts.some(attempt => attempt.role === 'provider_api')).toBe(false);
      expect(harness.run.snapshot()).toEqual(expect.objectContaining({
        admissionUsed: 0,
        reservedCredits: 0,
        unknownCostAttempts: 0
      }));
      expect(harness.context.operation.snapshot()).toEqual(expect.objectContaining({
        reservedCredits: 0,
        unknownCostAttempts: 0
      }));
      expect(harness.reservations.length).toBeGreaterThan(0);
      expect(harness.reservations.every(reservation => reservation.settled
        && reservation.settlementObserved
        && !reservation.dispatched
        && reservation.admissionUsed === 0
        && reservation.costKnown === true)).toBe(true);
    } finally {
      harness.finish();
    }
  });

  it('does not dispatch paid comparison work when authorization is disabled', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:datacenter')!;
    const harness = createContext('workflow-paid-disabled', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'false',
        SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true'
      }),
      resolveFixture: request => {
        if (request.role === 'provider_api') throw new Error('paid fixture must not be called');
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(harness.run.snapshot().httpDispatchCount).toBe(2);
  });

  it('rejects browser escalation without authorization before reservation or provider dispatch', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'browser:datacenter')!;
    const harness = createContext('workflow-browser-unauthorized', 'offline', cell);
    let providerCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'true'
      }),
      resolveFixture: request => {
        if (request.role === 'provider_api') providerCalls++;
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(harness.run.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0, admissionUsed: 0 }));
  });

  it('rejects residential escalation without explicit authorization before dispatch', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:residential')!;
    const harness = createContext('workflow-residential-unauthorized', 'offline', cell);
    let providerCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'true'
      }),
      resolveFixture: request => {
        if (request.role === 'provider_api') providerCalls++;
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(harness.run.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0, admissionUsed: 0 }));
  });

  it('rejects residential dispatch outside the configured datacenter proxy ceiling', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:residential')!;
    const harness = createContext('workflow-residential-ceiling', 'offline', cell);
    let providerCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'true',
        SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
        SCRAPINGANT_PROXY_TYPE: 'datacenter'
      }),
      resolveFixture: request => {
        if (request.role === 'provider_api') providerCalls++;
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(providerCalls).toBe(0);
    expect(harness.run.snapshot()).toEqual(expect.objectContaining({ reservedCredits: 0, admissionUsed: 0 }));
  });

  it('honors explicit lower per-request paid limits before provider dispatch', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'browser:datacenter')!;
    const harness = createContext('workflow-paid-request-limit', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'true',
        SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
        SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '1',
        SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '2'
      }),
      resolveFixture: request => {
        if (request.role === 'provider_api') throw new Error('paid fixture must not be called');
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(harness.run.snapshot().admissionUsed).toBe(0);
  });

  it('stops cumulative production paid retries at the configured operation budget', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells[0];
    const harness = createContext('workflow-cumulative-operation-limit', 'offline', cell);
    let providerCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'true',
        SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
        SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '1',
        SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '10'
      }),
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') return publisherResolver(request, 500);
        if (request.role === 'provider_api') {
          providerCalls++;
          return {
            status: 500,
            headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
            data: JSON.stringify({ html: '' })
          };
        }
        return publisherResolver(request);
      },
      retrySleep: async () => undefined
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(providerCalls).toBe(1);
    expect(harness.run.snapshot()).toEqual(expect.objectContaining({ admissionUsed: 1, reservedCredits: 0 }));
  });

  it('honors an explicit lower per-operation paid budget before provider dispatch', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:residential')!;
    const harness = createContext('workflow-paid-operation-limit', 'offline', cell);
    const executor = createProductionBenchmarkCellExecutor({
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'fixture-key',
        SCRAPINGANT_ENABLED: 'true',
        SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
        SCRAPINGANT_PROXY_TYPE: 'residential',
        SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '2',
        SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '125'
      }),
      resolveFixture: request => {
        if (request.role === 'provider_api') throw new Error('paid fixture must not be called');
        return publisherResolver(request);
      }
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(harness.run.snapshot().admissionUsed).toBe(0);
  });

  it('does not retry a retryable comparison response or enter fallback', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'direct')!;
    const harness = createContext('workflow-publisher-no-retry', 'offline', cell);
    let pageCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'page' && request.transport === 'direct') {
          pageCalls++;
          return { status: 500, data: 'temporary target error' };
        }
        return publisherResolver(request);
      },
      retrySleep: async () => undefined
    });
    const result = await executor(cell, validation.corpus.publisher[0], harness.context);
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(pageCalls).toBe(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
  });

  it('runs every comparison combination as exactly one selected attempt without PDF probes', async () => {
    const plan = buildBenchmarkPlan(validation);
    const combinations = ['direct', 'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'] as const;
    for (const combination of combinations) {
      const cell = plan.cells.find(candidate => candidate.mode === 'comparison'
        && candidate.sampleKind === 'publisher'
        && candidate.combination === combination)!;
      const harness = createContext(`workflow-comparison-${combination}`, 'offline', cell);
      let pageCalls = 0;
      let providerCalls = 0;
      const executor = createProductionBenchmarkCellExecutor({
        configuration: parseRetrievalConfiguration({
          SCRAPINGANT_API_KEY: 'fixture-key',
          SCRAPINGANT_ENABLED: 'true',
          SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
          SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
          SCRAPINGANT_PROXY_TYPE: 'residential'
        }),
        resolveFixture: request => {
          if (request.role === 'page' && request.transport === 'direct') {
            pageCalls++;
            return { status: 500, data: 'retryable target response' };
          }
          if (request.role === 'provider_api') {
            providerCalls++;
            return {
              status: 200,
              headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
              data: JSON.stringify({ html: '', status_code: 200 })
            };
          }
          return publisherResolver(request);
        },
        retrySleep: async () => undefined
      });
      const result = await executor(cell, validation.corpus.publisher[0], harness.context);
      const attempts = harness.attempts;
      harness.finish();
      expect(result.outcome).toBe('failed');
      expect(pageCalls).toBe(combination === 'direct' ? 1 : 0);
      expect(providerCalls).toBe(combination === 'direct' ? 0 : 1);
      expect(attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
      expect(attempts.filter(attempt => attempt.role === 'provider_api').every(attempt => attempt.dispatchCombination === combination)).toBe(true);
    }
  });

  it('does not retry retryable Scholar responses across all comparison combinations', async () => {
    jest.useFakeTimers();
    try {
      const plan = buildBenchmarkPlan(validation);
      const combinations = ['direct', 'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'] as const;
      for (const combination of combinations) {
        const cell = plan.cells.find(candidate => candidate.mode === 'comparison'
          && candidate.sampleKind === 'scholar'
          && candidate.combination === combination)!;
        const harness = createContext(`workflow-scholar-no-retry-${combination}`, 'offline', cell);
        let pageCalls = 0;
        let providerCalls = 0;
        const executor = createProductionBenchmarkCellExecutor({
          configuration: parseRetrievalConfiguration({
            SCRAPINGANT_API_KEY: 'fixture-key',
            SCRAPINGANT_ENABLED: 'true',
            SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
            SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
            SCRAPINGANT_PROXY_TYPE: 'residential'
          }),
          resolveFixture: request => {
            if (request.role === 'init') return { status: 200, data: '<html>home</html>' };
            if (request.role === 'page' && request.transport === 'direct') {
              pageCalls++;
              return { status: 500, data: 'retryable Scholar response' };
            }
            if (request.role === 'provider_api') {
              providerCalls++;
              return {
                status: 500,
                headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
                data: JSON.stringify({ html: '' })
              };
            }
            return { status: 200, data: '' };
          },
          retrySleep: async () => undefined
        });
        const pending = executor(cell, validation.corpus.scholar[0], harness.context);
        await jest.runAllTimersAsync();
        const result = await pending;
        harness.finish();
        expect(result.outcome).toBe('failed');
        expect(pageCalls).toBe(combination === 'direct' ? 1 : 0);
        expect(providerCalls).toBe(combination === 'direct' ? 0 : 1);
        expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(combination === 'direct' ? 1 : 0);
        expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(combination === 'direct' ? 0 : 1);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry empty Scholar responses across all comparison combinations', async () => {
    jest.useFakeTimers();
    try {
      const plan = buildBenchmarkPlan(validation);
      const combinations = ['direct', 'static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'] as const;
      for (const combination of combinations) {
        const cell = plan.cells.find(candidate => candidate.mode === 'comparison'
          && candidate.sampleKind === 'scholar'
          && candidate.combination === combination)!;
        const harness = createContext(`workflow-scholar-empty-${combination}`, 'offline', cell);
        let pageCalls = 0;
        let providerCalls = 0;
        const executor = createProductionBenchmarkCellExecutor({
          configuration: parseRetrievalConfiguration({
            SCRAPINGANT_API_KEY: 'fixture-key',
            SCRAPINGANT_ENABLED: 'true',
            SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
            SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
            SCRAPINGANT_PROXY_TYPE: 'residential'
          }),
          resolveFixture: request => {
            if (request.role === 'init') return { status: 200, data: '<html>home</html>' };
            if (request.role === 'page' && request.transport === 'direct') {
              pageCalls++;
              return { status: 200, data: '<html><body></body></html>' };
            }
            if (request.role === 'provider_api') {
              providerCalls++;
              return {
                status: 200,
                headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
                data: JSON.stringify({ html: '', status_code: 200 })
              };
            }
            return { status: 200, data: '' };
          }
        });
        const pending = executor(cell, validation.corpus.scholar[0], harness.context);
        await jest.runAllTimersAsync();
        const result = await pending;
        harness.finish();
        expect(result.outcome).toBe('failed');
        expect(pageCalls).toBe(combination === 'direct' ? 1 : 0);
        expect(providerCalls).toBe(combination === 'direct' ? 0 : 1);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry retryable paid responses for any paid comparison combination', async () => {
    const plan = buildBenchmarkPlan(validation);
    const combinations = ['static:datacenter', 'browser:datacenter', 'static:residential', 'browser:residential'] as const;
    for (const combination of combinations) {
      const cell = plan.cells.find(candidate => candidate.mode === 'comparison'
        && candidate.sampleKind === 'publisher'
        && candidate.combination === combination)!;
      const harness = createContext(`workflow-paid-no-retry-${combination}`, 'offline', cell);
      let providerCalls = 0;
      const executor = createProductionBenchmarkCellExecutor({
        configuration: parseRetrievalConfiguration({
          SCRAPINGANT_API_KEY: 'fixture-key',
          SCRAPINGANT_ENABLED: 'true',
          SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
          SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
          SCRAPINGANT_PROXY_TYPE: 'residential'
        }),
        resolveFixture: request => {
          if (request.role === 'provider_api') {
            providerCalls++;
            return {
              status: 500,
              headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
              data: JSON.stringify({ html: '' })
            };
          }
          return publisherResolver(request);
        },
        retrySleep: async () => undefined
      });
      const result = await executor(cell, validation.corpus.publisher[0], harness.context);
      harness.finish();
      expect(result.outcome).toBe('failed');
      expect(providerCalls).toBe(1);
      expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
      expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
    }
  });

  it('keeps missing paid billing linked without closing later benchmark work', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:datacenter')!;
    const run = new BenchmarkRunAdmission({
      runId: 'workflow-unknown-cost',
      mode: 'offline',
      startedAt: Date.now(),
      now: Date.now,
      limits: { credits: 500, httpDispatches: 100, elapsedMs: 120_000 }
    });
    const first = createContext('workflow-unknown-cost-first', 'offline', cell, run);
    const second = createContext('workflow-unknown-cost-second', 'offline', cell, run);
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        const response = publisherResolver(request);
        return request.role === 'provider_api'
          ? { ...response, headers: undefined }
          : response;
      }
    });
    await executor(cell, validation.corpus.publisher[0], first.context);
    first.finish();
    const secondResult = await executor(cell, validation.corpus.publisher[0], second.context);
    second.finish();
    expect(run.snapshot()).toEqual(expect.objectContaining({
      paidClosed: false,
      reportedCostKnown: false,
      unknownCostAttempts: 2
    }));
    expect(first.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
    expect(second.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
    expect(secondResult.outcome).toBe('success');
  });

  it('runs the fixed 360-cell schedule through the real offline workflow adapter', async () => {
    jest.useFakeTimers();
    const plan = buildBenchmarkPlan(validation);
    const pending = runBenchmark({
      validation,
      plan,
      runId: 'workflow-fixed-schedule',
      mode: 'offline',
      codeVersion: 'workflow-test',
      configVersion: 'workflow-fixtures',
      now: Date.now,
      executeCell: createProductionBenchmarkCellExecutor(),
      limits: { credits: 15_000, httpDispatches: 1_500, elapsedMs: 7_200_000 }
    });
    await jest.runAllTimersAsync();
    const bundle = await pending;
    expect(bundle.report.cells).toHaveLength(360);
    expect(bundle.report.runStatus).toBe('offline_passed');
    expect(bundle.report.metrics.publisher.successes).toBe(40);
    expect(bundle.report.metrics.scholar.successes).toBe(20);
    expect(bundle.report.cells.filter(cell => cell.mode === 'comparison' && cell.pdfVerification === 'verified')).toHaveLength(0);
    expect(bundle.report.attempts.some(attempt => attempt.role === 'redirect')).toBe(true);
    expect(bundle.report.attempts.some(attempt => attempt.role === 'provider_api')).toBe(true);
  });

  it('rejects overlapping cell execution instead of mixing fixture ownership', async () => {
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'publisher' && candidate.combination === 'static:datacenter')!;
    const first = createContext('workflow-overlap-first', 'offline', cell);
    const second = createContext('workflow-overlap-second', 'offline', cell);
    let started!: () => void;
    const providerStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: (response: BenchmarkWorkflowFixtureResponse) => void;
    const providerResponse = new Promise<BenchmarkWorkflowFixtureResponse>(resolve => { release = resolve; });
    let providerRequest: BenchmarkWorkflowFixtureRequest | undefined;
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        if (request.role === 'provider_api') {
          providerRequest = request;
          started();
          return providerResponse;
        }
        return publisherResolver(request);
      }
    });
    const pending = executor(cell, validation.corpus.publisher[0], first.context);
    await providerStarted;
    await expect(executor(cell, validation.corpus.publisher[0], second.context)).rejects.toThrow(/one active cell/i);
    release(publisherResolver(providerRequest!));
    const result = await pending;
    first.finish();
    second.finish();
    expect(result.outcome).toBe('success');
    expect(first.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
    expect(second.attempts).toHaveLength(0);
  });

  it('keeps the real operation timeout at 120 seconds even with a longer run', async () => {
    jest.useFakeTimers();
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'production' && candidate.sampleKind === 'scholar')!;
    const harness = createContext('workflow-operation-timeout-cap', 'offline', cell, undefined, 7_200_000);
    let queryCalls = 0;
    const executor = createProductionBenchmarkCellExecutor({
      delay: async () => undefined,
      resolveFixture: request => {
        if (request.role === 'init') return {
          status: 429,
          headers: { 'Retry-After': '180' },
          data: '<html>rate limited</html>'
        };
        if (request.role === 'page') {
          queryCalls++;
          return { status: 200, data: '<html></html>' };
        }
        return { status: 200, data: '' };
      }
    });
    const pending = executor(cell, validation.corpus.scholar[0], harness.context);
    await jest.runAllTimersAsync();
    const result = await pending;
    harness.finish();
    expect(result.outcome).toBe('failed');
    expect(queryCalls).toBe(0);
    expect(harness.attempts.filter(attempt => attempt.role === 'init')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(0);
  });

  it('runs the real Scholar production retry and paid fallback path', async () => {
    jest.useFakeTimers();
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'production' && candidate.sampleKind === 'scholar')!;
    const sample = validation.corpus.scholar[0];
    const harness = createContext('workflow-scholar-fallback', 'offline', cell);
    let directPageCalls = 0;
    let paidCalls = 0;
    let providerSawCookie = false;
    const executor = createProductionBenchmarkCellExecutor({
      delay: async () => undefined,
      retrySleep: async () => undefined,
      resolveFixture: request => {
        if (request.role === 'init') return { status: 200, headers: { 'set-cookie': ['SESSION=fixture; Path=/'] }, data: '<html>home</html>' };
        if (request.role === 'page' && request.transport === 'direct') {
          directPageCalls++;
          throw new Error('fixture network failure');
        }
        if (request.role === 'provider_api') {
          paidCalls++;
          providerSawCookie = Object.keys(request.headers).some(name => name.toLowerCase() === 'cookie');
          const results = [sample.expected.title, 'Other result one', 'Other result two', 'Other result three', 'Other result four']
            .map((title, index) => `<div class="gs_ri"><h3 class="gs_rt"><a href="https://fixture-papers.example/result-${index}">${title}</a></h3><div class="gs_a">Author - Journal, 2024</div><div class="gs_rs">Abstract</div></div>`)
            .join('');
          const html = results;
          return {
            status: 200,
            headers: { 'Ant-credits-cost': String(request.estimatedCredits) },
            data: JSON.stringify({ html, status_code: 200 })
          };
        }
        return { status: 200, data: '' };
      }
    });
    const pending = executor(cell, sample, harness.context);
    await jest.runAllTimersAsync();
    const result = await pending;
    harness.finish();
    expect(result.outcome).toBe('success');
    expect(result.match).toBe('matched');
    expect(directPageCalls).toBeGreaterThan(1);
    expect(paidCalls).toBe(1);
    expect(providerSawCookie).toBe(false);
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
  });

  it('uses the real Scholar session requester/parser and one comparison query page', async () => {
    jest.useFakeTimers();
    const plan = buildBenchmarkPlan(validation);
    const cell = plan.cells.find(candidate => candidate.mode === 'comparison' && candidate.sampleKind === 'scholar' && candidate.combination === 'direct')!;
    const sample = validation.corpus.scholar[0];
    const harness = createContext('workflow-scholar-comparison', 'offline', cell);
    const seenHeaders: Readonly<Record<string, unknown>>[] = [];
    const executor = createProductionBenchmarkCellExecutor({
      resolveFixture: request => {
        seenHeaders.push(request.headers);
        if (request.role === 'init') {
          return {
            status: 200,
            headers: { 'set-cookie': ['SESSION_FIXTURE=ready; Path=/; Domain=scholar.google.com'] },
            data: '<html>home</html>'
          };
        }
        if (request.role === 'page') {
          const title = sample.expected.title;
          const html = `<div class="gs_ri"><h3 class="gs_rt"><a href="https://fixture-papers.example/result">${title}</a></h3><div class="gs_a">Author - Journal, 2024</div><div class="gs_rs">Abstract</div></div>`;
          return { status: 200, data: `<html><body>${html}</body></html>` };
        }
        return { status: 200, data: '' };
      }
    });
    const pending = executor(cell, sample, harness.context);
    await jest.advanceTimersByTimeAsync(4_000);
    const result = await pending;
    harness.finish();
    expect(result.outcome).toBe('success');
    expect(result.match).toBe('matched');
    expect(harness.attempts.filter(attempt => attempt.role === 'init')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(seenHeaders.some(headers => Object.keys(headers).some(name => name.toLowerCase() === 'cookie'))).toBe(true);
  });
});
