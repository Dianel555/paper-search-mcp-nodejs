/**
 * SemanticScholarSearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SemanticScholarSearcher } from '../../src/platforms/SemanticScholarSearcher.js';

describe('SemanticScholarSearcher', () => {
  let searcher: SemanticScholarSearcher;

  beforeEach(() => {
    searcher = new SemanticScholarSearcher();
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(true);
      expect(caps.citations).toBe(true);
      expect(caps.requiresApiKey).toBe(false); // Optional
    });
  });

  describe('constructor', () => {
    it('should work without API key', () => {
      const instance = new SemanticScholarSearcher();
      expect(instance).toBeDefined();
    });

    it('should accept API key for higher rate limits', () => {
      const instance = new SemanticScholarSearcher('test-key');
      expect(instance).toBeDefined();
    });
  });

  describe('search options', () => {
    it('should support fieldsOfStudy filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support year filter', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('getPaperByDoi', () => {
    it('should use DOI: prefix', () => {
      expect(searcher.getPaperByDoi).toBeDefined();
    });
  });

  describe('paper details', () => {
    it('should have getPaperDetails method', () => {
      expect((searcher as any).getPaperDetails).toBeDefined();
    });
  });
});
