import type { Paper } from '../models/Paper.js';
import { hasSensitiveCandidateCredentials, isSensitiveOutboundTarget } from '../retrieval/OutboundSecurityPolicy.js';

export const SCHOLAR_REFERENCE_TTL_MS = 300_000;
export const SCHOLAR_REFERENCE_CACHE_CAPACITY = 256;

export interface ScholarReferenceSnapshot {
  readonly platform: 'googlescholar';
  readonly paperId: string;
  readonly doi?: string;
  readonly url: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly year?: number;
  readonly journal?: string;
}

type CacheEntry =
  | {
    readonly kind: 'reference';
    readonly reference: ScholarReferenceSnapshot;
    readonly createdAt: number;
  }
  | {
    readonly kind: 'ambiguous';
    readonly createdAt: number;
    readonly expiresAt: number;
  };

export type ScholarReferenceLookupStatus = 'hit' | 'missing' | 'expired' | 'ambiguous' | 'rejected';

export interface ScholarReferenceLookup {
  readonly status: ScholarReferenceLookupStatus;
  readonly reference?: ScholarReferenceSnapshot;
}

export interface ScholarReferencePutResult {
  readonly status: 'stored' | 'ambiguous' | 'rejected';
  readonly reference?: ScholarReferenceSnapshot;
}

export interface ScholarReferenceCacheOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/**
 * A per-handler, bounded cache of safe Scholar result references.
 *
 * It intentionally stores no HTML, cookies, provider session, operation, or
 * cost state. The handler owns the instance, so a disposed MCP connection can
 * invalidate the complete namespace without touching the process-level searchers.
 */
export class ScholarReferenceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private disposed = false;

  constructor(options: ScholarReferenceCacheOptions = {}) {
    this.now = options.now || Date.now;
    this.ttlMs = Number.isSafeInteger(options.ttlMs) && (options.ttlMs as number) > 0
      ? options.ttlMs as number
      : SCHOLAR_REFERENCE_TTL_MS;
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && (options.maxEntries as number) > 0
      ? options.maxEntries as number
      : SCHOLAR_REFERENCE_CACHE_CAPACITY;
  }

  put(paper: Paper): ScholarReferencePutResult {
    if (this.disposed) return { status: 'rejected' };
    const reference = snapshotPaper(paper);
    if (!reference) return { status: 'rejected' };

    const now = this.now();
    this.removeExpired(now);
    const key = cacheKey(reference.paperId);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.kind === 'ambiguous') {
        if (now >= existing.expiresAt) {
          this.entries.delete(key);
        } else {
          return { status: 'rejected' };
        }
      } else if (!sameReference(existing.reference, reference)) {
        this.entries.delete(key);
        this.entries.set(key, {
          kind: 'ambiguous',
          createdAt: existing.createdAt,
          expiresAt: existing.createdAt + this.ttlMs
        });
        return { status: 'ambiguous' };
      } else {
        // A new search publication is a new write, but reads never refresh TTL.
        this.entries.delete(key);
        this.entries.set(key, { kind: 'reference', reference, createdAt: now });
        return { status: 'stored', reference };
      }
    }

    if (!this.makeRoom()) return { status: 'rejected' };
    this.entries.set(key, { kind: 'reference', reference, createdAt: now });
    return { status: 'stored', reference };
  }

  get(paperId: string): ScholarReferenceLookup {
    if (this.disposed || typeof paperId !== 'string' || !paperId.trim()) return { status: 'missing' };
    const key = cacheKey(paperId);
    const entry = this.entries.get(key);
    if (!entry) return { status: 'missing' };
    const now = this.now();
    if (entry.kind === 'ambiguous') {
      if (now - entry.createdAt >= this.ttlMs || now >= entry.expiresAt) {
        this.entries.delete(key);
        return { status: 'expired' };
      }
      // Tombstones are pinned and therefore never move in the LRU order.
      return { status: 'ambiguous' };
    }
    if (now - entry.createdAt >= this.ttlMs) {
      this.entries.delete(key);
      return { status: 'expired' };
    }
    if (!isSafeReferenceUrl(entry.reference.url)) {
      return { status: 'rejected' };
    }
    // Only ordinary entries participate in LRU ordering. createdAt remains
    // unchanged, so this operation cannot extend the TTL.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { status: 'hit', reference: cloneReference(entry.reference) };
  }

  /** Alias used by composition code that treats the cache as a lookup store. */
  lookup(paperId: string): ScholarReferenceLookup {
    return this.get(paperId);
  }

  clear(): void {
    this.entries.clear();
  }

  dispose(): void {
    this.entries.clear();
    this.disposed = true;
  }

  get size(): number {
    return this.entries.size;
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.kind === 'ambiguous'
        ? now - entry.createdAt >= this.ttlMs || now >= entry.expiresAt
        : now - entry.createdAt >= this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private makeRoom(): boolean {
    if (this.entries.size < this.maxEntries) return true;
    for (const [key, entry] of this.entries) {
      if (entry.kind === 'reference') {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}

function cacheKey(paperId: string): string {
  return `googlescholar\u0000${paperId.trim()}`;
}

function snapshotPaper(paper: Paper): ScholarReferenceSnapshot | undefined {
  if (!paper || typeof paper.paperId !== 'string' || !paper.paperId.trim()) return undefined;
  if (typeof paper.url !== 'string' || !isSafeReferenceUrl(paper.url)) return undefined;
  return {
    platform: 'googlescholar',
    paperId: paper.paperId.trim(),
    ...(paper.doi ? { doi: paper.doi.trim() } : {}),
    url: canonicalizeUrl(paper.url),
    title: typeof paper.title === 'string' ? paper.title.slice(0, 2048) : '',
    authors: Array.isArray(paper.authors) ? paper.authors.filter((value): value is string => typeof value === 'string').slice(0, 64) : [],
    ...(typeof paper.year === 'number' && Number.isSafeInteger(paper.year) ? { year: paper.year } : {}),
    ...(typeof paper.journal === 'string' && paper.journal ? { journal: paper.journal.slice(0, 512) } : {})
  };
}

function isSafeReferenceUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (hasSensitiveCandidateCredentials(parsed.toString())) return false;
    if (isSensitiveOutboundTarget(parsed.toString())) return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function canonicalizeUrl(value: string): string {
  const parsed = new URL(value.trim());
  parsed.hash = '';
  return parsed.toString();
}

function sameReference(left: ScholarReferenceSnapshot, right: ScholarReferenceSnapshot): boolean {
  return left.url === right.url
    && (left.doi || '') === (right.doi || '')
    && left.title === right.title
    && left.authors.join('\u0000') === right.authors.join('\u0000')
    && (left.year || null) === (right.year || null)
    && (left.journal || '') === (right.journal || '');
}

function cloneReference(reference: ScholarReferenceSnapshot): ScholarReferenceSnapshot {
  return {
    ...reference,
    authors: [...reference.authors]
  };
}

export default ScholarReferenceCache;
