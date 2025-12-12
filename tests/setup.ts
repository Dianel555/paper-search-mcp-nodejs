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
  delete process.env.CROSSREF_MAILTO;
  delete process.env.WOS_VERBOSE_LOGGING;
});

export {};
