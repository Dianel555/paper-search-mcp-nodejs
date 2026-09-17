import { createHash } from 'node:crypto';
import { BenchmarkAdmissionError, type BenchmarkAdmissionErrorCode } from './admission.js';

const SAFE_BENCHMARK_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_BENCHMARK_IDENTIFIER = /(?:https?:\/\/|cookie\s*=|authorization\s*:|bearer\s+)/i;

/** Validate report/lock identifiers before they can reach durable state. */
export function benchmarkFilesystemStem(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded.length <= 200) return `benchmark-${encoded}`;
  return `benchmark-run-${createHash('sha256').update(value).digest('hex')}`;
}

export function validateBenchmarkIdentifier(
  value: unknown,
  label: string,
  errorCode: BenchmarkAdmissionErrorCode = 'run_limit'
): asserts value is string {
  if (typeof value !== 'string'
    || !SAFE_BENCHMARK_IDENTIFIER.test(value)
    || SENSITIVE_BENCHMARK_IDENTIFIER.test(value)) {
    throw new BenchmarkAdmissionError(errorCode, `${label} is not a safe bounded identifier`);
  }
}
