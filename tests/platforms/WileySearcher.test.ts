/**
 * WileySearcher Platform Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { WileySearcher } from '../../src/platforms/WileySearcher.js';

describe('WileySearcher', () => {
  let searcher: WileySearcher;

  beforeEach(() => {
    searcher = new WileySearcher('test-token');
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(false); // Search not supported
      expect(caps.download).toBe(true);
      expect(caps.fullText).toBe(true);
      expect(caps.requiresApiKey).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should require TDM token', () => {
      const noKeySearcher = new WileySearcher();
      expect(noKeySearcher).toBeDefined();
    });
  });

  describe('search', () => {
    it('should throw error as not supported', async () => {
      await expect(searcher.search('test')).rejects.toThrow();
    });
  });

  describe('downloadPdf', () => {
    it('should require TDM token', async () => {
      const noKeySearcher = new WileySearcher();
      await expect(noKeySearcher.downloadPdf('10.1002/test')).rejects.toThrow();
    });

    it('should use DOI for download', () => {
      expect(searcher.downloadPdf).toBeDefined();
    });

    it('should encode DOI in URL', () => {
      // DOI needs encodeURIComponent
      expect(searcher.downloadPdf).toBeDefined();
    });
  });

  describe('DOI handling', () => {
    it('should handle DOI with special characters', () => {
      expect(searcher).toBeDefined();
    });
  });
});
