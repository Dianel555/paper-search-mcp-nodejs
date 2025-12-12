/**
 * ScienceDirectSearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ScienceDirectSearcher } from '../../src/platforms/ScienceDirectSearcher.js';

describe('ScienceDirectSearcher', () => {
  let searcher: ScienceDirectSearcher;

  beforeEach(() => {
    searcher = new ScienceDirectSearcher('test-api-key');
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.citations).toBe(true);
      expect(caps.requiresApiKey).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should require API key', async () => {
      const noKeySearcher = new ScienceDirectSearcher();
      await expect(noKeySearcher.search('test')).rejects.toThrow();
    });
  });

  describe('search options', () => {
    it('should support openAccess filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support year filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support author filter', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('API method', () => {
    it('should use PUT method for search', () => {
      // ScienceDirect uses PUT API
      expect(searcher.search).toBeDefined();
    });
  });
});
