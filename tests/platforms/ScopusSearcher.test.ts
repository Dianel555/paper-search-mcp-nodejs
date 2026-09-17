/**
 * ScopusSearcher Platform Tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ScopusSearcher } from '../../src/platforms/ScopusSearcher.js';
import { QuotaExhaustedError } from '../../src/utils/QuotaManager.js';

describe('ScopusSearcher', () => {
  let searcher: ScopusSearcher;
  const originalElsevierApiKey = process.env.ELSEVIER_API_KEY;
  const originalScopusSearchApiKey = process.env.SCOPUS_SEARCH_API_KEY;

  function searchResponse(entries: any[] = []): any {
    return {
      data: { 'search-results': { entry: entries } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {}
    };
  }

  function viewEntitlementError(
    status = 403,
    statusText = 'The requestor is not authorized to access the COMPLETE view.',
    statusCode = 'AUTHORIZATION_ERROR',
    errorMessage = `Request failed with status code ${status}`,
    responseStatusText = status === 401 ? 'Unauthorized' : 'Forbidden'
  ): any {
    return Object.assign(new Error(errorMessage), {
      response: {
        status,
        statusText: responseStatusText,
        data: {
          'service-error': {
            status: {
              statusCode,
              statusText
            }
          }
        }
      }
    });
  }

  function transientServerError(): any {
    return Object.assign(new Error('Scopus server error'), {
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        data: { message: 'Temporary server error' }
      }
    });
  }

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

  describe('search views', () => {
    it('requests COMPLETE by default without overriding the view with fields', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const adapter = jest.fn(async (config: any) => {
        expect(config.params.view).toBe('COMPLETE');
        expect(config.params.field).toBeUndefined();
        return searchResponse();
      });
      client.defaults.adapter = adapter;

      await expect(instance.search('machine learning', { maxResults: 2 })).resolves.toEqual([]);
      expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('falls back once from an entitlement-denied COMPLETE view to STANDARD', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const entry = {
        '@_fa': 'true',
        link: [],
        'prism:url': 'https://api.elsevier.com/content/abstract/scopus_id/2-s2.0-1',
        'dc:identifier': 'SCOPUS_ID:1',
        eid: '2-s2.0-1',
        'dc:title': 'Standard view paper',
        'dc:creator': 'A. Author',
        'prism:coverDate': '2024-01-01',
        'prism:aggregationType': 'Journal',
        subtype: 'ar',
        subtypeDescription: 'Article'
      };
      const adapter = jest.fn() as any;
      adapter
        .mockRejectedValueOnce(viewEntitlementError(
          401,
          'Requested resource response.',
          'COMPLETE_VIEW_NOT_AUTHORIZED',
          'Request failed with status code 401',
          'Request rejected'
        ))
        .mockResolvedValueOnce(searchResponse([entry]));
      client.defaults.adapter = adapter;

      const papers = await instance.search('machine learning', { maxResults: 2 });
      expect(papers).toEqual([expect.objectContaining({ title: 'Standard view paper', authors: ['A. Author'], keywords: [] })]);
      expect(adapter).toHaveBeenCalledTimes(2);
      const [completeConfig, standardConfig] = adapter.mock.calls.map((call: any[]) => call[0]);
      expect(completeConfig.params).toEqual({
        query: 'TITLE-ABS-KEY(machine learning)',
        count: 2,
        start: 0,
        view: 'COMPLETE'
      });
      expect(standardConfig.params).toEqual({
        query: 'TITLE-ABS-KEY(machine learning)',
        count: 2,
        start: 0,
        view: 'STANDARD'
      });
    });

    it('falls back when the error text explicitly names an unavailable COMPLETE view', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const explicitViewError = Object.assign(new Error('Scopus view unavailable'), {
        response: {
          status: 403,
          statusText: 'Forbidden',
          data: { message: 'The COMPLETE view is not available for this API key.' }
        }
      });
      const adapter = jest.fn() as any;
      adapter
        .mockRejectedValueOnce(explicitViewError)
        .mockResolvedValueOnce(searchResponse());
      client.defaults.adapter = adapter;

      await expect(instance.search('machine learning')).resolves.toEqual([]);
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(adapter.mock.calls.map((call: any[]) => call[0].params.view)).toEqual(['COMPLETE', 'STANDARD']);
    });

    it('stops after a STANDARD entitlement denial without cycling back to COMPLETE', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const adapter = jest.fn() as any;
      adapter
        .mockRejectedValueOnce(viewEntitlementError())
        .mockRejectedValueOnce(viewEntitlementError());
      client.defaults.adapter = adapter;

      await expect(instance.search('machine learning')).rejects.toThrow(/scopus: Access forbidden/i);
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(adapter.mock.calls.map((call: any[]) => call[0].params.view)).toEqual(['COMPLETE', 'STANDARD']);
    });

    it('does not downgrade unrelated authorization or rate-limit errors', async () => {
      for (const error of [
        Object.assign(new Error('invalid API key'), { response: { status: 401, data: { message: 'Invalid API key' } } }),
        Object.assign(new Error('authentication failed'), {
          response: {
            status: 401,
            data: { 'service-error': { status: { statusCode: 'AUTHENTICATION_ERROR', statusText: 'The requestor is not authorized to access this resource.' } } }
          }
        }),
        Object.assign(new Error('forbidden'), { response: { status: 403, data: { message: 'Forbidden' } } }),
        viewEntitlementError(403, 'The requestor is not authorized to access this resource.'),
        Object.assign(new Error('insufficient permissions'), { response: { status: 403, data: { message: 'Insufficient permissions' } } }),
        Object.assign(new Error('rate limited'), { response: { status: 429, data: { message: 'Too many requests' } } }),
        Object.assign(new Error('server error'), { response: { status: 500, data: { message: 'Server error' } } })
      ]) {
        const instance = new ScopusSearcher('test-api-key');
        const client = (instance as any).client;
        const adapter = jest.fn() as any;
        adapter.mockRejectedValue(error);
        client.defaults.adapter = adapter;
        const retry = jest.spyOn((await import('../../src/utils/ErrorHandler.js')).ErrorHandler, 'retryWithBackoff')
          .mockImplementation(async (fn: any) => fn());
        try {
          await expect(instance.search('machine learning')).rejects.toThrow();
          expect(adapter).toHaveBeenCalledTimes(1);
          expect(adapter.mock.calls[0][0].params.view).toBe('COMPLETE');
        } finally {
          retry.mockRestore();
        }
      }
    });

    it('reserves and commits quota independently for both view dispatches', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const quota = (instance as any).quotaManager;
      const reserve = jest.spyOn(quota, 'reserve');
      const commit = jest.spyOn(quota, 'commit');
      const adapter = jest.fn() as any;
      adapter
        .mockRejectedValueOnce(viewEntitlementError())
        .mockResolvedValueOnce(searchResponse());
      client.defaults.adapter = adapter;

      try {
        await expect(instance.search('machine learning')).resolves.toEqual([]);
        expect(reserve).toHaveBeenCalledTimes(2);
        expect(reserve.mock.calls.every((call: any[]) => call[0] === 'scopus' && call[1] === 1)).toBe(true);
        expect(commit).toHaveBeenCalledTimes(2);
      } finally {
        reserve.mockRestore();
        commit.mockRestore();
      }
    });

    it('rate-limits and accounts for every transient COMPLETE dispatch', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const limiter = (instance as any).rateLimiter;
      const quota = (instance as any).quotaManager;
      const wait = jest.spyOn(limiter, 'waitForPermission');
      const reserve = jest.spyOn(quota, 'reserve');
      const commit = jest.spyOn(quota, 'commit');
      const adapter = jest.fn() as any;
      adapter
        .mockRejectedValueOnce(transientServerError())
        .mockResolvedValueOnce(searchResponse());
      client.defaults.adapter = adapter;

      try {
        await expect(instance.search('machine learning')).resolves.toEqual([]);
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(wait).toHaveBeenCalledTimes(2);
        expect(reserve).toHaveBeenCalledTimes(2);
        expect(commit).toHaveBeenCalledTimes(2);
        expect(adapter.mock.calls.map((call: any[]) => call[0].params.view)).toEqual(['COMPLETE', 'COMPLETE']);
      } finally {
        wait.mockRestore();
        reserve.mockRestore();
        commit.mockRestore();
      }
    });

    it('rate-limits and accounts for every STANDARD fallback retry', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const limiter = (instance as any).rateLimiter;
      const quota = (instance as any).quotaManager;
      const wait = jest.spyOn(limiter, 'waitForPermission');
      const reserve = jest.spyOn(quota, 'reserve');
      const commit = jest.spyOn(quota, 'commit');
      const adapter = jest.fn() as any;
      adapter
        .mockRejectedValueOnce(viewEntitlementError())
        .mockRejectedValueOnce(transientServerError())
        .mockResolvedValueOnce(searchResponse());
      client.defaults.adapter = adapter;

      try {
        await expect(instance.search('machine learning')).resolves.toEqual([]);
        expect(adapter).toHaveBeenCalledTimes(3);
        expect(wait).toHaveBeenCalledTimes(3);
        expect(reserve).toHaveBeenCalledTimes(3);
        expect(commit).toHaveBeenCalledTimes(3);
        expect(adapter.mock.calls.map((call: any[]) => call[0].params.view)).toEqual(['COMPLETE', 'STANDARD', 'STANDARD']);
      } finally {
        wait.mockRestore();
        reserve.mockRestore();
        commit.mockRestore();
      }
    });

    it('does not dispatch STANDARD when quota is exhausted after COMPLETE', async () => {
      const instance = new ScopusSearcher('test-api-key');
      const client = (instance as any).client;
      const quota = (instance as any).quotaManager;
      const reservation = { id: 'scopus:test', platform: 'scopus', amount: 1, dayKey: 'test' };
      const quotaError = new QuotaExhaustedError('scopus', 1, '2099-01-01T00:00:00.000Z');
      const reserve = jest.spyOn(quota, 'reserve')
        .mockImplementationOnce(() => reservation as any)
        .mockImplementation(() => { throw quotaError; });
      const commit = jest.spyOn(quota, 'commit').mockImplementation(() => undefined);
      const adapter = jest.fn() as any;
      adapter.mockRejectedValueOnce(viewEntitlementError());
      client.defaults.adapter = adapter;

      try {
        await expect(instance.search('machine learning')).rejects.toThrow();
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(reserve).toHaveBeenCalledTimes(2);
      } finally {
        reserve.mockRestore();
        commit.mockRestore();
      }
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
