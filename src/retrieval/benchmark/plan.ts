import {
  BENCHMARK_ROUNDS,
  BENCHMARK_STRATEGIES,
  type BenchmarkCell,
  type BenchmarkPlan,
  type BenchmarkSample
} from './types.js';
import type { BenchmarkCorpusValidation } from './types.js';

/** Build the fixed 60 production + 300 comparison cell plan without I/O. */
export function validateBenchmarkPlan(plan: unknown, validation: BenchmarkCorpusValidation): asserts plan is BenchmarkPlan {
  if (!plan || typeof plan !== 'object' || !Array.isArray((plan as BenchmarkPlan).cells)) {
    throw new Error('Benchmark plan must contain a cell array');
  }
  const expected = buildBenchmarkPlan(validation);
  const actual = plan as BenchmarkPlan;
  if (actual.planVersion !== '1' || actual.cells.length !== expected.cells.length) {
    throw new Error('Benchmark plan does not contain the fixed 360-cell schedule');
  }
  expected.cells.forEach((cell, index) => {
    const candidate = actual.cells[index];
    if (!candidate || JSON.stringify(candidate) !== JSON.stringify(cell)) {
      throw new Error(`Benchmark plan cell ${index} differs from the frozen schedule`);
    }
  });
}

export function buildBenchmarkPlan(validation: BenchmarkCorpusValidation): BenchmarkPlan {
  const cells: BenchmarkCell[] = [];
  const samples: readonly BenchmarkSample[] = [
    ...validation.corpus.publisher,
    ...validation.corpus.scholar
  ];
  for (const round of [0, 1] as const) {
    appendProductionCells(cells, validation.corpus.publisher, round);
    appendProductionCells(cells, validation.corpus.scholar, round);
  }
  for (const round of [0, 1] as const) {
    appendComparisonCells(cells, validation.corpus.publisher, round);
    appendComparisonCells(cells, validation.corpus.scholar, round);
  }

  const expected = BENCHMARK_ROUNDS * samples.length
    + BENCHMARK_ROUNDS * samples.length * BENCHMARK_STRATEGIES.length;
  if (cells.length !== expected) throw new Error(`Benchmark plan has ${cells.length} cells; expected ${expected}`);
  return { planVersion: '1', cells };
}

function appendProductionCells(
  cells: BenchmarkCell[],
  samples: readonly BenchmarkSample[],
  round: 0 | 1
): void {
  for (const sample of samples) {
    cells.push({
      cellId: cellId('production', sample.kind, round, sample.sampleId, 'production'),
      sampleId: sample.sampleId,
      sampleKind: sample.kind,
      round,
      mode: 'production',
      combination: 'production',
      production: sample.kind === 'publisher'
        ? { verifyPdf: true }
        : { verifyPdf: false, maxResults: 5 }
    });
  }
}

function appendComparisonCells(
  cells: BenchmarkCell[],
  samples: readonly BenchmarkSample[],
  round: 0 | 1
): void {
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const offset = (index + round) % BENCHMARK_STRATEGIES.length;
    for (let strategyIndex = 0; strategyIndex < BENCHMARK_STRATEGIES.length; strategyIndex++) {
      const combination = BENCHMARK_STRATEGIES[(strategyIndex + offset) % BENCHMARK_STRATEGIES.length];
      cells.push({
        cellId: cellId('comparison', sample.kind, round, sample.sampleId, combination),
        sampleId: sample.sampleId,
        sampleKind: sample.kind,
        round,
        mode: 'comparison',
        combination,
        production: null
      });
    }
  }
}

function cellId(
  mode: 'production' | 'comparison',
  sampleKind: 'publisher' | 'scholar',
  round: 0 | 1,
  sampleId: string,
  combination: string
): string {
  return `${mode}:${sampleKind}:r${round}:${sampleId}:${combination.replace(':', '-')}`;
}
