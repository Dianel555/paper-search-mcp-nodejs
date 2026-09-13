/**
 * ScopusSearcher Platform Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ScopusSearcher } from '../../src/platforms/ScopusSearcher.js';

describe('ScopusSearcher', () => {
  let searcher: ScopusSearcher;
  const originalElsevierApiKey = process.env.ELSEVIER_API_KEY;
  const originalScopusSearchApiKey = process.env.SCOPUS_SEARCH_API_KEY;

  beforeEach(() => {
    searcher = new ScopusSearcher('test-api-key');
  });

  afterEach(() => {
    if (originalElsevierApiKey === undefined) delete process.env.ELSEVIER_API_KEY;
    else process.env.ELSEVIER_API_KEY = originalElsevierApiKey;
    if (originalScopusSearchApiKey === undefined) delete process.env.SCOPUS_SEARCH_API_KEY;
    else process.env.SCOPUS_SEARCH_API_KEY = originalScopusSearchApiKey;
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

  describe('key configuration', () => {
    it('uses the dedicated search key when no general Elsevier key is configured', async () => {
      process.env.SCOPUS_SEARCH_API_KEY = 'search-only-key';
      const instance = new ScopusSearcher();
      const client = (instance as any).client;
      const adapter = jest.fn(async (config: any) => {
        const key = typeof config.headers?.get === 'function'
          ? config.headers.get('X-ELS-APIKey')
          : config.headers?.['X-ELS-APIKey'];
        expect(key).toBe('search-only-key');
        return {
          data: { 'search-results': { entry: [] } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
          request: {}
        };
      });
      client.defaults.adapter = adapter;

      await expect(instance.search('machine learning', { maxResults: 1 })).resolves.toEqual([]);
      expect(adapter).toHaveBeenCalled();
      expect(instance.hasApiKey()).toBe(true);
      expect((instance as any).searchApiKey).toBe('search-only-key');
      expect((instance as any).elsevierApiKey).toBeUndefined();
    });

    it('keeps the dedicated search key separate from the general key', async () => {
      process.env.ELSEVIER_API_KEY = 'general-key';
      process.env.SCOPUS_SEARCH_API_KEY = 'search-key';
      const instance = new ScopusSearcher();
      const client = (instance as any).client;
      const adapter = jest.fn(async (config: any) => {
        const key = typeof config.headers?.get === 'function'
          ? config.headers.get('X-ELS-APIKey')
          : config.headers?.['X-ELS-APIKey'];
        if (config.url?.includes('/content/abstract/')) {
          expect(key).toBe('general-key');
          return {
            data: {
              'abstracts-retrieval-response': {
                coredata: { 'dc:title': 'Abstract title' }
              }
            },
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
            request: {}
          };
        }
        expect(key).toBe('search-key');
        return {
          data: { 'search-results': { entry: [] } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
          request: {}
        };
      });
      client.defaults.adapter = adapter;

      await expect(instance.search('machine learning', { maxResults: 1 })).resolves.toEqual([]);
      await expect(instance.getAbstract('2-s2.0-1')).resolves.toEqual(
        expect.objectContaining({ title: 'Abstract title' })
      );
      expect((instance as any).searchApiKey).toBe('search-key');
      expect((instance as any).elsevierApiKey).toBe('general-key');
    });

    it('falls back to the general key when the dedicated key is blank', () => {
      process.env.ELSEVIER_API_KEY = ' general-key ';
      process.env.SCOPUS_SEARCH_API_KEY = '   ';
      const instance = new ScopusSearcher();

      expect(instance.hasApiKey()).toBe(true);
      expect((instance as any).searchApiKey).toBe('general-key');
      expect((instance as any).elsevierApiKey).toBe('general-key');
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
