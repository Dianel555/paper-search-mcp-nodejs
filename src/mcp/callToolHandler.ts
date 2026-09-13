import type { Searchers } from './searchers.js';
import { handleToolCall } from './handleToolCall.js';
import { initializeSearchers } from './searchers.js';
import { logDebug } from '../utils/Logger.js';
import { sanitizeSensitiveText } from '../utils/SecurityUtils.js';

export interface McpCallToolRequest {
  readonly params: {
    readonly name: string;
    readonly arguments?: unknown;
  };
}

export interface McpRequestExtra {
  readonly signal: AbortSignal;
}

/** The same callback shape registered by the stdio MCP server. */
export function createCallToolHandler(
  searcherFactory: () => Searchers = initializeSearchers
): (request: McpCallToolRequest, extra: McpRequestExtra) => Promise<any> {
  return async (request, extra) => {
    const { name, arguments: args } = request.params;
    logDebug(`Received tools/call request: ${name}`);

    try {
      const currentSearchers = searcherFactory();
      const operation = currentSearchers.retrievalService.createOperation({ signal: extra.signal });
      try {
        return await handleToolCall(name, args, currentSearchers, operation);
      } finally {
        operation.dispose();
      }
    } catch (error: any) {
      logDebug(`Error in tool ${name}:`, error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool '${name}': ${sanitizeSensitiveText(error?.message || 'Unknown error occurred')}`
          }
        ],
        isError: true
      };
    }
  };
}

export default createCallToolHandler;
