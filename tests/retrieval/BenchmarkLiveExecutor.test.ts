import { describe, expect, it, jest } from '@jest/globals';
import type { AxiosRequestConfig } from 'axios';
import {
  BenchmarkRunAdmission,
  buildBenchmarkPlan,
  createLiveBenchmarkCellExecutor,
  LIVE_FAILURE_DIAGNOSTIC_LIMITS,
  MAX_LIVE_FAILURE_DIAGNOSTIC_CELLS,
  preflightLiveBenchmark,
  runBenchmark,
  runLiveFailureDiagnostics,
  type BenchmarkCellExecutionContext,
  type BenchmarkAttempt,
  type RunReservation
} from '../../src/retrieval/benchmark/index.js';
import { parseRetrievalConfiguration } from '../../src/retrieval/Configuration.js';
import { OutboundSecurityPolicy } from '../../src/retrieval/OutboundSecurityPolicy.js';
import { PublicSourceDispatchScheduler } from '../../src/services/PublicSourceDispatchScheduler.js';
import type { PublicHttpRequester, PublicHttpResponseData } from '../../src/services/PublicHttpClient.js';
import type { ScrapingAntProviderClient } from '../../src/retrieval/ScrapingAntProvider.js';
import type { BenchmarkCell } from '../../src/retrieval/benchmark/types.js';
import corpus from '../fixtures/retrieval-benchmark/corpus.json';
import { validateBenchmarkCorpus } from '../../src/retrieval/benchmark/corpus.js';

const validation = validateBenchmarkCorpus(corpus);
const sample = validation.corpus.publisher[0];
const scholarSample = validation.corpus.scholar[0];
const plan = buildBenchmarkPlan(validation);
const publicValidation = async (url: string) => ({
  url,
  hostname: new URL(url).hostname,
  addresses: [{ address: '93.184.216.34', family: 4 }] as [{ address: string; family: 4 }]
});

interface Harness {
  readonly context: BenchmarkCellExecutionContext;
  readonly attempts: BenchmarkAttempt[];
  readonly finish: () => void;
  readonly cancel: () => void;
}

function createHarness(
  cell: BenchmarkCell,
  limits: { credits: number; httpDispatches: number; elapsedMs: number } = { credits: 500, httpDispatches: 100, elapsedMs: 120_000 },
  now: () => number = Date.now
): Harness {
  const run = new BenchmarkRunAdmission({
    runId: `live-test-${cell.cellId.replaceAll(':', '-')}`,
    mode: 'live',
    startedAt: now(),
    now,
    limits
  });
  const operation = run.createOperation({
    budget: 500,
    maxCreditsPerRequest: 125,
    operationId: `${run.snapshot().runId}:operation`
  });
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
        attemptId: `${run.snapshot().runId}:attempt-${++sequence}`,
        dispatchId: input.dispatchId ?? null,
        cellId: cell.cellId,
        role: input.role,
        combination: input.combination,
        dispatchCombination: input.dispatchCombination,
        submittedAt: new Date(now()).toISOString(),
        elapsedMs: input.elapsedMs ?? 0,
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
    context,
    attempts,
    finish: () => {
      for (const reservation of reservations) {
        if (reservation.settled) continue;
        if (reservation.dispatched) reservation.settle(null);
        else reservation.release();
      }
      controller.abort();
    },
    cancel: () => controller.abort()
  };
}

function publisherHtml(): string {
  return `<html><head><link rel="alternate" type="application/pdf" href="${sample.candidateUrls[0]}"></head><body>${sample.expectedTitle}</body></html>`;
}

function directRequester(statusForPage = 200, requests: Array<{ url: string; method: string }> = []): PublicHttpRequester {
  return {
    request: async (config: AxiosRequestConfig): Promise<PublicHttpResponseData> => {
      const url = String(config.url || '');
      requests.push({ url, method: String(config.method || 'GET').toUpperCase() });
      if (new URL(url).hostname === 'doi.org') {
        return { status: 302, headers: { location: sample.evidenceUrl }, data: '' };
      }
      if (url === sample.evidenceUrl) {
        return { status: statusForPage, headers: { 'content-type': 'text/html' }, data: publisherHtml() };
      }
      if (url === sample.candidateUrls[0]) {
        return { status: 200, headers: { 'content-type': 'application/pdf' }, data: Buffer.from('%PDF-1.7 live test') };
      }
      return { status: 404, headers: {}, data: '' };
    }
  };
}

function paidClient(withBilling = true): ScrapingAntProviderClient {
  return {
    request: async (): Promise<{ status: number; headers: Record<string, string>; data: string }> => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(withBilling ? { 'Ant-credits-cost': '1' } : {})
      },
      data: JSON.stringify({ html: publisherHtml(), status_code: 200 })
    })
  };
}

function scholarHtml(): string {
  return `<html><body><div class="gs_ri"><h3 class="gs_rt"><a href="https://scholar-papers.example/attention">${scholarSample.expected.title}</a></h3><div class="gs_a">Vaswani, A. - NeurIPS, 2017 - scholar-papers.example</div><div class="gs_rs">Attention fixture abstract.</div></div></body></html>`;
}

function scholarRequester(): PublicHttpRequester {
  return {
    request: async (config: AxiosRequestConfig): Promise<PublicHttpResponseData> => {
      const url = String(config.url || '');
      if (url === 'https://scholar.google.com') {
        return {
          status: 200,
          headers: { 'set-cookie': ['SCHOLAR_LIVE_TEST=ready; Path=/; Domain=scholar.google.com'] },
          data: '<html><body>Scholar home</body></html>'
        };
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, data: scholarHtml() };
    }
  };
}

function fullPaidConfiguration() {
  return parseRetrievalConfiguration({
    SCRAPINGANT_API_KEY: 'configured-without-output',
    SCRAPINGANT_ENABLED: 'true',
    SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
    SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
    SCRAPINGANT_PROXY_TYPE: 'residential',
    SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '500',
    SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '125'
  });
}

describe('live benchmark executor', () => {
  it('rejects unsafe report metadata before any cell can dispatch', async () => {
    const fields = ['runId', 'codeVersion', 'configVersion'] as const;
    for (const field of fields) {
      let executorCalls = 0;
      await expect(runBenchmark({
        validation,
        plan,
        runId: `live-metadata-validation-${field}`,
        mode: 'live',
        codeVersion: field === 'codeVersion' ? 'authorization:review' : 'code-v1',
        configVersion: field === 'configVersion' ? 'authorization:review' : 'live-test',
        ...(field === 'runId' ? { runId: 'authorization:review' } : {}),
        executeCell: () => {
          executorCalls++;
          return {};
        }
      })).rejects.toMatchObject({ code: 'run_limit' });
      expect(executorCalls).toBe(0);
    }
  });

  it('keeps maximum safe run identifiers reportable with bounded attempt IDs', async () => {
    const runId = 'r'.repeat(128);
    const bundle = await runBenchmark({
      validation,
      plan,
      runId,
      mode: 'offline',
      codeVersion: 'code-v1',
      configVersion: 'config-v1',
      executeCell: (cell, _sample, context) => {
        context.recordHttpDispatch();
        context.recordAttempt({
          role: 'page',
          combination: cell.combination,
          dispatchCombination: cell.combination === 'production' || cell.combination === 'direct'
            ? 'direct' : cell.combination,
          reason: 'none',
          estimate: 0,
          reportedCredits: 0,
          costKnown: true
        });
        return {
          outcome: 'failed' as const,
          stage: 'parse' as const,
          reason: 'parse_failed' as const,
          match: 'not_evaluated' as const,
          pdfVerification: 'not_run' as const,
          localSessionState: 'unknown' as const
        };
      }
    });
    expect(bundle.report.runId).toBe(runId);
    expect(bundle.report.attempts).toHaveLength(360);
    expect(bundle.report.attempts[0].attemptId).toBe('attempt-1');
    expect(bundle.report.attempts.every(attempt => attempt.attemptId.length <= 128)).toBe(true);
  });

  it('rejects the live executor under an offline report label', async () => {
    await expect(runBenchmark({
      validation,
      plan,
      runId: 'live-executor-offline-label',
      mode: 'offline',
      codeVersion: 'live-test',
      configVersion: 'live-test',
      executeCell: createLiveBenchmarkCellExecutor({
        configuration: fullPaidConfiguration(),
        securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
        directRequester: directRequester(),
        scrapingAntClient: paidClient()
      })
    })).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('selects only source failed cells for bounded live diagnostics', async () => {
    const target = plan.cells.find(cell => cell.mode === 'comparison'
      && cell.sampleKind === 'publisher'
      && cell.combination === 'direct')!;
    const failure = {
      outcome: 'failed' as const,
      stage: 'candidate' as const,
      reason: 'parse_failed' as const,
      match: 'not_evaluated' as const,
      pdfVerification: 'not_requested' as const,
      localSessionState: 'unknown' as const
    };
    const source = await runBenchmark({
      validation,
      plan,
      runId: 'live-failure-diagnostic-source',
      mode: 'live',
      codeVersion: 'diagnostic-source',
      configVersion: 'diagnostic-source',
      executeCell: Object.assign(async () => failure, { liveOnly: true as const }),
      shouldExecuteCell: cell => cell.cellId === target.cellId
    });
    const calls: string[] = [];
    const diagnostic = await runLiveFailureDiagnostics(validation, plan, {
      sourceReport: source.report,
      selectedCellIds: [target.cellId],
      runId: 'live-failure-diagnostic-selected',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: async cell => {
        calls.push(cell.cellId);
        return failure;
      }
    });

    expect(calls).toEqual([target.cellId]);
    expect(diagnostic.diagnostic).toBe('live_failure_validation');
    expect(diagnostic.sourceRunId).toBe(source.report.runId);
    expect(diagnostic.selectedFailedCellIds).toEqual([target.cellId]);
    expect(diagnostic.report.cells).toHaveLength(360);
    expect(diagnostic.report.cells.filter(cell => cell.outcome !== 'not_run')).toHaveLength(1);
    expect(diagnostic.report.cells.find(cell => cell.cellId === target.cellId)?.outcome).toBe('failed');
    expect(diagnostic.report.runStatus).toBe('incomplete');
    expect(diagnostic.report.limits).toEqual(LIVE_FAILURE_DIAGNOSTIC_LIMITS);

    await expect(runLiveFailureDiagnostics(validation, plan, {
      sourceReport: source.report,
      selectedCellIds: [plan.cells[1].cellId],
      runId: 'live-failure-diagnostic-not-run',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: async () => ({})
    })).rejects.toMatchObject({ code: 'run_limit' });

    await expect(runLiveFailureDiagnostics(validation, plan, {
      sourceReport: source.report,
      selectedCellIds: ['unknown-cell'],
      runId: 'live-failure-diagnostic-unknown',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: async () => ({})
    })).rejects.toMatchObject({ code: 'run_limit' });

    await expect(runLiveFailureDiagnostics(validation, plan, {
      sourceReport: source.report,
      selectedCellIds: [],
      runId: 'live-failure-diagnostic-empty',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: async () => ({})
    })).rejects.toMatchObject({ code: 'run_limit' });

    const manyFailed = plan.cells.slice(0, MAX_LIVE_FAILURE_DIAGNOSTIC_CELLS + 1).map(cell => cell.cellId);
    const manySource = await runBenchmark({
      validation,
      plan,
      runId: 'live-failure-diagnostic-many-source',
      mode: 'live',
      codeVersion: 'diagnostic-source',
      configVersion: 'diagnostic-source',
      executeCell: Object.assign(async () => ({
        ...failure,
        stage: 'pdf' as const
      }), { liveOnly: true as const }),
      shouldExecuteCell: cell => manyFailed.includes(cell.cellId)
    });
    await expect(runLiveFailureDiagnostics(validation, plan, {
      sourceReport: manySource.report,
      selectedCellIds: manyFailed,
      runId: 'live-failure-diagnostic-over-cap',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: async () => ({})
    })).rejects.toMatchObject({ code: 'run_limit' });

    const offlineSource = await runBenchmark({
      validation,
      plan,
      runId: 'live-failure-diagnostic-offline-source',
      mode: 'offline',
      codeVersion: 'diagnostic-source',
      configVersion: 'diagnostic-source',
      executeCell: async () => failure,
      shouldExecuteCell: cell => cell.cellId === target.cellId
    });
    await expect(runLiveFailureDiagnostics(validation, plan, {
      sourceReport: offlineSource.report,
      selectedCellIds: [target.cellId],
      runId: 'live-failure-diagnostic-offline-report',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: async () => ({})
    })).rejects.toMatchObject({ code: 'not_authorized' });

    const offlineExecutor = Object.assign(async () => failure, { offlineOnly: true as const });
    await expect(runLiveFailureDiagnostics(validation, plan, {
      sourceReport: source.report,
      selectedCellIds: [target.cellId],
      runId: 'live-failure-diagnostic-offline-executor',
      codeVersion: 'diagnostic-selected',
      configVersion: 'diagnostic-selected',
      executeCell: offlineExecutor
    })).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('blocks missing live capabilities before target preflight or dispatch', async () => {
    const validate = jest.fn(publicValidation);
    const preflight = await preflightLiveBenchmark(validation, {
      configuration: parseRetrievalConfiguration({
        SCRAPINGANT_API_KEY: 'configured-without-output',
        SCRAPINGANT_ENABLED: 'true',
        SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
        SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '100'
      }),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: validate })
    });

    expect(preflight.ready).toBe(false);
    expect(preflight.reasons).toEqual(expect.arrayContaining([
      'Residential retrieval is not explicitly authorized within the configured proxy ceiling',
      'The configured per-request credit limit is below the fixed 125-credit comparison price'
    ]));
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects every inherited Scholar proxy alias until TLS review', async () => {
    const names = ['SCHOLAR_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      for (const name of names) {
        process.env[name] = 'configured-proxy-without-output';
        const preflight = await preflightLiveBenchmark(validation, {
          configuration: fullPaidConfiguration(),
          checkTargets: false
        });
        expect(preflight.ready).toBe(false);
        expect(preflight.reasons).toContain('The effective Scholar proxy configuration requires a separate TLS-safe review before live use');
        delete process.env[name];
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('accepts only an explicitly approved, valid Scholar proxy endpoint', async () => {
    const names = ['SCHOLAR_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      process.env.SCHOLAR_PROXY = 'http://approved-proxy.example:8080';
      const approved = await preflightLiveBenchmark(validation, {
        configuration: fullPaidConfiguration(),
        checkTargets: false,
        scholarProxyApproved: true
      });
      expect(approved.ready).toBe(true);

      delete process.env.SCHOLAR_PROXY;
      process.env.HTTPS_PROXY = 'http://ambient-proxy.example:8080';
      const ambientOnly = await preflightLiveBenchmark(validation, {
        configuration: fullPaidConfiguration(),
        checkTargets: false,
        scholarProxyApproved: true
      });
      expect(ambientOnly.ready).toBe(false);
      expect(ambientOnly.reasons).toContain('The effective Scholar proxy configuration requires a separate TLS-safe review before live use');

      process.env.SCHOLAR_PROXY = 'not-a-proxy-url';
      const invalid = await preflightLiveBenchmark(validation, {
        configuration: fullPaidConfiguration(),
        checkTargets: false,
        scholarProxyApproved: true
      });
      expect(invalid.ready).toBe(false);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('accepts purpose-specific residential defaults when no proxy is configured', async () => {
    const names = ['SCHOLAR_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      const preflight = await preflightLiveBenchmark(validation, {
        configuration: parseRetrievalConfiguration({
          SCRAPINGANT_API_KEY: 'configured-without-output',
          SCRAPINGANT_ENABLED: 'true',
          SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
          SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
          SCRAPINGANT_PROXY_TYPE: 'residential'
        }),
        checkTargets: false
      });
      expect(preflight.ready).toBe(true);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('uses real Publisher business logic for a selected paid comparison without PDF or retry', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'static:datacenter')!;
    const harness = createHarness(cell);
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(500),
      scrapingAntClient: paidClient(),
      retrySleep: async () => undefined
    });

    const result = await executor(cell, sample, harness.context);
    expect(result.outcome).toBe('success');
    expect(result.match).toBe('matched');
    expect(result.pdfVerification).toBe('not_requested');
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')).toEqual(expect.objectContaining({
      combination: 'static:datacenter',
      dispatchCombination: 'static:datacenter',
      apiStatus: 200,
      targetStatus: 200,
      reportedCredits: 1,
      costKnown: true
    }));
    harness.finish();
  });

  it('keeps a selected direct comparison to one page attempt when the target fails', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    const harness = createHarness(cell);
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(500),
      scrapingAntClient: paidClient(),
      retrySleep: async () => undefined
    });

    const result = await executor(cell, sample, harness.context);
    expect(result.outcome).toBe('failed');
    expect(harness.attempts.filter(attempt => attempt.role === 'page')).toHaveLength(1);
    expect(harness.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(harness.attempts.filter(attempt => attempt.role === 'pdf')).toHaveLength(0);
    harness.finish();
  });

  it('rejects a third direct dispatch at the run boundary before transport bytes', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    const requests: Array<{ url: string; method: string }> = [];
    const harness = createHarness(cell, { credits: 500, httpDispatches: 2, elapsedMs: 120_000 });
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(200, requests),
      scrapingAntClient: paidClient(),
      retrySleep: async () => undefined
    });

    const result = await executor(cell, sample, harness.context);
    expect(result.outcome).toBe('failed');
    expect(harness.context.run.snapshot().httpDispatchCount).toBe(2);
    expect(requests.filter(request => request.url === sample.evidenceUrl && request.method === 'GET')).toHaveLength(0);
    harness.finish();
  });

  it('keeps missing live billing linked as unknown without closing the run', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'static:datacenter')!;
    const harness = createHarness(cell);
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(500),
      scrapingAntClient: paidClient(false),
      retrySleep: async () => undefined
    });

    await executor(cell, sample, harness.context);
    expect(harness.context.run.snapshot()).toEqual(expect.objectContaining({
      paidClosed: false,
      unknownCostAttempts: 1,
      reportedCostKnown: false
    }));
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')).toEqual(expect.objectContaining({
      reportedCredits: null,
      costKnown: false
    }));
    harness.finish();
  });

  it('attributes provider transport timeout to the paid attempt without leaving it pending', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'static:datacenter')!;
    let clock = 0;
    const harness = createHarness(cell, { credits: 500, httpDispatches: 100, elapsedMs: 120_000 }, () => clock);
    const timeoutClient: ScrapingAntProviderClient = {
      request: async () => {
        clock += 23;
        const error = new Error('provider timeout detail') as Error & { code?: string };
        error.code = 'ETIMEDOUT';
        throw error;
      }
    };
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(500),
      scrapingAntClient: timeoutClient,
      retrySleep: async () => undefined,
      now: () => clock
    });

    const result = await executor(cell, sample, harness.context);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('provider_unavailable');
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')).toEqual(expect.objectContaining({
      reason: 'provider_unavailable',
      failureKind: 'transport_timeout',
      apiStatus: null,
      targetStatus: null,
      elapsedMs: 23
    }));
    harness.finish();
  });

  it('lets final Scholar identity mismatch override an earlier recoverable session error', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'scholar'
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    const harness = createHarness(cell);
    let initializing = true;
    const requester: PublicHttpRequester = {
      request: async (config: AxiosRequestConfig): Promise<PublicHttpResponseData> => {
        const url = String(config.url || '');
        if (initializing && url === 'https://scholar.google.com') {
          initializing = false;
          throw new Error('session transport detail');
        }
        return {
          status: 200,
          headers: {},
          data: url === 'https://scholar.google.com'
            ? '<html><body>Scholar home</body></html>'
            : scholarHtml().replace(scholarSample.expected.title, 'A different paper')
        };
      }
    };
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(),
      scholarRequester: requester,
      scrapingAntClient: paidClient(),
      delay: async () => undefined,
      retrySleep: async () => undefined
    });

    const result = await executor(cell, scholarSample, harness.context);
    expect(result.outcome).toBe('failed');
    expect(result.match).toBe('mismatched');
    expect(result.reason).toBe('identity_mismatch');
    expect(harness.attempts.some(attempt => attempt.role === 'init' && attempt.reason === 'target_failed')).toBe(true);
    expect(harness.attempts.find(attempt => attempt.role === 'page')).toEqual(expect.objectContaining({
      reason: 'none',
      failureKind: null
    }));
    harness.finish();
  });

  it('preserves known billing and API status for a provider API error', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'static:datacenter')!;
    const harness = createHarness(cell);
    const apiErrorClient: ScrapingAntProviderClient = {
      request: async () => ({
        status: 403,
        headers: { 'Ant-credits-cost': '7' },
        data: JSON.stringify({ detail: 'private provider detail' })
      })
    };
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(),
      scrapingAntClient: apiErrorClient,
      retrySleep: async () => undefined
    });

    const result = await executor(cell, sample, harness.context);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('provider_unavailable');
    expect(harness.attempts.find(attempt => attempt.role === 'provider_api')).toEqual(expect.objectContaining({
      apiStatus: 403,
      targetStatus: null,
      reason: 'provider_unavailable',
      failureKind: null,
      reportedCredits: 7,
      costKnown: true
    }));
    harness.finish();
  });

  it('cancels a live cell before any direct dispatch', async () => {
    const cell = plan.cells.find(candidate => candidate.sampleKind === 'publisher'
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    const harness = createHarness(cell);
    harness.cancel();
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      directRequester: directRequester(),
      scrapingAntClient: paidClient()
    });

    const result = await executor(cell, sample, harness.context);
    expect(result.outcome).toBe('failed');
    expect(harness.context.run.snapshot().httpDispatchCount).toBe(0);
    expect(harness.attempts).toHaveLength(0);
    harness.finish();
  });

  it('wires Scholar production sessions and direct comparisons through the real searcher', async () => {
    const productionCells = plan.cells.filter(candidate => candidate.sampleKind === 'scholar'
      && candidate.sampleId === scholarSample.sampleId
      && candidate.mode === 'production');
    const comparisonCell = plan.cells.find(candidate => candidate.sampleKind === 'scholar'
      && candidate.sampleId === scholarSample.sampleId
      && candidate.mode === 'comparison'
      && candidate.combination === 'direct')!;
    let clock = Date.now();
    const now = () => clock;
    const sourceScheduler = new PublicSourceDispatchScheduler({
      now,
      sleep: async milliseconds => {
        clock += milliseconds;
      }
    });
    const executor = createLiveBenchmarkCellExecutor({
      configuration: fullPaidConfiguration(),
      securityPolicy: new OutboundSecurityPolicy({ validatePublicUrl: publicValidation }),
      sourceScheduler,
      now,
      scholarRequester: scholarRequester(),
      scrapingAntClient: paidClient(),
      delay: async () => undefined,
      retrySleep: async () => undefined
    });

    const first = createHarness(productionCells[0]);
    const firstResult = await executor(productionCells[0], scholarSample, first.context);
    expect(firstResult.outcome).toBe('success');
    expect(firstResult.localSessionState).toBe('cold');
    expect(first.attempts.map(attempt => attempt.role)).toEqual(expect.arrayContaining(['init', 'page']));
    expect(first.attempts.find(attempt => attempt.role === 'init')).toEqual(expect.objectContaining({
      reason: 'none',
      failureKind: null
    }));
    first.finish();

    const second = createHarness(productionCells[1]);
    const secondResult = await executor(productionCells[1], scholarSample, second.context);
    expect(secondResult.outcome).toBe('success');
    expect(secondResult.localSessionState).toBe('warm');
    second.finish();

    const comparison = createHarness(comparisonCell);
    const comparisonResult = await executor(comparisonCell, scholarSample, comparison.context);
    expect(comparisonResult.outcome).toBe('success');
    expect(comparison.attempts.filter(attempt => attempt.role === 'provider_api')).toHaveLength(0);
    expect(comparison.attempts.map(attempt => attempt.role)).toEqual(expect.arrayContaining(['init', 'page']));
    comparison.finish();
  });
});
