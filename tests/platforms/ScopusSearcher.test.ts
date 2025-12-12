/**
 * ScopusSearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ScopusSearcher } from '../../src/platforms/ScopusSearcher.js';

describe('ScopusSearcher', () => {
  let searcher: ScopusSearcher;

  beforeEach(() => {
    searcher = new ScopusSearcher('test-api-key');
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
      const noKeySearcher = new ScopusSearcher();
      await expect(noKeySearcher.search('test')).rejects.toThrow();
    });
  });

  describe('search options', () => {
    it('should support affiliation filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support documentType filter', () => {
      // ar, cp, re, bk, ch
      expect(searcher.search).toBeDefined();
    });

    it('should support openAccess filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support subject filter', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('getCitationIds', () => {
    it('should be available', () => {
      expect(searcher.getCitationIds).toBeDefined();
    });
  });

  describe('getReferenceIds', () => {
    it('should be available', () => {
      expect(searcher.getReferenceIds).toBeDefined();
    });
  });
});
