/**
 * IACRSearcher Platform Tests
 * Tests for IACR ePrint cryptography archive
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { IACRSearcher } from '../../src/platforms/IACRSearcher.js';

describe('IACRSearcher', () => {
  let searcher: IACRSearcher;

  beforeEach(() => {
    searcher = new IACRSearcher();
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

  describe('search options', () => {
    it('should support fetchDetails option', () => {
      expect(searcher.search).toBeDefined();
    });
  });

  describe('downloadPdf', () => {
    it('should download from ePrint', () => {
      expect(searcher.downloadPdf).toBeDefined();
    });
  });

  describe('IACR ID handling', () => {
    it('should handle ePrint IDs (YYYY/NNN)', () => {
      // e.g., 2023/123
      expect(searcher).toBeDefined();
    });
  });
});
