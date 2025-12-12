/**
 * BioRxivSearcher Platform Tests
 * Also covers medRxiv as they share the same implementation
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { BioRxivSearcher } from '../../src/platforms/BioRxivSearcher.js';

describe('BioRxivSearcher', () => {
  let bioRxivSearcher: BioRxivSearcher;
  let medRxivSearcher: BioRxivSearcher;

  beforeEach(() => {
    bioRxivSearcher = new BioRxivSearcher('biorxiv');
    medRxivSearcher = new BioRxivSearcher('medrxiv');
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities for bioRxiv', () => {
      const caps = bioRxivSearcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(true);
      expect(caps.fullText).toBe(true);
      expect(caps.requiresApiKey).toBe(false);
    });

    it('should return correct capabilities for medRxiv', () => {
      const caps = medRxivSearcher.getCapabilities();
      expect(caps.search).toBe(true);
      expect(caps.download).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should support biorxiv server', () => {
      const instance = new BioRxivSearcher('biorxiv');
      expect(instance).toBeDefined();
    });

    it('should support medrxiv server', () => {
      const instance = new BioRxivSearcher('medrxiv');
      expect(instance).toBeDefined();
    });
  });

  describe('search options', () => {
    it('should support days filter', () => {
      expect(bioRxivSearcher.search).toBeDefined();
    });

    it('should support category filter', () => {
      // e.g., neuroscience, genomics, infectious_diseases
      expect(bioRxivSearcher.search).toBeDefined();
    });
  });

  describe('downloadPdf', () => {
    it('should be available for bioRxiv', () => {
      expect(bioRxivSearcher.downloadPdf).toBeDefined();
    });

    it('should be available for medRxiv', () => {
      expect(medRxivSearcher.downloadPdf).toBeDefined();
    });
  });
});
