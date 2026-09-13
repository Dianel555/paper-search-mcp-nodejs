/** HTTP-contract regression coverage for both Web of Science products. */

import { describe, expect, it, jest } from '@jest/globals';
import { WebOfScienceSearcher } from '../../src/platforms/WebOfScienceSearcher.js';
import { PaperFactory } from '../../src/models/Paper.js';
import { QuotaManager } from '../../src/utils/QuotaManager.js';
import { parseReferences } from '../../src/services/WebOfScienceParser.js';

function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return { data, status, headers } as any;
}

function makeHttpClient(responses: any[]) {
  const request = jest.fn(async (_config: any) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { request };
}

function fastLimiter() {
  return {
    waitForPermission: jest.fn(async () => undefined),
    getStatus: jest.fn(() => ({ availableTokens: 1, maxTokens: 1, requestsPerSecond: 1, pendingRequests: 0 }))
  };
}

const starterRecord = {
  uid: 'WOS:1',
  title: 'Starter title',
  types: ['Article'],
  sourceTypes: ['Article'],
  source: {
    sourceTitle: 'Journal',
    publishYear: 2024,
    pages: { range: '1-10', begin: '1', end: '10', count: 10 }
  },
  names: { authors: [{ displayName: 'Author One' }] },
  links: {
    record: 'https://www.webofscience.com/record/1',
    references: 'https://www.webofscience.com/references/1'
  },
  citations: [{ db: 'WOS', count: 0 }],
  identifiers: { doi: '10.1000/starter' }
};

const expandedRecord = {
  UID: 'WOS:2',
  static_data: {
    summary: {
      pub_info: { pubyear: 2023, coverdate: '2023-10-01', vol: 2, issue: 3, page: { begin: 4, end: 9, content: '4-9' } },
      titles: { title: [{ type: 'item', content: 'Expanded title' }, { type: 'source', content: 'Expanded Journal' }] },
      names: { name: [{ role: 'author', display_name: 'Author Two' }] },
      doctypes: { doctype: ['Article'] }
    },
    fullrecord_metadata: {
      abstracts: { abstract: { abstract_text: { p: 'Expanded abstract' } } },
      identifiers: { identifier: [{ type: 'doi', value: '10.1000/expanded' }] }
    }
  },
  dynamic_data: {
    citation_related: { tc_list: { silo_tc: [{ coll_id: 'WOS', local_count: 2 }] } },
    cluster_related: { identifiers: { identifier: [{ type: 'doi', value: '10.1000/expanded' }] } }
  }
};

const expandedShortRecord = {
  UID: 'WOS:2',
  static_data: { summary: expandedRecord.static_data.summary },
  dynamic_data: expandedRecord.dynamic_data
};

describe('WebOfScienceSearcher HTTP contracts', () => {
  it('uses Starter v2, pages at 50, maps supported sorting, and preserves unknown citations', async () => {
    const httpClient = makeHttpClient([
      response({ metadata: { total: 60, page: 1, limit: 50 }, hits: [starterRecord] }),
      response({ metadata: { total: 60, page: 2, limit: 50 }, hits: [{ ...starterRecord, uid: 'WOS:1' }, { ...starterRecord, uid: 'WOS:3' }] })
    ]);
    const searcher = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient,
      sleep: async () => undefined,
      random: () => 0
    } as any);

    const papers = await searcher.search('machine learning', {
      maxResults: 60,
      sortBy: 'date',
      sortOrder: 'asc'
    });

    expect(httpClient.request).toHaveBeenCalledTimes(2);
    expect(httpClient.request.mock.calls[0][0]).toEqual(expect.objectContaining({
      url: 'https://api.clarivate.com/apis/wos-starter/v2/documents',
      params: expect.objectContaining({ limit: 50, page: 1, sortField: 'PY+A', db: 'WOS' })
    }));
    expect(papers.map(paper => paper.paperId)).toEqual(['WOS:1', 'WOS:3']);
    expect(papers[0].abstract).toBe('');
    expect(papers[0].citationCount).toBe(0);
    expect(papers[0].extra?.wosLinks?.record).toContain('/record/1');
  });

  it('keeps search count independent from bounded access enrichment count', async () => {
    process.env.ACCESS_DISCOVERY_MAX_ITEMS = '2';
    try {
      const httpClient = makeHttpClient([response({
        metadata: { total: 3, page: 1, limit: 3 },
        hits: [starterRecord, { ...starterRecord, uid: 'WOS:2' }, { ...starterRecord, uid: 'WOS:3' }]
      }), response({
        metadata: { total: 3, page: 1, limit: 3 },
        hits: [starterRecord, { ...starterRecord, uid: 'WOS:2' }, { ...starterRecord, uid: 'WOS:3' }]
      })]);
      const enrich = jest.fn(async (papers: any[], _options: any) => papers);
      const searcher = new WebOfScienceSearcher('starter-key', 'v2', {
        httpClient,
        publicAccessDiscovery: { enrich } as any,
        starterRateLimiter: fastLimiter()
      });

      await expect(searcher.search('topic', { maxResults: 3, discoverAccess: true })).resolves.toHaveLength(3);
      await expect(searcher.search('topic', { maxResults: 3, discoverAccess: true, discoverAccessMaxItems: 1 })).resolves.toHaveLength(3);
      expect(enrich.mock.calls[0][1]).toEqual({ maxItems: 2 });
      expect(enrich.mock.calls[1][1]).toEqual({ maxItems: 1 });
      await expect(searcher.search('topic', { discoverAccess: true, discoverAccessMaxItems: 101 })).rejects.toThrow(/discoverAccessMaxItems/i);
    } finally {
      delete process.env.ACCESS_DISCOVERY_MAX_ITEMS;
    }
  });

  it('preserves official results when the entire access enrichment rejects', async () => {
    const httpClient = makeHttpClient([
      response({ metadata: { total: 1, page: 1, limit: 1 }, hits: [starterRecord] })
    ]);
    const enrich = jest.fn(async () => {
      throw new Error('discovery batch failed');
    });
    const searcher = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient,
      publicAccessDiscovery: { enrich } as any,
      starterRateLimiter: fastLimiter()
    });

    const papers = await searcher.search('topic', { maxResults: 1, discoverAccess: true });
    expect(papers).toHaveLength(1);
    expect(papers[0].paperId).toBe('WOS:1');
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('uses WOS_API_KEY for the default Starter v2 search', async () => {
    process.env.WOS_API_KEY = 'starter-key';
    const httpClient = makeHttpClient([
      response({ metadata: { total: 1, page: 1, limit: 1 }, hits: [starterRecord] })
    ]);
    const searcher = new WebOfScienceSearcher(undefined, 'v2', {
      httpClient,
      starterRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0
    } as any);

    await searcher.search('topic', { maxResults: 1 });
    expect(httpClient.request.mock.calls[0][0].headers['X-ApiKey']).toBe('starter-key');
  });

  it('does not use the default Starter key for Expanded requests', async () => {
    process.env.WOS_API_KEY = 'starter-key';
    const httpClient = makeHttpClient([]);
    const searcher = new WebOfScienceSearcher(undefined, 'v2', {
      httpClient,
      expandedRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0
    } as any);

    await expect(searcher.search('topic', { apiProduct: 'expanded', maxResults: 1 })).rejects.toThrow(/Expanded API key/i);
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  it('keeps Starter v1 fixed when explicitly selected', async () => {
    const httpClient = makeHttpClient([
      response({ metadata: { total: 1, page: 1, limit: 1 }, hits: [starterRecord] })
    ]);
    const searcher = new WebOfScienceSearcher('starter-key', 'v1', {
      httpClient,
      starterRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0
    } as any);

    const papers = await searcher.search('topic', { maxResults: 1 });
    expect(httpClient.request.mock.calls[0][0].url).toBe('https://api.clarivate.com/apis/wos-starter/v1/documents');
    expect(papers[0].extra?.wosVersion).toBe('v1');
  });

  it('uses Expanded SR by default and parses FR metadata and citation counts separately', async () => {
    const httpClient = makeHttpClient([response({
      Data: { Records: { records: { REC: [expandedShortRecord] } } },
      QueryResult: { QueryID: '42', RecordsFound: 1, RecordsSearched: 10 }
    }, 200, { 'X-REQ-ReqPerSec-Remaining': '1' })]);
    const searcher = new WebOfScienceSearcher(undefined, undefined, {
      expandedApiKey: 'expanded-key',
      httpClient,
      sleep: async () => undefined,
      random: () => 0
    } as any);

    const papers = await searcher.search('topic', { apiProduct: 'expanded', maxResults: 1 });
    expect(httpClient.request.mock.calls[0][0]).toEqual(expect.objectContaining({
      url: 'https://api.clarivate.com/api/wos/',
      params: expect.objectContaining({ databaseId: 'WOS', usrQuery: 'TS=(topic)', count: 1, optionView: 'SR' })
    }));
    expect(papers[0].title).toBe('Expanded title');
    expect(papers[0].abstract).toBe('');
    expect(papers[0].citationCount).toBe(2);
    expect(papers[0].extra?.wosQueryResult).toEqual({ queryId: '42', recordsFound: 1, recordsSearched: 10 });
    expect(papers[0].publishedDate?.toISOString()).toContain('2023-10-01');

    const fullClient = makeHttpClient([response({
      Data: { Records: { records: { REC: [expandedRecord] } } },
      QueryResult: { QueryID: '43', RecordsFound: 1, RecordsSearched: 1 }
    })]);
    const fullSearcher = new WebOfScienceSearcher(undefined, undefined, {
      expandedApiKey: 'expanded-key',
      httpClient: fullClient,
      sleep: async () => undefined,
      random: () => 0
    } as any);
    const full = await fullSearcher.search('topic', { apiProduct: 'expanded', recordView: 'full', maxResults: 1 });
    expect(full[0].abstract).toBe('Expanded abstract');
    expect(full[0].doi).toBe('10.1000/expanded');
  });

  it('retries on the fixed Starter version while checking the limiter for every attempt', async () => {
    const request = jest.fn(async (_config: any) => {
      if (request.mock.calls.length === 1) {
        const error: any = new Error('temporary');
        error.response = { status: 503, headers: {} };
        throw error;
      }
      return response({ metadata: { total: 1, page: 1, limit: 1 }, hits: [starterRecord] });
    });
    const limiter = { waitForPermission: jest.fn(async () => undefined), getStatus: jest.fn(() => ({ availableTokens: 1, maxTokens: 1, requestsPerSecond: 1, pendingRequests: 0 })) };
    const quotaManager = QuotaManager.getInstance();
    (quotaManager as any).quotas.clear();
    const searcher = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient: { request },
      starterRateLimiter: limiter,
      quotaManager,
      sleep: async () => undefined,
      random: () => 0
    } as any);

    await expect(searcher.search('topic', { maxResults: 1 })).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(limiter.waitForPermission).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0].url).toBe(request.mock.calls[1][0].url);
    const status = await searcher.getStatus();
    expect(status.starter.requestAttempts).toBe(2);
    expect(status.starter.quota?.used).toBe(2);
  });

  it('counts a failed Starter attempt against the local request budget before retrying', async () => {
    process.env.WOS_STARTER_DAILY_LIMIT = '1';
    const quotaManager = QuotaManager.getInstance();
    (quotaManager as any).quotas.clear();
    const request = jest.fn(async (_config: any) => response({}, 503));
    const searcher = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient: { request },
      starterRateLimiter: fastLimiter(),
      quotaManager,
      sleep: async () => undefined,
      random: () => 0
    } as any);

    try {
      await expect(searcher.search('topic', { maxResults: 1 })).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      expect((await searcher.getStatus()).starter.quota).toEqual(expect.objectContaining({ used: 1, remaining: 0 }));
    } finally {
      delete process.env.WOS_STARTER_DAILY_LIMIT;
    }
  });

  it('reserves Starter quota before concurrent dispatch', async () => {
    process.env.WOS_STARTER_DAILY_LIMIT = '1';
    const quotaManager = QuotaManager.getInstance();
    (quotaManager as any).quotas.clear();
    let releaseRequest!: (value: any) => void;
    let startedRequest!: () => void;
    const requestStarted = new Promise<void>(resolve => { startedRequest = resolve; });
    const requestReleased = new Promise<any>(resolve => { releaseRequest = resolve; });
    const request = jest.fn(async (_config: any) => {
      startedRequest();
      return requestReleased;
    });
    const searcher = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient: { request },
      starterRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0,
      quotaManager
    } as any);

    const first = searcher.search('first', { maxResults: 1 });
    await requestStarted;
    const second = searcher.search('second', { maxResults: 1 });
    await expect(second).rejects.toThrow();
    releaseRequest(response({ metadata: { total: 1, page: 1, limit: 1 }, hits: [starterRecord] }));
    await expect(first).resolves.toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    delete process.env.WOS_STARTER_DAILY_LIMIT;
  });

  it('reports 401 as invalid and network/server failures as unknown during validation', async () => {
    const unauthorized = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient: { request: jest.fn(async (_config: any) => response({}, 401)) },
      starterRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0
    } as any);
    expect((await unauthorized.getStatus(true)).starter.apiKeyStatus).toBe('invalid');

    const unavailable = new WebOfScienceSearcher('starter-key', 'v2', {
      httpClient: { request: jest.fn(async (_config: any) => { throw new Error('network'); }) },
      starterRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0
    } as any);
    expect((await unavailable.getStatus(true)).starter.apiKeyStatus).toBe('unknown');
  });

  it('uses the documented Expanded relation endpoints and reference response shape', async () => {
    const httpClient = makeHttpClient([
      response({ Data: [{ UID: 'WOS:REF', citedTitle: 'Reference' }], QueryResult: { QueryID: 'ref' } }),
      response({ Data: { Records: { records: { REC: [expandedShortRecord] } } }, QueryResult: { QueryID: 'citing' } }),
      response({ Data: { Records: { records: { REC: [expandedShortRecord] } } }, QueryResult: { QueryID: 'related' } })
    ]);
    const searcher = new WebOfScienceSearcher(undefined, undefined, {
      expandedApiKey: 'expanded-key',
      httpClient,
      expandedRateLimiter: fastLimiter(),
      sleep: async () => undefined,
      random: () => 0
    } as any);

    await expect(searcher.getRelatedRecords('WOS:1', 'references')).resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ uid: 'WOS:REF' })] }));
    await expect(searcher.getRelatedRecords('WOS:1', 'citing')).resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ paperId: 'WOS:2' })] }));
    await expect(searcher.getRelatedRecords('WOS:1', 'related')).resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ paperId: 'WOS:2' })] }));
    expect(httpClient.request.mock.calls.map((call: any[]) => call[0].url)).toEqual([
      'https://api.clarivate.com/api/wos/references',
      'https://api.clarivate.com/api/wos/citing',
      'https://api.clarivate.com/api/wos/related'
    ]);
    expect(httpClient.request.mock.calls[0][0].params).toEqual(expect.objectContaining({ databaseId: 'WOS', uniqueId: 'WOS:1', count: 50, firstRecord: 1 }));
  });

  it('enforces the configured Full Record budget using actual returned records', async () => {
    process.env.WOS_EXPANDED_FULL_RECORD_BUDGET = '1';
    const quotaManager = QuotaManager.getInstance();
    (quotaManager as any).quotas.clear();
    const request = jest.fn(async (_config: any) => response({
      Data: { Records: { records: { REC: [expandedRecord] } } },
      QueryResult: { QueryID: 'budget', RecordsFound: 1, RecordsSearched: 1 }
    }));
    const searcher = new WebOfScienceSearcher(undefined, undefined, {
      expandedApiKey: 'expanded-key',
      httpClient: { request },
      expandedRateLimiter: fastLimiter(),
      quotaManager,
      sleep: async () => undefined,
      random: () => 0
    } as any);
    try {
      await expect(searcher.search('topic', { apiProduct: 'expanded', recordView: 'full', maxResults: 1 })).resolves.toHaveLength(1);
      await expect(searcher.search('topic', { apiProduct: 'expanded', recordView: 'full', maxResults: 1 })).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
      const status = await searcher.getStatus();
      expect(status.expanded.fullRecordBudget).toEqual(expect.objectContaining({ limit: 1, used: 1, remaining: 0 }));
    } finally {
      delete process.env.WOS_EXPANDED_FULL_RECORD_BUDGET;
    }
  });

  it('parses Expanded reference records separately from paper records', () => {
    const references = parseReferences({
      Data: { Records: { records: { REC: {
        UID: 'WOS:REF-1',
        static_data: {
          summary: {
            titles: { title: [{ type: 'item', content: 'Cited title' }, { type: 'source', content: 'Cited Journal' }] },
            names: { name: { role: 'author', display_name: 'Cited Author' } },
            pub_info: { pubyear: 2020, page: { content: '10-12' } }
          }
        },
        dynamic_data: { citation_related: { tc_list: { silo_tc: { coll_id: 'WOS', local_count: 4 } } } }
      } } } },
      QueryResult: { QueryID: 'refs' }
    });
    expect(references).toEqual([expect.objectContaining({
      uid: 'WOS:REF-1',
      citedTitle: 'Cited title',
      citedWork: 'Cited Journal',
      citedAuthor: 'Cited Author',
      year: 2020,
      page: '10-12',
      timesCited: 4
    })]);
    expect(parseReferences({ Data: [{ citedTitle: 'Reference without UID' }] })).toEqual([
      expect.objectContaining({ citedTitle: 'Reference without UID', uid: undefined })
    ]);
  });

  it('serializes an absent citation count as null instead of zero', () => {
    const paper = PaperFactory.create({ paperId: 'x', title: 'x', source: 'test' });
    expect(paper.citationCount).toBeUndefined();
    expect(PaperFactory.toDict(paper).citation_count).toBeNull();
  });

  it('does not expose Starter as a citation relationship provider', async () => {
    const searcher = new WebOfScienceSearcher(undefined, 'v2', {
      starterApiKey: 'starter-key',
      httpClient: makeHttpClient([])
    } as any);
    await expect(searcher.getReferenceIds('WOS:1')).rejects.toThrow(/Expanded API/i);
  });
});
