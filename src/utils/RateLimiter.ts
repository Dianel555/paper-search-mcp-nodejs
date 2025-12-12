/**
 * 请求速率限制器
 * 用于控制API请求频率，遵守各平台的使用限制
 */

import { logDebug } from './Logger.js';

export interface RateLimiterOptions {
  /** 每秒最大请求数 */
  requestsPerSecond: number;
  /** 突发请求容量 */
  burstCapacity?: number;
  /** 是否启用调试日志 */
  debug?: boolean;
}

export class RateLimiter {
  private readonly requestsPerSecond: number;
  private readonly intervalMs: number;
  private readonly burstCapacity: number;
  private readonly debug: boolean;
  
  private tokens: number;
  private lastRefill: number;
  private intervalHandle: NodeJS.Timeout;
  private readonly pendingRequests: Array<{
    resolve: () => void;
    timestamp: number;
  }> = [];

  constructor(options: RateLimiterOptions) {
    this.requestsPerSecond = options.requestsPerSecond;
    this.intervalMs = 1000 / this.requestsPerSecond;
    this.burstCapacity = options.burstCapacity || this.requestsPerSecond;
    this.debug = options.debug || false;
    
    this.tokens = this.burstCapacity;
    this.lastRefill = Date.now();
    
    // 定期处理等待中的请求
    this.intervalHandle = setInterval(() => this.processPendingRequests(), Math.min(this.intervalMs, 100));
    // Don't keep the process alive just because of the limiter interval (important for tests/MCP)
    this.intervalHandle.unref?.();
  }

  /**
   * 等待直到可以发送请求
   */
  async waitForPermission(): Promise<void> {
    this.refillTokens();
    
    if (this.tokens > 0) {
      this.tokens--;
      if (this.debug) {
        logDebug(`RateLimiter: Request allowed, ${this.tokens} tokens remaining`);
      }
      return Promise.resolve();
    }

    // 没有可用令牌，加入等待队列
    return new Promise<void>((resolve) => {
      this.pendingRequests.push({
        resolve,
        timestamp: Date.now()
      });
      
      if (this.debug) {
        logDebug(`RateLimiter: Request queued, ${this.pendingRequests.length} waiting`);
      }
    });
  }

  /**
   * 补充令牌（令牌桶算法）
   */
  private refillTokens(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    
    if (timePassed >= this.intervalMs) {
      const tokensToAdd = Math.floor(timePassed / this.intervalMs);
      this.tokens = Math.min(this.burstCapacity, this.tokens + tokensToAdd);
      this.lastRefill = now;
      
      if (this.debug && tokensToAdd > 0) {
        logDebug(`RateLimiter: Added ${tokensToAdd} tokens, total: ${this.tokens}`);
      }
    }
  }

  /**
   * 处理等待中的请求
   */
  private processPendingRequests(): void {
    this.refillTokens();
    
    while (this.tokens > 0 && this.pendingRequests.length > 0) {
      const request = this.pendingRequests.shift();
      if (request) {
        this.tokens--;
        request.resolve();
        
        if (this.debug) {
          const waitTime = Date.now() - request.timestamp;
          logDebug(`RateLimiter: Released waiting request (waited ${waitTime}ms), ${this.tokens} tokens remaining`);
        }
      }
    }
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    availableTokens: number;
    maxTokens: number;
    requestsPerSecond: number;
    pendingRequests: number;
  } {
    this.refillTokens();
    return {
      availableTokens: this.tokens,
      maxTokens: this.burstCapacity,
      requestsPerSecond: this.requestsPerSecond,
      pendingRequests: this.pendingRequests.length
    };
  }

  /**
   * 清理过期的等待请求（超过30秒）
   */
  cleanup(): void {
    const now = Date.now();
    const timeoutMs = 30000; // 30秒超时
    
    let removedCount = 0;
    while (this.pendingRequests.length > 0) {
      const first = this.pendingRequests[0];
      if (now - first.timestamp > timeoutMs) {
        this.pendingRequests.shift();
        // 拒绝过期的请求
        first.resolve(); // 或者可以reject，但这里选择允许继续
        removedCount++;
      } else {
        break;
      }
    }
    
    if (this.debug && removedCount > 0) {
      logDebug(`RateLimiter: Cleaned up ${removedCount} expired requests`);
    }
  }

  dispose(): void {
    clearInterval(this.intervalHandle);
  }
}
