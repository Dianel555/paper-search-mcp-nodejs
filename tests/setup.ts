/**
 * Jest Test Setup
 * Global setup for all tests
 */

import { jest, beforeAll, afterAll, afterEach } from '@jest/globals';

// Set test environment
process.env.NODE_ENV = 'test';

// Increase timeout for API tests
jest.setTimeout(30000);

// Mock console.error to reduce noise in tests
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn() as typeof console.error;
});

afterAll(() => {
  console.error = originalConsoleError;
});

// Clean up environment variables after each test
afterEach(() => {
  // Reset specific env vars that tests might modify
  delete process.env.WOS_API_VERSION;
  delete process.env.WOS_STARTER_VERSION;
  delete process.env.WOS_STARTER_DAILY_LIMIT;
  delete process.env.WOS_EXPANDED_API_KEY;
  delete process.env.WOS_API_KEY;
  delete process.env.WOS_EXPANDED_FULL_RECORD_BUDGET;
  delete process.env.SCRAPINGANT_API_KEY;
  delete process.env.SCRAPINGANT_ENABLED;
  delete process.env.SCRAPINGANT_ALLOW_BROWSER_ESCALATION;
  delete process.env.SCRAPINGANT_MAX_CREDITS_PER_OPERATION;
  delete process.env.SCRAPINGANT_MAX_CREDITS_PER_REQUEST;
  delete process.env.SCRAPINGANT_MAX_CONCURRENCY;
  delete process.env.SCRAPINGANT_PROXY_TYPE;
  delete process.env.SCRAPINGANT_PUBLIC_COOKIES_BY_HOST_JSON;
  delete process.env.SCIHUB_ENABLED;
  delete process.env.SCIHUB_MIRRORS;
  delete process.env.CROSSREF_MAILTO;
  delete process.env.WOS_VERBOSE_LOGGING;
});

export {};
