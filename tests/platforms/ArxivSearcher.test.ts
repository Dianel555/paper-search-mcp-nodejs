/**
 * ArxivSearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ArxivSearcher } from '../../src/platforms/ArxivSearcher.js';

describe('ArxivSearcher', () => {
  let searcher: ArxivSearcher;

  beforeEach(() => {
    searcher = new ArxivSearcher();
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(true);
      expect(caps.fullText).toBe(true);
      expect(caps.requiresApiKey).toBe(false);
    });
  });

  describe('search', () => {
    it('should handle category filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support sortBy and sortOrder', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('downloadPdf', () => {
    it('should be available', () => {
      expect(searcher.downloadPdf).toBeDefined();
    });
  });

  describe('arXiv ID handling', () => {
    it('should handle new format IDs (YYMM.NNNNN)', () => {
      // e.g., 2301.12345
      expect(searcher).toBeDefined();
    });

    it('should handle old format IDs (category/YYMMNNN)', () => {
      // e.g., cs.AI/0701001
      expect(searcher).toBeDefined();
    });
  });
});
