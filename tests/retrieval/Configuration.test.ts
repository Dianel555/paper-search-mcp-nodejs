import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_RETRIEVAL_BUDGET,
  DEFAULT_RETRIEVAL_REQUEST_LIMIT,
  DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET,
  DEFAULT_RESIDENTIAL_RETRIEVAL_REQUEST_LIMIT,
  getRetrievalBudgetDefaults,
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
    expect(invalid.scrapingAnt.proxyType).toBe('residential');
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

  it('uses residential publisher and Scholar defaults independently from the selected ceiling', () => {
    const authorizationOnly = parseRetrievalConfiguration({
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_PROXY_TYPE: 'datacenter'
    });
    expect(getRetrievalBudgetDefaults(authorizationOnly, 'publisher_discovery')).toEqual({
      maxCreditsPerOperation: DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET,
      maxCreditsPerRequest: DEFAULT_RESIDENTIAL_RETRIEVAL_REQUEST_LIMIT
    });
    expect(getRetrievalBudgetDefaults(authorizationOnly, 'scholar_search')).toEqual({
      maxCreditsPerOperation: DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET,
      maxCreditsPerRequest: DEFAULT_RESIDENTIAL_RETRIEVAL_REQUEST_LIMIT
    });
    expect(authorizationOnly.scrapingAnt.availableProxyTypes).toEqual(['datacenter']);
    expect(getRetrievalBudgetDefaults(authorizationOnly, 'scihub_lookup')).toEqual({
      maxCreditsPerOperation: DEFAULT_RETRIEVAL_BUDGET,
      maxCreditsPerRequest: DEFAULT_RETRIEVAL_REQUEST_LIMIT
    });

    const residential = parseRetrievalConfiguration({
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_PROXY_TYPE: 'residential'
    });
    expect(residential.scrapingAnt.paidEnabled).toBe(false);
    expect(residential.scrapingAnt.availableProxyTypes).toEqual(['datacenter', 'residential']);
    expect(getRetrievalBudgetDefaults(residential, 'publisher_discovery').maxCreditsPerOperation)
      .toBe(DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET);
  });

  it('lets explicit valid limits override both default tables and disables paid retrieval for invalid values', () => {
    const explicit = parseRetrievalConfiguration({
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '10',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '5'
    });
    expect(getRetrievalBudgetDefaults(explicit, 'publisher_discovery')).toEqual({
      maxCreditsPerOperation: 10,
      maxCreditsPerRequest: 5
    });
    expect(getRetrievalBudgetDefaults(explicit, 'unknown')).toEqual({
      maxCreditsPerOperation: 10,
      maxCreditsPerRequest: 5
    });

    const invalid = parseRetrievalConfiguration({
      SCRAPINGANT_API_KEY: 'key',
      SCRAPINGANT_ENABLED: 'true',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: 'NaN',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: '-1'
    });
    expect(invalid.scrapingAnt.configurationInvalid).toBe(true);
    expect(invalid.scrapingAnt.paidEnabled).toBe(false);
    expect(invalid.scrapingAnt.maxCreditsPerOperation).toBe(DEFAULT_RETRIEVAL_BUDGET);
    expect(invalid.scrapingAnt.maxCreditsPerRequest).toBe(DEFAULT_RETRIEVAL_REQUEST_LIMIT);

    const blank = parseRetrievalConfiguration({
      SCRAPINGANT_ALLOW_RESIDENTIAL: 'true',
      SCRAPINGANT_MAX_CREDITS_PER_OPERATION: '  ',
      SCRAPINGANT_MAX_CREDITS_PER_REQUEST: ''
    });
    expect(getRetrievalBudgetDefaults(blank, 'publisher_discovery')).toEqual({
      maxCreditsPerOperation: DEFAULT_RESIDENTIAL_RETRIEVAL_BUDGET,
      maxCreditsPerRequest: DEFAULT_RESIDENTIAL_RETRIEVAL_REQUEST_LIMIT
    });
  });

  it('keeps the checked-in env example aligned with the residential controls', () => {
    const environment = Object.fromEntries(readFileSync('.env.example', 'utf8')
      .split(/\r?\n/)
      .filter(line => line && !line.trim().startsWith('#') && line.includes('='))
      .map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
    const parsed = parseRetrievalConfiguration(environment);
    expect(environment.SCRAPINGANT_ALLOW_RESIDENTIAL).toBe('false');
    expect(environment.SCRAPINGANT_PROXY_TYPE).toBe('datacenter');
    expect(parsed.scrapingAnt.availableProxyTypes).toEqual(['datacenter']);
    expect(getRetrievalBudgetDefaults(parsed, 'publisher_discovery')).toEqual({
      maxCreditsPerOperation: 50,
      maxCreditsPerRequest: 10
    });
  });

  it('falls back to five for an invalid discovery default and records a warning', () => {
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '0' }).accessDiscoveryMaxItems).toBe(5);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '-1' }).accessDiscoveryMaxItems).toBe(5);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '101' }).accessDiscoveryMaxItems).toBe(5);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: 'not-a-number' }).warnings.join(' ')).toMatch(/ACCESS_DISCOVERY_MAX_ITEMS/);
    expect(parseRetrievalConfiguration({ ACCESS_DISCOVERY_MAX_ITEMS: '7' }).accessDiscoveryMaxItems).toBe(7);
  });
});
