import { createHash } from 'node:crypto';
import { sanitizeDoi } from '../../utils/SecurityUtils.js';
import { hasSensitiveCandidateCredentials } from '../OutboundSecurityPolicy.js';
import type {
  BenchmarkCorpus,
  BenchmarkCorpusValidation,
  PublisherBenchmarkSample,
  ScholarBenchmarkSample
} from './types.js';
import type { BenchmarkMatch } from './types.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLACEHOLDER = /(?:example\.(?:com|org|net)|placeholder|dummy|lorem|invalid\b|test\b|sample\b|10\.1000\/)/i;
const DOI_TOKEN = /10\.\d{4,}(?:\.\d+)*\/[A-Za-z0-9][A-Za-z0-9._;()\-:]*/gi;

export class BenchmarkCorpusError extends Error {
  readonly code = 'benchmark_corpus_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkCorpusError';
  }
}

export interface BenchmarkCorpusValidationOptions {
  readonly requireComplete?: boolean;
}

export function normalizeBenchmarkTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeBenchmarkDoi(value: string): string | undefined {
  const result = sanitizeDoi(value);
  return result.valid ? result.sanitized.toLowerCase() : undefined;
}

export function validateBenchmarkCorpus(
  input: unknown,
  options: BenchmarkCorpusValidationOptions = {}
): BenchmarkCorpusValidation {
  if (!isRecord(input)) throw new BenchmarkCorpusError('Corpus must be an object');
  const publisher = readArray(input.publisher, 'publisher');
  const scholar = readArray(input.scholar, 'scholar');
  const requireComplete = options.requireComplete !== false;
  if (requireComplete && publisher.length !== 20) {
    throw new BenchmarkCorpusError(`Publisher corpus must contain exactly 20 samples; received ${publisher.length}`);
  }
  if (requireComplete && scholar.length !== 10) {
    throw new BenchmarkCorpusError(`Scholar corpus must contain exactly 10 samples; received ${scholar.length}`);
  }

  const seenIds = new Set<string>();
  const seenDois = new Set<string>();
  const publisherSamples = publisher.map((value, index) => {
    const sample = validatePublisherSample(value, index);
    if (seenIds.has(sample.sampleId)) throw new BenchmarkCorpusError(`Duplicate sampleId: ${sample.sampleId}`);
    seenIds.add(sample.sampleId);
    const doi = normalizeBenchmarkDoi(sample.doi);
    if (!doi) throw new BenchmarkCorpusError(`Invalid publisher DOI at index ${index}`);
    if (seenDois.has(doi)) throw new BenchmarkCorpusError(`Duplicate publisher DOI: ${doi}`);
    seenDois.add(doi);
    return { ...sample, doi };
  });
  const scholarSamples = scholar.map((value, index) => {
    const sample = validateScholarSample(value, index);
    if (seenIds.has(sample.sampleId)) throw new BenchmarkCorpusError(`Duplicate sampleId: ${sample.sampleId}`);
    seenIds.add(sample.sampleId);
    return {
      ...sample,
      expected: {
        ...sample.expected,
        ...(sample.expected.doi ? { doi: normalizeRequiredDoi(sample.expected.doi, `scholar DOI at index ${index}`) } : {})
      }
    };
  });

  const publisherHosts = [...new Set(publisherSamples.flatMap(sample => [
    getPublicHost(sample.evidenceUrl),
    ...sample.candidateUrls.map(getPublicHost)
  ]))].sort();
  if (requireComplete && publisherHosts.length < 5) {
    throw new BenchmarkCorpusError(`Publisher corpus must cover at least five public hosts; received ${publisherHosts.length}`);
  }

  const corpus: BenchmarkCorpus = {
    ...(typeof input.corpusVersion === 'string' ? { corpusVersion: input.corpusVersion } : {}),
    publisher: publisherSamples,
    scholar: scholarSamples
  };
  const corpusVersion = hashCorpus(corpus);
  if (corpus.corpusVersion !== undefined && corpus.corpusVersion !== corpusVersion) {
    throw new BenchmarkCorpusError('corpusVersion does not match the normalized frozen corpus');
  }
  return { corpus, corpusVersion, publisherHosts };
}

export function matchPublisherCandidate(
  sample: PublisherBenchmarkSample,
  candidateUrl: string | undefined
): BenchmarkMatch {
  if (!candidateUrl) return 'not_evaluated';
  let serialized: string;
  try {
    serialized = new URL(candidateUrl).toString();
  } catch {
    return 'mismatched';
  }
  return sample.candidateUrls.includes(serialized) ? 'matched' : 'mismatched';
}

export function matchScholarIdentity(
  sample: ScholarBenchmarkSample,
  result: { readonly doi?: string | null; readonly title?: string | null }
): BenchmarkMatch {
  const resultDoi = result.doi ? normalizeBenchmarkDoi(result.doi) : undefined;
  const expectedDoi = sample.expected.doi ? normalizeBenchmarkDoi(sample.expected.doi) : undefined;
  if (expectedDoi && result.doi) return expectedDoi === resultDoi ? 'matched' : 'mismatched';
  if (!result.title) return 'mismatched';
  return normalizeBenchmarkTitle(result.title) === normalizeBenchmarkTitle(sample.expected.title)
    ? 'matched'
    : 'mismatched';
}

export function hashCorpus(corpus: BenchmarkCorpus): string {
  const canonical = JSON.stringify({
    publisher: corpus.publisher.map(sample => ({
      sampleId: sample.sampleId,
      kind: sample.kind,
      doi: normalizeRequiredDoi(sample.doi, sample.sampleId),
      expectedTitle: normalizeBenchmarkTitle(sample.expectedTitle),
      evidenceUrl: sample.evidenceUrl,
      candidateUrls: [...sample.candidateUrls]
    })),
    scholar: corpus.scholar.map(sample => ({
      sampleId: sample.sampleId,
      kind: sample.kind,
      query: sample.query,
      expected: {
        ...(sample.expected.doi ? { doi: normalizeRequiredDoi(sample.expected.doi, sample.sampleId) } : {}),
        title: normalizeBenchmarkTitle(sample.expected.title)
      },
      evidenceUrl: sample.evidenceUrl
    }))
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function validatePublisherSample(value: unknown, index: number): PublisherBenchmarkSample {
  if (!isRecord(value)) throw new BenchmarkCorpusError(`Publisher sample ${index} must be an object`);
  const sampleId = readSafeId(value.sampleId, `publisher sample ${index} sampleId`);
  const doi = readString(value.doi, `publisher sample ${sampleId} DOI`);
  const normalizedDoi = normalizeBenchmarkDoi(doi);
  if (!normalizedDoi || isPlaceholder(doi)) throw new BenchmarkCorpusError(`Publisher sample ${sampleId} has a placeholder or invalid DOI`);
  if (value.expectedDoi !== undefined && normalizeRequiredDoi(readString(value.expectedDoi, `${sampleId} expectedDoi`), `${sampleId} expectedDoi`) !== normalizedDoi) {
    throw new BenchmarkCorpusError(`Publisher sample ${sampleId} has conflicting DOI evidence`);
  }
  const expectedTitle = readNonEmpty(value.expectedTitle, `publisher sample ${sampleId} expectedTitle`);
  const evidenceUrl = validatePublicEvidenceUrl(value.evidenceUrl, `${sampleId} evidenceUrl`);
  assertNoConflictingDoi(evidenceUrl, normalizedDoi, `${sampleId} evidenceUrl`);
  const candidateValue = value.candidateUrls;
  if (!Array.isArray(candidateValue) || candidateValue.length === 0) {
    throw new BenchmarkCorpusError(`Publisher sample ${sampleId} must include candidateUrls`);
  }
  const candidateUrls = candidateValue.map((candidate, candidateIndex) => {
    const candidateUrl = validatePublicEvidenceUrl(candidate, `${sampleId} candidateUrls[${candidateIndex}]`);
    assertNoConflictingDoi(candidateUrl, normalizedDoi, `${sampleId} candidateUrls[${candidateIndex}]`);
    return candidateUrl;
  });
  if (new Set(candidateUrls).size !== candidateUrls.length) {
    throw new BenchmarkCorpusError(`Publisher sample ${sampleId} contains duplicate candidate URLs`);
  }
  return {
    sampleId,
    kind: 'publisher',
    doi: normalizedDoi,
    ...(value.expectedDoi === undefined ? {} : { expectedDoi: normalizedDoi }),
    expectedTitle,
    evidenceUrl,
    candidateUrls
  };
}

function validateScholarSample(value: unknown, index: number): ScholarBenchmarkSample {
  if (!isRecord(value)) throw new BenchmarkCorpusError(`Scholar sample ${index} must be an object`);
  const sampleId = readSafeId(value.sampleId, `scholar sample ${index} sampleId`);
  const query = readNonEmpty(value.query, `scholar sample ${sampleId} query`);
  if (/[\x00-\x1f\x7f]/.test(query) || query.length > 256 || /(?:password|authorization|cookie|access_token|session=)/i.test(query)) {
    throw new BenchmarkCorpusError(`Scholar sample ${sampleId} contains unsafe private query content`);
  }
  if (!isRecord(value.expected)) throw new BenchmarkCorpusError(`Scholar sample ${sampleId} expected identity is required`);
  const title = readNonEmpty(value.expected.title, `scholar sample ${sampleId} expected title`);
  if (value.expected.doi !== undefined) normalizeRequiredDoi(readString(value.expected.doi, `${sampleId} expected DOI`), `${sampleId} expected DOI`);
  const evidenceUrl = validatePublicEvidenceUrl(value.evidenceUrl, `${sampleId} evidenceUrl`);
  return {
    sampleId,
    kind: 'scholar',
    query,
    expected: {
      ...(value.expected.doi === undefined ? {} : { doi: readString(value.expected.doi, `${sampleId} expected DOI`) }),
      title
    },
    evidenceUrl
  };
}

function validatePublicEvidenceUrl(value: unknown, label: string): string {
  const url = readString(value, label);
  if (isPlaceholder(url) || hasSensitiveCandidateCredentials(url)) {
    throw new BenchmarkCorpusError(`${label} is a placeholder or contains credentials`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BenchmarkCorpusError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateLiteral(parsed.hostname)) {
    throw new BenchmarkCorpusError(`${label} is not a public HTTPS evidence URL`);
  }
  const doiTokens = url.match(DOI_TOKEN) || [];
  for (const token of doiTokens) {
    if (token.toLowerCase() === '10.1000/test') throw new BenchmarkCorpusError(`${label} contains a placeholder DOI`);
  }
  return parsed.toString();
}

function assertNoConflictingDoi(value: string, expectedDoi: string, label: string): void {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // URL syntax has already been validated; leave malformed escapes to the
    // ordinary exact URL comparison instead of guessing an identity.
  }
  for (const token of decoded.match(DOI_TOKEN) || []) {
    const normalized = normalizeBenchmarkDoi(token.replace(/\.pdf$/i, '').replace(/[),.;]+$/, ''));
    if (normalized && normalized !== expectedDoi) {
      throw new BenchmarkCorpusError(`${label} contains a DOI that conflicts with the sample identity`);
    }
  }
}

function getPublicHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'invalid';
  }
}

function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new BenchmarkCorpusError(`${label} must be an array`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new BenchmarkCorpusError(`${label} must be a string`);
  return value;
}

function readNonEmpty(value: unknown, label: string): string {
  const text = readString(value, label).trim();
  if (!text) throw new BenchmarkCorpusError(`${label} must not be empty`);
  return text;
}

function readSafeId(value: unknown, label: string): string {
  const text = readNonEmpty(value, label);
  if (!SAFE_ID.test(text)) throw new BenchmarkCorpusError(`${label} is not a safe bounded identifier`);
  return text;
}

function normalizeRequiredDoi(value: string, label: string): string {
  const normalized = normalizeBenchmarkDoi(value);
  if (!normalized || isPlaceholder(value)) throw new BenchmarkCorpusError(`${label} is invalid or a placeholder`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
