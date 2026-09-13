import { logDebug, logWarn } from './Logger.js';

export interface QuotaConfig {
  dailyLimit: number;
  envPrefix?: string;
  envVar?: string;
}

export interface QuotaStatus {
  platform: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface QuotaReservation {
  readonly id: string;
  readonly platform: string;
  readonly amount: number;
  readonly dayKey: string;
}

interface QuotaRecord {
  limit: number;
  used: number;
  dayKey: string;
  reserved: number;
  reservations: Map<string, QuotaReservation>;
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
  private quotas: Map<string, QuotaRecord> = new Map();
  private reservationSequence = 0;

  private constructor() {}

  static getInstance(): QuotaManager {
    if (!QuotaManager.instance) {
      QuotaManager.instance = new QuotaManager();
    }
    return QuotaManager.instance;
  }

  registerPlatform(platform: string, config: QuotaConfig): void {
    const envVar = config.envVar || (config.envPrefix ? `${config.envPrefix}_DAILY_LIMIT` : undefined);
    const rawLimit = envVar ? process.env[envVar] : undefined;
    const limitFromEnv = rawLimit === undefined || rawLimit.trim() === '' ? NaN : Number(rawLimit);
    const limit = Number.isFinite(limitFromEnv) && limitFromEnv >= 0 ? limitFromEnv : config.dailyLimit;

    const dayKey = this.getDayKey();
    const existing = this.quotas.get(platform);
    if (existing) {
      this.resetIfNeeded(platform, existing);
      // Re-registration updates configuration without erasing usage. This is
      // important when multiple platform aliases share one process quota.
      existing.limit = limit;
    } else {
      this.quotas.set(platform, { limit, used: 0, dayKey, reserved: 0, reservations: new Map() });
    }

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

    if (quota.used + quota.reserved >= quota.limit) {
      const resetAt = this.getNextResetTime();
      throw new QuotaExhaustedError(platform, quota.limit, resetAt);
    }
  }

  incrementUsage(platform: string): void {
    this.incrementUsageBy(platform, 1);
  }

  incrementUsageBy(platform: string, amount: number): void {
    const quota = this.quotas.get(platform);
    if (!quota) {
      logWarn(`QuotaManager: Platform ${platform} not registered`);
      return;
    }

    this.resetIfNeeded(platform, quota);

    if (Number.isFinite(amount) && amount > 0) {
      quota.used += amount;
      logDebug(`QuotaManager: ${platform} usage: ${quota.used}/${quota.limit > 0 ? quota.limit : 'unlimited'}`);
    }
  }

  checkQuotaAmount(platform: string, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Quota amount must be non-negative');
    const quota = this.quotas.get(platform);
    if (!quota) {
      logWarn(`QuotaManager: Platform ${platform} not registered`);
      return;
    }

    this.resetIfNeeded(platform, quota);
    if (quota.limit > 0 && quota.used + quota.reserved + amount > quota.limit) {
      const resetAt = this.getNextResetTime();
      throw new QuotaExhaustedError(platform, quota.limit, resetAt);
    }
  }

  reserve(platform: string, amount: number): QuotaReservation | undefined {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Quota reservation amount must be non-negative');
    const quota = this.quotas.get(platform);
    if (!quota || amount === 0) return undefined;
    this.resetIfNeeded(platform, quota);
    if (quota.limit > 0 && quota.used + quota.reserved + amount > quota.limit) {
      throw new QuotaExhaustedError(platform, quota.limit, this.getNextResetTime());
    }
    const reservation: QuotaReservation = {
      id: `${platform}:${++this.reservationSequence}`,
      platform,
      amount,
      dayKey: quota.dayKey
    };
    quota.reservations.set(reservation.id, reservation);
    quota.reserved += amount;
    return reservation;
  }

  /** Commit a reservation exactly once; a stale-period token is ignored. */
  commit(reservation: QuotaReservation | undefined, amount = reservation?.amount || 0): void {
    if (!reservation || !Number.isFinite(amount) || amount < 0) {
      if (reservation) throw new Error('Quota commit amount must be non-negative');
      return;
    }
    const quota = this.quotas.get(reservation.platform);
    if (!quota) return;
    this.resetIfNeeded(reservation.platform, quota);
    const active = quota.reservations.get(reservation.id);
    if (!active) return;
    if (amount > active.amount) throw new Error('Quota commit amount exceeds reservation');
    quota.reservations.delete(reservation.id);
    quota.reserved = Math.max(0, quota.reserved - active.amount);
    if (active.dayKey !== quota.dayKey) return;
    quota.used += amount;
  }

  /** Release a reservation exactly once; a stale-period token is ignored. */
  release(reservation: QuotaReservation | undefined): void {
    if (!reservation) return;
    const quota = this.quotas.get(reservation.platform);
    if (!quota) return;
    this.resetIfNeeded(reservation.platform, quota);
    const active = quota.reservations.get(reservation.id);
    if (!active) return;
    quota.reservations.delete(reservation.id);
    quota.reserved = Math.max(0, quota.reserved - active.amount);
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
      remaining: Math.max(0, quota.limit - quota.used - quota.reserved),
      resetAt: this.getNextResetTime()
    };
  }

  private resetIfNeeded(platform: string, quota: QuotaRecord): void {
    const currentKey = this.getDayKey();
    if (currentKey !== quota.dayKey) {
      quota.dayKey = currentKey;
      quota.used = 0;
      // Reservations from the old accounting period must not subtract from or
      // block the new period when their requests finish later.
      quota.reservations.clear();
      quota.reserved = 0;
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
