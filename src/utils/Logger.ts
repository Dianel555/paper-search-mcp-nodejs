import { sanitizeSensitiveText } from './SecurityUtils.js';

export function isMCPMode(): boolean {
  return (
    process.argv.includes('--mcp') ||
    process.env.MCP_SERVER === 'true' ||
    // Fallback: when running under MCP via stdio, stdin is typically not a TTY.
    // Do NOT treat CI as MCP to preserve warning/error logs in pipelines.
    (process.stdin?.isTTY === false && process.env.CI !== 'true')
  );
}

export function logDebug(...args: any[]): void {
  if (isMCPMode()) return;
  if (process.env.NODE_ENV === 'development' || process.env.CI === 'true') {
    console.error(...sanitizeLogArgs(args));
  }
}

export function logInfo(...args: any[]): void {
  if (isMCPMode()) return;
  console.error(...sanitizeLogArgs(args));
}

export function logWarn(...args: any[]): void {
  if (isMCPMode()) return;
  console.error(...sanitizeLogArgs(args));
}

export function logError(...args: any[]): void {
  if (isMCPMode()) return;
  console.error(...sanitizeLogArgs(args));
}

/** Keep accidental credentials out of logs from every caller, not only API clients. */
function sanitizeLogArgs(args: any[]): any[] {
  const seen = new WeakSet<object>();
  return args.map(value => sanitizeLogValue(value, seen));
}

function sanitizeLogValue(value: any, seen: WeakSet<object>): any {
  if (typeof value === 'string') return sanitizeSensitiveText(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[Buffer length=${value.length}]`;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeSensitiveText(value.message),
      ...(value.stack ? { stack: sanitizeSensitiveText(value.stack) } : {})
    };
  }
  if (Array.isArray(value)) return value.map(item => sanitizeLogValue(item, seen));

  const result: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = '***REDACTED***';
    } else {
      result[key] = sanitizeLogValue(child, seen);
    }
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[-_]?key|authorization|auth|cookie|set[-_]?cookie|session|jwt|sso|saml|token|secret|password|private)/i.test(key);
}
