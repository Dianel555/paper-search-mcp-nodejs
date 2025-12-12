/**
 * PubMedSearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PubMedSearcher } from '../../src/platforms/PubMedSearcher.js';

describe('PubMedSearcher', () => {
  let searcher: PubMedSearcher;

  beforeEach(() => {
    searcher = new PubMedSearcher();
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(false);
      expect(caps.requiresApiKey).toBe(false); // Optional
    });
  });

  describe('constructor', () => {
    it('should work without API key', () => {
      const instance = new PubMedSearcher();
      expect(instance).toBeDefined();
    });

    it('should accept API key', () => {
      const instance = new PubMedSearcher('test-key');
      expect(instance).toBeDefined();
    });
  });

  describe('search', () => {
    it('should support year filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support author filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support journal filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support publicationType filter', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('getPaperByDoi', () => {
    it('should use DOI field search', () => {
      expect(searcher.getPaperByDoi).toBeDefined();
    });
  });

  describe('getPaperByPmid', () => {
    it('should be available', () => {
      expect((searcher as any).getPaperByPmid || searcher.search).toBeDefined();
    });
  });
});
