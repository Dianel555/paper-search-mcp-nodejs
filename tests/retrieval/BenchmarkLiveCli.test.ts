import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { benchmarkCliExitCode } from '../../src/retrieval/benchmark/cli.js';
import { benchmarkFilesystemStem } from '../../src/retrieval/benchmark/identifier.js';

const execFileAsync = promisify(execFile);

interface CommandError {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

describe('live benchmark CLI', () => {
  it('returns a nonzero exit for every non-passed live report', () => {
    expect(benchmarkCliExitCode('live', 'blocked')).toBe(2);
    expect(benchmarkCliExitCode('live', 'incomplete')).toBe(2);
    expect(benchmarkCliExitCode('live', 'failed')).toBe(2);
    expect(benchmarkCliExitCode('live', 'live_passed')).toBe(0);
    expect(benchmarkCliExitCode('offline', 'failed')).toBe(0);
  });

  it('requires an explicit live run ID before creating a lock marker', async () => {
    const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'paper-benchmark-cli-'));
    const runDir = join(root, 'runs');
    const command = process.execPath;
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    try {
      let commandError: CommandError | undefined;
      try {
        await execFileAsync(command, [
          tsxCli,
          'scripts/retrieval-benchmark.ts',
          '--live',
          '--authorize-live',
          '--preflight-only',
          '--run-dir',
          runDir,
          '--json'
        ], { cwd: process.cwd(), env: process.env, maxBuffer: 2 * 1024 * 1024 });
      } catch (error) {
        commandError = error as CommandError;
      }
      expect(commandError?.code).toBe(2);
      expect(JSON.parse(commandError?.stdout || '{}')).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'run_id_required',
        plannedCells: 360
      }));
      await expect(readdir(runDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a privacy-sensitive run ID before creating a lock marker', async () => {
    const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'paper-benchmark-cli-'));
    const runDir = join(root, 'runs');
    const command = process.execPath;
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    try {
      let commandError: CommandError | undefined;
      try {
        await execFileAsync(command, [
          tsxCli,
          'scripts/retrieval-benchmark.ts',
          '--live',
          '--authorize-live',
          '--preflight-only',
          '--run-id',
          'authorization:review',
          '--run-dir',
          runDir,
          '--json'
        ], { cwd: process.cwd(), env: process.env, maxBuffer: 2 * 1024 * 1024 });
      } catch (error) {
        commandError = error as CommandError;
      }
      expect(commandError?.code).toBe(1);
      expect(commandError?.stderr).toContain('runId is not a safe bounded identifier');
      await expect(readdir(runDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the authorized preflight path without dispatching when capabilities are incomplete', async () => {
    const root = await mkdtemp(join(process.env.TEMP || process.env.TMP || '.', 'paper-benchmark-cli-'));
    const runDir = join(root, 'runs');
    const outputDir = join(root, 'output');
    const runId = `live-cli-smoke-${process.pid}-${Date.now()}`;
    const env = {
      ...process.env,
      SCRAPINGANT_API_KEY: 'smoke-key-without-output',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
      SCRAPINGANT_ALLOW_RESIDENTIAL: '',
      SCRAPINGANT_PROXY_TYPE: 'datacenter',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '500',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '100',
      SCHOLAR_PROXY: '',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      ALL_PROXY: '',
      https_proxy: '',
      http_proxy: '',
      all_proxy: ''
    };
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    try {
      await execFileAsync(process.execPath, [
        tsxCli,
        'scripts/retrieval-benchmark.ts',
        '--live',
        '--authorize-live',
        '--preflight-only',
        '--run-id',
        runId,
        '--run-dir',
        runDir,
        '--output-dir',
        outputDir,
        '--json'
      ], {
        cwd: process.cwd(),
        env,
        maxBuffer: 2 * 1024 * 1024
      });
      throw new Error('Expected live preflight to be blocked');
    } catch (error) {
      const commandError = error as CommandError;
      expect(commandError.code).toBe(2);
      expect(commandError.stderr).toContain('live preflight blocked');
      const report = JSON.parse(commandError.stdout || '{}') as {
        mode?: string;
        runStatus?: string;
        cells?: unknown[];
        httpDispatchCount?: number;
        admissionUsed?: number;
        attempts?: unknown[];
      };
      expect(report).toEqual(expect.objectContaining({
        mode: 'live',
        runStatus: 'blocked',
        httpDispatchCount: 0,
        admissionUsed: 0
      }));
      expect(report.cells).toHaveLength(360);
      expect(report.attempts).toHaveLength(0);
      const files = await readFile(join(outputDir, `${benchmarkFilesystemStem(runId)}.json`), 'utf8');
      expect(JSON.parse(files)).toEqual(report);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
