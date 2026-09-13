import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_RETRIEVAL_BUDGET,
  DEFAULT_RETRIEVAL_REQUEST_LIMIT,
  parseRetrievalConfiguration
} from '../../src/retrieval/Configuration.js';

describe('retrieval configuration', () => {
  it('does not authorize paid retrieval from an API key alone', () => {
    const configuration = parseRetrievalConfiguration({ SCRAPINGANT_API_KEY: 'key' });

    expect(configuration.scrapingAnt.configured).toBe(true);
    expect(configuration.scrapingAnt.enabled).toBe(false);
    expect(configuration.scrapingAnt.paidEnabled).toBe(false);
    expect(configuration.scrapingAnt.browserAllowed).toBe(false);
    expect(configuration.scrapingAnt.maxCreditsPerOperation).toBe(DEFAULT_RETRIEVAL_BUDGET);
    expect(configuration.scrapingAnt.maxCreditsPerRequest).toBe(DEFAULT_RETRIEVAL_REQUEST_LIMIT);
  });

  it('requires a non-blank key, explicit enablement, and rejects residential or invalid budgets', () => {
    expect(parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: '   ',
      SCRAPINGANT_ENABLED: 'true'
    }).scrapingAnt.paidEnabled).toBe(false);

    const invalid = parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: 'key',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_PROXY_TYPE: 'residential',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '0',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '9007199254740992',
      SCRAPINGANT_MAX_CONCURRENCY: '17'
    });
    expect(invalid.scrapingAnt.paidEnabled).toBe(false);
    expect(invalid.scrapingAnt.proxyType).toBe('datacenter');
    expect(invalid.scrapingAnt.configurationInvalid).toBe(true);
    expect(invalid.warnings.join(' ')).toMatch(/residential|budget|concurrency/i);
  });

  it('allows a valid datacenter paid configuration while browser remains opt-in', () => {
    const configuration = parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: 'key',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_ALLOW_BROWSER_ESCALATION: 'true',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '50',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '10',
      SCRAPINGANT_MAX_CONCURRENCY: '4',
      SCRAPINGANT_PROXY_TYPE: 'datacenter'
    });

    expect(configuration.scrapingAnt.paidEnabled).toBe(true);
    expect(configuration.scrapingAnt.browserAllowed).toBe(true);
    expect(configuration.scrapingAnt.maxConcurrency).toBe(4);
  });

  it('falls back to five for an invalid discovery default and records a warning', () => {
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '0' }).accessDiscoveryMaxItems).toBe(5);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '-1' }).accessDiscoveryMaxItems).toBe(5);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '101' }).accessDiscoveryMaxItems).toBe(5);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: 'not-a-number' }).warnings.join(' ')).toMatch(/ACCESS_DISCOVERY_MAX_ITEMS/);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '7' }).accessDiscoveryMaxItems).toBe(7);
  });
});
