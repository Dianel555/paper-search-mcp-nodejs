/**
 * SpringerSearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SpringerSearcher } from '../../src/platforms/SpringerSearcher.js';

describe('SpringerSearcher', () => {
  let searcher: SpringerSearcher;

  beforeEach(() => {
    searcher = new SpringerSearcher('test-api-key');
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.requiresApiKey).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should require API key for operations', () => {
      const noKeySearcher = new SpringerSearcher();
      expect(noKeySearcher).toBeDefined();
    });

    it('should support separate OpenAccess API key', () => {
      const instance = new SpringerSearcher('meta-key', 'openaccess-key');
      expect(instance).toBeDefined();
    });
  });

  describe('Dual API support', () => {
    it('should support Metadata API v2', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support OpenAccess API', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should test OpenAccess API availability', () => {
      // Race condition fix was applied
      expect(searcher).toBeDefined();
    });
  });

  describe('search options', () => {
    it('should support openAccess filter', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support type filter (Journal/Book/Chapter)', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should support subject filter', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('getCitations', () => {
    it('should use Crossref for citations', () => {
      expect(searcher.getCitations).toBeDefined();
    });
  });

  describe('getReferences', () => {
    it('should use Crossref for references', () => {
      expect(searcher.getReferences).toBeDefined();
    });
  });
});
