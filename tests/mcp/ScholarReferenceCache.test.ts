import { describe, expect, it } from '@jest/globals';
import { PaperFactory } from '../../src/models/Paper.js';
import { ScholarReferenceCache } from '../../src/mcp/ScholarReferenceCache.js';

function paper(paperId: string, url: string, title = paperId) {
  return PaperFactory.create({
    paperId,
    title,
    authors: ['Author'],
    source: 'googlescholar',
    url
  });
}

describe('ScholarReferenceCache', () => {
  it('keeps references isolated, bounded, and non-sliding', () => {
    let now = 1_000;
    const cache = new ScholarReferenceCache({ now: () => now });
    cache.put(paper('gs_one_two', 'https://publisher.example/one'));

    expect(cache.get('gs_one_two')).toMatchObject({
      status: 'hit',
      reference: { paperId: 'gs_one_two', url: 'https://publisher.example/one' }
    });
    now += 299_999;
    expect(cache.get('gs_one_two').status).toBe('hit');
    now += 1;
    expect(cache.get('gs_one_two').status).toBe('expired');
    now += 1;
    expect(cache.get('gs_one_two').status).toBe('missing');
  });

  it('evicts the least recently used ordinary entry but never a live tombstone', () => {
    let now = 0;
    const cache = new ScholarReferenceCache({ now: () => now, maxEntries: 2 });
    cache.put(paper('gs_one_one', 'https://publisher.example/one'));
    cache.put(paper('gs_two_two', 'https://publisher.example/two'));
    expect(cache.get('gs_one_one').status).toBe('hit');
    cache.put(paper('gs_three_three', 'https://publisher.example/three'));
    expect(cache.get('gs_two_two').status).toBe('missing');
    expect(cache.get('gs_one_one').status).toBe('hit');
    expect(cache.get('gs_three_three').status).toBe('hit');

    cache.put(paper('gs_one_one', 'https://publisher.example/different'));
    expect(cache.get('gs_one_one').status).toBe('ambiguous');
    cache.put(paper('gs_four_four', 'https://publisher.example/four'));
    expect(cache.get('gs_four_four').status).toBe('hit');
  });

  it('rejects unsafe references and clears all state on dispose', () => {
    const cache = new ScholarReferenceCache();
    expect(cache.put(paper('gs_bad_bad', 'https://user:pass@publisher.example/paper')).status).toBe('rejected');
    cache.put(paper('gs_good_good', 'https://publisher.example/good'));
    cache.dispose();
    expect(cache.get('gs_good_good').status).toBe('missing');
  });
});
