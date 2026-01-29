import { logDebug, logWarn } from './Logger.js';

export interface QuotaConfig {
  dailyLimit: number;
  envPrefix?: string;
}

export interface QuotaStatus {
  platform: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export class QuotaExhaustedError extends Error {
  constructor(
    public readonly platform: string,
    public readonly limit: number,
    public readonly resetAt: string
  ) {
    super(`${platform} daily quota exhausted (${limit}/day). Resets at ${resetAt}`);
    this.name = 'QuotaExhaustedError';
  }
}

export class QuotaManager {
  private static instance: QuotaManager;
  private quotas: Map<string, { limit: number; used: number; dayKey: string }> = new Map();

  private constructor() {}

  static getInstance(): QuotaManager {
    if (!QuotaManager.instance) {
      QuotaManager.instance = new QuotaManager();
    }
    return QuotaManager.instance;
  }

  registerPlatform(platform: string, config: QuotaConfig): void {
    const envVar = config.envPrefix ? `${config.envPrefix}_DAILY_LIMIT` : undefined;
    const limitFromEnv = envVar ? Number(process.env[envVar]) : NaN;
    const limit = Number.isFinite(limitFromEnv) && limitFromEnv > 0 ? limitFromEnv : config.dailyLimit;

    this.quotas.set(platform, {
      limit,
      used: 0,
      dayKey: this.getDayKey()
    });

    logDebug(`QuotaManager: Registered ${platform} with daily limit ${limit}`);
  }

  checkQuota(platform: string): void {
    const quota = this.quotas.get(platform);
    if (!quota) {
      logWarn(`QuotaManager: Platform ${platform} not registered`);
      return;
    }

    this.resetIfNeeded(platform, quota);

    if (quota.limit <= 0) {
      return;
    }

    if (quota.used >= quota.limit) {
      const resetAt = this.getNextResetTime();
      throw new QuotaExhaustedError(platform, quota.limit, resetAt);
    }
  }

  incrementUsage(platform: string): void {
    const quota = this.quotas.get(platform);
    if (!quota) {
      logWarn(`QuotaManager: Platform ${platform} not registered`);
      return;
    }

    this.resetIfNeeded(platform, quota);

    if (quota.limit > 0) {
      quota.used++;
      logDebug(`QuotaManager: ${platform} usage: ${quota.used}/${quota.limit}`);
    }
  }

  getStatus(platform: string): QuotaStatus | null {
    const quota = this.quotas.get(platform);
    if (!quota) {
      return null;
    }

    this.resetIfNeeded(platform, quota);

    return {
      platform,
      used: quota.used,
      limit: quota.limit,
      remaining: Math.max(0, quota.limit - quota.used),
      resetAt: this.getNextResetTime()
    };
  }

  private resetIfNeeded(platform: string, quota: { limit: number; used: number; dayKey: string }): void {
    const currentKey = this.getDayKey();
    if (currentKey !== quota.dayKey) {
      quota.dayKey = currentKey;
      quota.used = 0;
      logDebug(`QuotaManager: Reset ${platform} quota for new day ${currentKey}`);
    }
  }

  private getDayKey(date: Date = new Date()): string {
    return date.toISOString().split('T')[0];
  }

  private getNextResetTime(): string {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.toISOString();
  }
}

export default QuotaManager;
