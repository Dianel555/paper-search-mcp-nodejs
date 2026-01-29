import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { QuotaManager, QuotaExhaustedError } from '../../src/utils/QuotaManager.js';

describe('QuotaManager', () => {
  let quotaManager: QuotaManager;

  beforeEach(() => {
    // Get a fresh instance for each test
    quotaManager = QuotaManager.getInstance();
    // Clear any existing registrations
    (quotaManager as any).quotas.clear();
  });

  describe('registerPlatform', () => {
    it('should register a platform with default daily limit', () => {
      quotaManager.registerPlatform('test-platform', { dailyLimit: 100 });

      const status = quotaManager.getStatus('test-platform');
      expect(status).not.toBeNull();
      expect(status?.limit).toBe(100);
      expect(status?.used).toBe(0);
    });

    it('should override daily limit from environment variable', () => {
      process.env.TEST_DAILY_LIMIT = '500';

      quotaManager.registerPlatform('test-platform', {
        dailyLimit: 100,
        envPrefix: 'TEST'
      });

      const status = quotaManager.getStatus('test-platform');
      expect(status?.limit).toBe(500);

      delete process.env.TEST_DAILY_LIMIT;
    });

    it('should use default limit when env variable is invalid', () => {
      process.env.TEST_DAILY_LIMIT = 'invalid';

      quotaManager.registerPlatform('test-platform', {
        dailyLimit: 100,
        envPrefix: 'TEST'
      });

      const status = quotaManager.getStatus('test-platform');
      expect(status?.limit).toBe(100);

      delete process.env.TEST_DAILY_LIMIT;
    });
  });

  describe('checkQuota and incrementUsage', () => {
    beforeEach(() => {
      quotaManager.registerPlatform('test-platform', { dailyLimit: 3 });
    });

    it('should allow requests when under quota', () => {
      expect(() => quotaManager.checkQuota('test-platform')).not.toThrow();

      quotaManager.incrementUsage('test-platform');
      expect(() => quotaManager.checkQuota('test-platform')).not.toThrow();

      quotaManager.incrementUsage('test-platform');
      expect(() => quotaManager.checkQuota('test-platform')).not.toThrow();
    });

    it('should throw QuotaExhaustedError when quota is exceeded', () => {
      quotaManager.incrementUsage('test-platform');
      quotaManager.incrementUsage('test-platform');
      quotaManager.incrementUsage('test-platform');

      expect(() => quotaManager.checkQuota('test-platform')).toThrow(QuotaExhaustedError);
    });

    it('should include platform and limit in error', () => {
      quotaManager.incrementUsage('test-platform');
      quotaManager.incrementUsage('test-platform');
      quotaManager.incrementUsage('test-platform');

      try {
        quotaManager.checkQuota('test-platform');
        fail('Should have thrown QuotaExhaustedError');
      } catch (error: any) {
        expect(error).toBeInstanceOf(QuotaExhaustedError);
        expect(error.platform).toBe('test-platform');
        expect(error.limit).toBe(3);
        expect(error.resetAt).toBeDefined();
      }
    });

    it('should track usage correctly', () => {
      let status = quotaManager.getStatus('test-platform');
      expect(status?.used).toBe(0);
      expect(status?.remaining).toBe(3);

      quotaManager.incrementUsage('test-platform');
      status = quotaManager.getStatus('test-platform');
      expect(status?.used).toBe(1);
      expect(status?.remaining).toBe(2);

      quotaManager.incrementUsage('test-platform');
      status = quotaManager.getStatus('test-platform');
      expect(status?.used).toBe(2);
      expect(status?.remaining).toBe(1);
    });

    it('should allow unlimited quota when limit is 0 or negative', () => {
      quotaManager.registerPlatform('unlimited', { dailyLimit: 0 });

      for (let i = 0; i < 100; i++) {
        expect(() => quotaManager.checkQuota('unlimited')).not.toThrow();
        quotaManager.incrementUsage('unlimited');
      }
    });
  });

  describe('daily reset', () => {
    beforeEach(() => {
      quotaManager.registerPlatform('test-platform', { dailyLimit: 5 });
    });

    it('should reset usage count on new day', () => {
      // Use up quota
      for (let i = 0; i < 5; i++) {
        quotaManager.incrementUsage('test-platform');
      }

      let status = quotaManager.getStatus('test-platform');
      expect(status?.used).toBe(5);
      expect(() => quotaManager.checkQuota('test-platform')).toThrow(QuotaExhaustedError);

      // Simulate day change by directly modifying the dayKey
      const quota = (quotaManager as any).quotas.get('test-platform');
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      quota.dayKey = tomorrow.toISOString().split('T')[0];

      // Should reset when checking status or quota
      status = quotaManager.getStatus('test-platform');
      expect(status?.used).toBe(0);
      expect(status?.remaining).toBe(5);
      expect(() => quotaManager.checkQuota('test-platform')).not.toThrow();
    });
  });

  describe('getStatus', () => {
    beforeEach(() => {
      quotaManager.registerPlatform('test-platform', { dailyLimit: 10 });
    });

    it('should return null for unregistered platform', () => {
      const status = quotaManager.getStatus('unknown-platform');
      expect(status).toBeNull();
    });

    it('should return correct status', () => {
      quotaManager.incrementUsage('test-platform');
      quotaManager.incrementUsage('test-platform');
      quotaManager.incrementUsage('test-platform');

      const status = quotaManager.getStatus('test-platform');
      expect(status).toEqual({
        platform: 'test-platform',
        used: 3,
        limit: 10,
        remaining: 7,
        resetAt: expect.any(String)
      });
    });

    it('should include correct reset time (next midnight UTC)', () => {
      const status = quotaManager.getStatus('test-platform');
      expect(status?.resetAt).toBeDefined();

      const resetDate = new Date(status!.resetAt);
      expect(resetDate.getUTCHours()).toBe(0);
      expect(resetDate.getUTCMinutes()).toBe(0);
      expect(resetDate.getUTCSeconds()).toBe(0);
      expect(resetDate > new Date()).toBe(true);
    });
  });
});