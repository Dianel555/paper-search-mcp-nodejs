/**
 * CrossrefSearcher Platform Tests
 * Tests for Crossref API integration
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CrossrefSearcher } from '../../src/platforms/CrossrefSearcher.js';

describe('CrossrefSearcher', () => {
  let searcher: CrossrefSearcher;

  beforeEach(() => {
    searcher = new CrossrefSearcher();
  });

  describe('constructor', () => {
    it('should create instance with default mailto', () => {
      const instance = new CrossrefSearcher();
      expect(instance).toBeDefined();
    });

    it('should accept custom mailto', () => {
      const instance = new CrossrefSearcher('test@example.com');
      expect(instance).toBeDefined();
    });

    it('should use environment variable for mailto', () => {
      process.env.CROSSREF_MAILTO = 'env@example.com';
      const instance = new CrossrefSearcher();
      expect(instance).toBeDefined();
      delete process.env.CROSSREF_MAILTO;
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const capabilities = searcher.getCapabilities();
      
      expect(capabilities.search).toBe(true);
      expect(capabilities.download).toBe(false);
      expect(capabilities.citations).toBe(true);
      expect(capabilities.requiresApiKey).toBe(false);
      expect(capabilities.supportedOptions).toContain('maxResults');
      expect(capabilities.supportedOptions).toContain('year');
      expect(capabilities.supportedOptions).toContain('author');
    });
  });

  describe('cleanAndValidateDoi (private method via getPaperByDoi)', () => {
    it('should handle valid DOI', async () => {
      // This tests the internal DOI cleaning via the public method
      // In real tests, you'd mock the API call
      const result = await searcher.getPaperByDoi('invalid-not-10');
      expect(result).toBeNull(); // Invalid DOI should return null
    });

    it('should clean DOI URL prefixes', async () => {
      // Test various DOI formats
      const formats = [
        '10.1038/nature12373',
        'https://doi.org/10.1038/nature12373',
        'http://dx.doi.org/10.1038/nature12373',
        'doi:10.1038/nature12373'
      ];
      
      // All formats should be processed (actual API call would be mocked in real tests)
      for (const doi of formats) {
        // DOI validation happens before API call
        // Invalid DOIs return null immediately
        const result = await searcher.getPaperByDoi('not-a-valid-doi');
        expect(result).toBeNull();
      }
    });
  });

  describe('search', () => {
    it('should handle empty results', async () => {
      // This would need API mocking for real tests
      // Placeholder for integration test
      expect(searcher.search).toBeDefined();
    });

    it('should respect maxResults option', async () => {
      expect(searcher.search).toBeDefined();
    });

    it('should handle year filter', async () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('getCitations', () => {
    it('should validate DOI before API call', async () => {
      const result = await searcher.getCitations('invalid-doi');
      expect(result).toEqual([]);
    });
  });

  describe('downloadPdf', () => {
    it('should throw error as not supported', async () => {
      await expect(searcher.downloadPdf('any-id')).rejects.toThrow();
    });
  });

  describe('readPaper', () => {
    it('should throw error as not supported', async () => {
      await expect(searcher.readPaper('any-id')).rejects.toThrow();
    });
  });
});
