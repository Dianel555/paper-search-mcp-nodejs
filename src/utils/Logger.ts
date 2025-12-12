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
    console.error(...args);
  }
}

export function logInfo(...args: any[]): void {
  if (isMCPMode()) return;
  console.error(...args);
}

export function logWarn(...args: any[]): void {
  if (isMCPMode()) return;
  console.error(...args);
}

export function logError(...args: any[]): void {
  if (isMCPMode()) return;
  console.error(...args);
}
