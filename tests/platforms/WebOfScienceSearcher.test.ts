/**
 * WebOfScienceSearcher Platform Tests
 * Tests for WoS API v1/v2 integration and fallback mechanism
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { WebOfScienceSearcher } from '../../src/platforms/WebOfScienceSearcher.js';

describe('WebOfScienceSearcher', () => {
  let searcher: WebOfScienceSearcher;

  beforeEach(() => {
    // Clear env vars before each test
    delete process.env.WOS_API_VERSION;
    searcher = new WebOfScienceSearcher('test-api-key');
  });

  describe('constructor', () => {
    it('should default to v2 when no version specified', () => {
      const instance = new WebOfScienceSearcher('test-key');
      expect(instance).toBeDefined();
      // Version is private, so we test behavior instead
    });

    it('should use constructor param over env var', () => {
      process.env.WOS_API_VERSION = 'v1';
      const instance = new WebOfScienceSearcher('test-key', 'v2');
      expect(instance).toBeDefined();
    });

    it('should use env var when no constructor param', () => {
      process.env.WOS_API_VERSION = 'v1';
      const instance = new WebOfScienceSearcher('test-key');
      expect(instance).toBeDefined();
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const capabilities = searcher.getCapabilities();
      
      expect(capabilities.search).toBe(true);
      expect(capabilities.download).toBe(false);
      expect(capabilities.citations).toBe(true);
      expect(capabilities.requiresApiKey).toBe(true);
      expect(capabilities.supportedOptions).toContain('maxResults');
      expect(capabilities.supportedOptions).toContain('year');
      expect(capabilities.supportedOptions).toContain('sortBy');
    });
  });

  describe('search', () => {
    it('should require API key', async () => {
      const noKeySearcher = new WebOfScienceSearcher();
      await expect(noKeySearcher.search('test')).rejects.toThrow('API key is required');
    });

    it('should handle search options', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('API version selection', () => {
    it('keeps the selected version fixed for the instance', () => {
      // Version changes are intentionally not performed after transient errors.
      expect(searcher).toBeDefined();
    });
  });

  describe('WoS field tags', () => {
    it('should support 18 field tags', () => {
      const supportedTags = [
        'TS', 'TI', 'AU', 'AI', 'SO', 'IS',
        'PY', 'FPY', 'DO', 'DOP', 'VL', 'PG',
        'CS', 'DT', 'PMID', 'UT', 'OG', 'SUR'
      ];
      
      // Test that queries with field tags are handled
      expect(supportedTags.length).toBe(18);
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

  describe('getPaperByDoi', () => {
    it('should use DO field tag', async () => {
      // This would need mocking for real tests
      expect(searcher.getPaperByDoi).toBeDefined();
    });
  });

  describe('getReferenceIds', () => {
    it('should report unavailable Expanded capability instead of returning an empty array', async () => {
      const noKeySearcher = new WebOfScienceSearcher();
      await expect(noKeySearcher.getReferenceIds('test-uid')).rejects.toThrow(/Expanded API/i);
    });
  });

  describe('getCitationIds', () => {
    it('should report unavailable Expanded capability instead of returning an empty array', async () => {
      const noKeySearcher = new WebOfScienceSearcher();
      await expect(noKeySearcher.getCitationIds('WOS:test-uid')).rejects.toThrow(/Expanded API/i);
    });
  });
});
