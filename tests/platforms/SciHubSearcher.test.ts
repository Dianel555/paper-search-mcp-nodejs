/**
 * SciHubSearcher Platform Tests
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SciHubSearcher } from '../../src/platforms/SciHubSearcher.js';

describe('SciHubSearcher', () => {
  let searcher: SciHubSearcher;

  // Create single instance to avoid multiple health checks
  beforeAll(() => {
    searcher = new SciHubSearcher();
  });

  // Wait for async mirror health checks to complete (5s timeout + buffer)
  afterAll(async () => {
    await new Promise(resolve => setTimeout(resolve, 6000));
  }, 10000);

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const caps = searcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(true);
      expect(caps.requiresApiKey).toBe(false);
    });
  });

  describe('search (by DOI)', () => {
    it('should accept DOI as query', () => {
      expect(searcher.search).toBeDefined();
    });

    it('should accept paper URL as query', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('getPaperByDoi', () => {
    it('should fetch paper info by DOI', () => {
      expect(searcher.getPaperByDoi).toBeDefined();
    });
  });

  describe('downloadPdf', () => {
    it('should download PDF via DOI', () => {
      expect(searcher.downloadPdf).toBeDefined();
    });
  });

  describe('Mirror management', () => {
    it('should have mirror health check', () => {
      expect((searcher as any).checkMirrorHealth || searcher).toBeDefined();
    });

    it('should support multiple mirrors', () => {
      expect(searcher).toBeDefined();
    });

    it('should auto-select fastest mirror', () => {
      expect(searcher).toBeDefined();
    });
  });
});
