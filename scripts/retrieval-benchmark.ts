#!/usr/bin/env node

import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  benchmarkCliExitCode,
  benchmarkFilesystemStem,
  buildBenchmarkPlan,
  createLiveBenchmarkCellExecutor,
  createOfflineCellExecutor,
  createProductionBenchmarkCellExecutor,
  acquireBenchmarkRunFileLock,
  preflightLiveBenchmark,
  runBenchmark,
  validateBenchmarkIdentifier,
  validateBenchmarkCorpus,
  type BenchmarkCorpus
} from '../src/retrieval/benchmark/index.js';
import { PublicSourceDispatchScheduler } from '../src/services/PublicSourceDispatchScheduler.js';
import { parseRetrievalConfiguration } from '../src/retrieval/Configuration.js';

const DEFAULT_CORPUS = resolve(process.cwd(), 'tests/fixtures/retrieval-benchmark/corpus.json');

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const live = args.has('--live');
  const workflow = args.has('--workflow');
  const authorized = args.has('--authorize-live');
  const scholarProxyAuthorized = args.has('--authorize-scholar-proxy');
  const corpusPath = valueAfter('--corpus') || DEFAULT_CORPUS;
  const raw = JSON.parse(await readFile(corpusPath, 'utf8')) as BenchmarkCorpus;
  const validation = validateBenchmarkCorpus(raw);
  const plan = buildBenchmarkPlan(validation);

  if (live && !authorized) {
    process.stdout.write(JSON.stringify({
      status: 'blocked',
      reason: 'not_authorized',
      corpusVersion: validation.corpusVersion,
      plannedCells: plan.cells.length
    }, null, 2) + '\n');
    process.exitCode = 2;
    return;
  }

  const preflightOnly = args.has('--preflight-only');
  if (preflightOnly && !live) throw new Error('--preflight-only requires --live');
  if (scholarProxyAuthorized && !live) throw new Error('--authorize-scholar-proxy requires --live');
  const requestedRunId = valueAfter('--run-id');
  if (live && !requestedRunId) {
    process.stdout.write(JSON.stringify({
      status: 'blocked',
      reason: 'run_id_required',
      corpusVersion: validation.corpusVersion,
      plannedCells: plan.cells.length
    }, null, 2) + '\n');
    process.exitCode = 2;
    return;
  }
  const runId = requestedRunId || `offline-${process.pid}`;
  const codeVersion = valueAfter('--code-version') || 'working-tree';
  const configVersion = valueAfter('--config-version')
    || (live ? preflightOnly ? 'live-preflight-v1' : 'live-production-v1' : workflow ? 'offline-production-workflow-v1' : 'offline-accounting-simulator-v1');
  validateBenchmarkIdentifier(runId, 'runId');
  validateBenchmarkIdentifier(codeVersion, 'codeVersion');
  validateBenchmarkIdentifier(configVersion, 'configVersion');
  const fileLock = live
    ? await acquireBenchmarkRunFileLock(runId, valueAfter('--run-dir') || resolve(process.cwd(), '.retrieval-benchmark-runs'))
    : undefined;

  try {
    // Offline commands never load deployment credentials. Live configuration
    // is loaded only after the explicit command-line authorization gate.
    if (live) dotenv.config();
    const liveConfiguration = live ? parseRetrievalConfiguration() : undefined;
    let livePreflight: Awaited<ReturnType<typeof preflightLiveBenchmark>> | undefined;
    if (live) {
      livePreflight = await preflightLiveBenchmark(validation, {
        configuration: liveConfiguration,
        plannedCells: plan.cells.length,
        scholarProxyApproved: scholarProxyAuthorized
      });
      if (!livePreflight.ready) {
        process.stderr.write(`retrieval-benchmark: live preflight blocked: ${livePreflight.reasons.join('; ')}\n`);
      } else if (preflightOnly) {
        process.stderr.write('retrieval-benchmark: live preflight passed; execution skipped (--preflight-only)\n');
      }
    }

    const liveExecutor = live ? createLiveBenchmarkCellExecutor({ configuration: liveConfiguration }) : undefined;
    const workflowClock = { value: Date.now() };
    const workflowNow = () => workflowClock.value;
    const workflowScheduler = new PublicSourceDispatchScheduler({
      now: workflowNow,
      sleep: async (milliseconds, signal) => {
        if (signal?.aborted) {
          const error = new Error('Operation aborted');
          error.name = 'AbortError';
          throw error;
        }
        workflowClock.value += Math.max(0, milliseconds);
      }
    });
    const offlineWorkflowExecutor = createProductionBenchmarkCellExecutor({
      sourceScheduler: workflowScheduler,
      now: workflowNow,
      delay: async () => undefined,
      retrySleep: async () => undefined
    });
    const bundle = await runBenchmark({
      validation,
      plan,
      runId,
      mode: live ? 'live' : 'offline',
      codeVersion,
      configVersion,
      executeCell: live
        ? liveExecutor!
        : workflow ? offlineWorkflowExecutor : createOfflineCellExecutor(),
      now: !live && workflow ? workflowNow : undefined,
      prerequisitesReady: live ? livePreflight!.ready && !preflightOnly : true
    });
    await persistArtifacts(bundle, valueAfter('--output-dir'));

    if (args.has('--json')) process.stdout.write(`${bundle.json}\n`);
    else process.stdout.write(`${bundle.markdown}`);
    process.exitCode = benchmarkCliExitCode(bundle.report.mode, bundle.report.runStatus);
  } finally {
    await fileLock?.close(true);
  }
}

async function persistArtifacts(
  bundle: Awaited<ReturnType<typeof runBenchmark>>,
  directory: string | undefined
): Promise<void> {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const artifactStem = benchmarkFilesystemStem(bundle.report.runId);
  const jsonPath = resolve(directory, `${artifactStem}.json`);
  const markdownPath = resolve(directory, `${artifactStem}.md`);
  const written: string[] = [];
  try {
    for (const [path, content] of [[jsonPath, bundle.json], [markdownPath, bundle.markdown]] as const) {
      const handle = await open(path, 'wx');
      written.push(path);
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    await Promise.all(written.map(path => unlink(path).catch(() => undefined)));
    throw error;
  }
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`retrieval-benchmark: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
