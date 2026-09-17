export type BenchmarkCliMode = 'offline' | 'live';
export type BenchmarkCliStatus = 'offline_passed' | 'live_passed' | 'failed' | 'blocked' | 'incomplete';

/** Live automation must fail closed on blocked, failed, or incomplete reports. */
export function benchmarkCliExitCode(mode: BenchmarkCliMode, status: BenchmarkCliStatus): number {
  return mode === 'live' && status !== 'live_passed' ? 2 : 0;
}
