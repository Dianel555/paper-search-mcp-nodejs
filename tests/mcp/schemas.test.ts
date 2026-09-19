/**
 * Schemas Unit Tests
 * Tests for MCP tool argument parsing and validation
 */

import { describe, it, expect } from '@jest/globals';
import { parseToolArgs } from '../../src/mcp/schemas.js';

describe('parseToolArgs', () => {
  describe('search_papers', () => {
    it('should require a query', () => {
      expect(() => parseToolArgs('search_papers', {})).toThrow();
    });

    it('should apply defaults', () => {
      const args = parseToolArgs('search_papers', { query: 'machine learning' });
      expect(args.platform).toBe('crossref');
      expect(args.maxResults).toBe(10);
      expect(args.sortBy).toBe('relevance');
      expect(args.sortOrder).toBe('desc');
    });

    it('should strip unknown fields', () => {
      const args = parseToolArgs('search_papers', {
        query: 'test',
        unexpected: 'should-be-stripped'
      });
      expect(args.unexpected).toBeUndefined();
    });

    it('should cap maxResults at 100', () => {
      expect(() =>
        parseToolArgs('search_papers', { query: 'test', maxResults: 101 })
      ).toThrow();
    });
  });

  describe('search_webofscience', () => {
    it('defaults to Starter and rejects unsupported Starter recordView', () => {
      const args = parseToolArgs('search_webofscience', { query: 'test' });
      expect(args.apiProduct).toBe('starter');
      expect(args.discoverAccess).toBe(false);
      expect(() => parseToolArgs('search_webofscience', { query: 'test', recordView: 'full' })).toThrow();
    });

    it('allows search results above the independent discovery limit', () => {
      const args = parseToolArgs('search_webofscience', { query: 'test', discoverAccess: true, maxResults: 6 });
      expect(args.maxResults).toBe(6);
    });

    it('bounds the independent discovery limit', () => {
      expect(() => parseToolArgs('search_webofscience', { query: 'test', discoverAccess: true, discoverAccessMaxItems: 101 })).toThrow(/discoverAccessMaxItems/i);
    });
  });

  describe('get_webofscience_related_records', () => {
    it('applies relationship defaults and rejects recordView for references', () => {
      const args = parseToolArgs('get_webofscience_related_records', { uid: 'WOS:1', relation: 'citing' });
      expect(args.maxResults).toBe(50);
      expect(args.firstRecord).toBe(1);
      expect(() => parseToolArgs('get_webofscience_related_records', { uid: 'WOS:1', relation: 'references', recordView: 'full' })).toThrow();
    });
  });

  describe('download_paper', () => {
    it('should require paperId and platform', () => {
      expect(() => parseToolArgs('download_paper', { platform: 'arxiv' })).toThrow();
      expect(() => parseToolArgs('download_paper', { paperId: '123' })).toThrow();
    });

    it('should accept a valid savePath', () => {
      const args = parseToolArgs('download_paper', {
        paperId: '2301.00123',
        platform: 'arxiv',
        savePath: './my-downloads'
      });
      expect(args.savePath).toBe('./my-downloads');
    });

    it('should reject invalid platform values', () => {
      expect(() =>
        parseToolArgs('download_paper', { paperId: 'x', platform: 'not-a-platform' })
      ).toThrow();
    });
  });

  describe('public paper tools', () => {
    it('strictly parses and normalizes DOI-backed download and markdown inputs', () => {
      expect(parseToolArgs('download_public_paper', {
        platform: 'publisher',
        paperId: 'doi:10.1000/Test',
        savePath: 'sub'
      })).toEqual({ platform: 'publisher', paperId: '10.1000/Test', savePath: 'sub' });
      expect(parseToolArgs('get_paper_markdown', {
        platform: 'scihub',
        paperId: 'https://doi.org/10.1000/Test'
      })).toEqual({ platform: 'scihub', paperId: '10.1000/Test' });
      expect(parseToolArgs('download_public_paper', {
        platform: 'googlescholar',
        paperId: 'gs_abc_123'
      })).toEqual({ platform: 'googlescholar', paperId: 'gs_abc_123', savePath: './downloads' });
    });

    it('rejects unknown fields, arbitrary URLs, and invalid platform references', () => {
      expect(() => parseToolArgs('download_public_paper', {
        platform: 'publisher', paperId: '10.1000/test', provider: 'scrapingant'
      })).toThrow();
      expect(() => parseToolArgs('get_paper_markdown', {
        platform: 'publisher', paperId: 'https://publisher.example/article'
      })).toThrow(/DOI/i);
      expect(() => parseToolArgs('download_public_paper', {
        platform: 'googlescholar', paperId: 'https://publisher.example/article'
      })).toThrow();
      expect(() => parseToolArgs('get_paper_markdown', {
        platform: 'publisher', paperId: '10.1000/test', savePath: './downloads'
      })).toThrow();
    });
  });

  describe('get_citations', () => {
    it('should require a DOI', () => {
      expect(() => parseToolArgs('get_citations', {})).toThrow();
    });

    it('should apply forceRefresh default', () => {
      const args = parseToolArgs('get_citations', { doi: '10.1038/nature12373' });
      expect(args.forceRefresh).toBe(false);
    });
  });

  describe('get_paper_by_doi', () => {
    it('accepts exactly the declared platform values and applies the all default', () => {
      expect(parseToolArgs('get_paper_by_doi', { doi: '10.1038/nature12373' }).platform).toBe('all');
      for (const platform of ['arxiv', 'webofscience', 'scihub', 'all']) {
        expect(parseToolArgs('get_paper_by_doi', {
          doi: '10.1038/nature12373',
          platform
        }).platform).toBe(platform);
      }
      expect(() => parseToolArgs('get_paper_by_doi', {
        doi: '10.1038/nature12373',
        platform: 'scrapingant'
      })).toThrow();
    });

    it('strips unknown fields without changing the validated DOI route', () => {
      const args = parseToolArgs('get_paper_by_doi', {
        doi: '10.1038/nature12373',
        platform: 'scihub',
        provider: 'scrapingant',
        purpose: 'publisher_discovery',
        budget: 500
      });
      expect(args).toEqual({ doi: '10.1038/nature12373', platform: 'scihub' });
    });
  });

  describe('discover_paper_access', () => {
    it('accepts DOI-only inputs and defaults verification off', () => {
      const args = parseToolArgs('discover_paper_access', { doi: 'https://doi.org/10.1038/nature12373' });
      expect(args.verifyPdf).toBe(false);
    });

    it('rejects arbitrary URLs, DOI userinfo, and unknown fields', () => {
      expect(() => parseToolArgs('discover_paper_access', { doi: 'https://publisher.example/article' })).toThrow(/DOI/i);
      expect(() => parseToolArgs('discover_paper_access', { doi: 'https://user:pass@doi.org/10.1038/nature12373' })).toThrow(/DOI/i);
      expect(() => parseToolArgs('discover_paper_access', { doi: '10.1038/nature12373', provider: 'scrapingant' })).toThrow();
    });
  });

  describe('search_scihub', () => {
    it('should accept a DOI or URL', () => {
      const args = parseToolArgs('search_scihub', { doiOrUrl: '10.1038/nature12373' });
      expect(args.downloadPdf).toBe(false);
    });
  });
});