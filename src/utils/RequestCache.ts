import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { logDebug } from './Logger.js';

export interface CacheOptions {
  maxSize?: number;
  ttlMs?: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export class RequestCache<T = any> {
  private cache: any;
  private hits: number = 0;
  private misses: number = 0;

  constructor(options: CacheOptions = {}) {
    const maxSize = options.maxSize || 100;
    const ttlMs = options.ttlMs || 3600000; // 1 hour default

    this.cache = new LRUCache({
      max: maxSize,
      ttl: ttlMs,
      updateAgeOnGet: true,
      updateAgeOnHas: false
    });

    logDebug(`RequestCache initialized: maxSize=${maxSize}, ttl=${ttlMs}ms`);
  }

  generateKey(platform: string, query: string, options?: Record<string, any>): string {
    const data = JSON.stringify({
      platform,
      query: query.toLowerCase().trim(),
      options: options || {}
    });
    return createHash('sha256').update(data).digest('hex');
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.hits++;
      logDebug(`Cache hit: ${key.substring(0, 8)}...`);
      return value;
    }
    this.misses++;
    logDebug(`Cache miss: ${key.substring(0, 8)}...`);
    return undefined;
  }

  set(key: string, value: T): void {
    this.cache.set(key, value);
    logDebug(`Cache set: ${key.substring(0, 8)}...`);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    logDebug('Cache cleared');
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.cache.max,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0
    };
  }
}

export default RequestCache;
