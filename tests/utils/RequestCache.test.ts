import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { RequestCache } from '../../src/utils/RequestCache.js';

describe('RequestCache', () => {
  let cache: RequestCache<string>;

  beforeEach(() => {
    cache = new RequestCache<string>({
      maxSize: 3,
      ttlMs: 1000 // 1 second for testing
    });
  });

  describe('generateKey', () => {
    it('should generate consistent keys for same inputs', () => {
      const key1 = cache.generateKey('platform', 'query', { opt: 'value' });
      const key2 = cache.generateKey('platform', 'query', { opt: 'value' });

      expect(key1).toBe(key2);
    });

    it('should generate different keys for different inputs', () => {
      const key1 = cache.generateKey('platform1', 'query', {});
      const key2 = cache.generateKey('platform2', 'query', {});
      const key3 = cache.generateKey('platform1', 'query2', {});
      const key4 = cache.generateKey('platform1', 'query', { opt: 'value' });

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).not.toBe(key4);
    });

    it('should be case-insensitive for query', () => {
      const key1 = cache.generateKey('platform', 'Query', {});
      const key2 = cache.generateKey('platform', 'query', {});

      expect(key1).toBe(key2);
    });

    it('should trim whitespace from query', () => {
      const key1 = cache.generateKey('platform', '  query  ', {});
      const key2 = cache.generateKey('platform', 'query', {});

      expect(key1).toBe(key2);
    });
  });

  describe('get and set', () => {
    it('should cache and retrieve values', () => {
      const key = cache.generateKey('platform', 'query', {});

      cache.set(key, 'test-value');
      const value = cache.get(key);

      expect(value).toBe('test-value');
    });

    it('should return undefined for non-existent keys', () => {
      const key = cache.generateKey('platform', 'nonexistent', {});
      const value = cache.get(key);

      expect(value).toBeUndefined();
    });

    it('should track cache hits and misses', () => {
      const key = cache.generateKey('platform', 'query', {});

      // Miss
      cache.get(key);
      let stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(1);

      // Set and hit
      cache.set(key, 'value');
      cache.get(key);
      stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', async () => {
      const key = cache.generateKey('platform', 'query', {});

      cache.set(key, 'test-value');
      expect(cache.get(key)).toBe('test-value');

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      const value = cache.get(key);
      expect(value).toBeUndefined();
    });

    it('should not expire entries before TTL', async () => {
      const key = cache.generateKey('platform', 'query', {});

      cache.set(key, 'test-value');

      // Wait less than TTL
      await new Promise(resolve => setTimeout(resolve, 500));

      const value = cache.get(key);
      expect(value).toBe('test-value');
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used when cache is full', () => {
      const key1 = cache.generateKey('platform', 'query1', {});
      const key2 = cache.generateKey('platform', 'query2', {});
      const key3 = cache.generateKey('platform', 'query3', {});
      const key4 = cache.generateKey('platform', 'query4', {});

      // Fill cache to max size (3)
      cache.set(key1, 'value1');
      cache.set(key2, 'value2');
      cache.set(key3, 'value3');

      // All should be present
      expect(cache.get(key1)).toBe('value1');
      expect(cache.get(key2)).toBe('value2');
      expect(cache.get(key3)).toBe('value3');

      // Adding 4th should evict key1 (least recently used)
      cache.set(key4, 'value4');

      expect(cache.get(key1)).toBeUndefined();
      expect(cache.get(key2)).toBe('value2');
      expect(cache.get(key3)).toBe('value3');
      expect(cache.get(key4)).toBe('value4');
    });

    it('should update LRU order on get', () => {
      const key1 = cache.generateKey('platform', 'query1', {});
      const key2 = cache.generateKey('platform', 'query2', {});
      const key3 = cache.generateKey('platform', 'query3', {});
      const key4 = cache.generateKey('platform', 'query4', {});

      cache.set(key1, 'value1');
      cache.set(key2, 'value2');
      cache.set(key3, 'value3');

      // Access key1 to make it recently used
      cache.get(key1);

      // Adding key4 should evict key2 (now least recently used)
      cache.set(key4, 'value4');

      expect(cache.get(key1)).toBe('value1');
      expect(cache.get(key2)).toBeUndefined();
      expect(cache.get(key3)).toBe('value3');
      expect(cache.get(key4)).toBe('value4');
    });
  });

  describe('has and delete', () => {
    it('should check if key exists', () => {
      const key = cache.generateKey('platform', 'query', {});

      expect(cache.has(key)).toBe(false);

      cache.set(key, 'value');
      expect(cache.has(key)).toBe(true);
    });

    it('should delete entries', () => {
      const key = cache.generateKey('platform', 'query', {});

      cache.set(key, 'value');
      expect(cache.has(key)).toBe(true);

      const deleted = cache.delete(key);
      expect(deleted).toBe(true);
      expect(cache.has(key)).toBe(false);
    });

    it('should return false when deleting non-existent key', () => {
      const key = cache.generateKey('platform', 'nonexistent', {});

      const deleted = cache.delete(key);
      expect(deleted).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all entries', () => {
      const key1 = cache.generateKey('platform', 'query1', {});
      const key2 = cache.generateKey('platform', 'query2', {});

      cache.set(key1, 'value1');
      cache.set(key2, 'value2');

      expect(cache.getStats().size).toBe(2);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
      expect(cache.get(key1)).toBeUndefined();
      expect(cache.get(key2)).toBeUndefined();
    });

    it('should reset hit/miss statistics', () => {
      const key = cache.generateKey('platform', 'query', {});

      cache.get(key); // miss
      cache.set(key, 'value');
      cache.get(key); // hit

      let stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);

      cache.clear();

      stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const key1 = cache.generateKey('platform', 'query1', {});
      const key2 = cache.generateKey('platform', 'query2', {});

      cache.get(key1); // miss
      cache.set(key1, 'value1');
      cache.get(key1); // hit
      cache.get(key2); // miss

      const stats = cache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(3);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(1/3, 2);
    });

    it('should handle zero total accesses', () => {
      const stats = cache.getStats();

      expect(stats.hitRate).toBe(0);
    });
  });
});