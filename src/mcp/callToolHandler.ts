import type { Searchers } from './searchers.js';
import { handleToolCall, retrievalPurposeForToolCall } from './handleToolCall.js';
import { parseToolArgs, type ToolName } from './schemas.js';
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
      // Parse first so malformed tool input cannot create a retrieval
      // operation or reach any business/provider boundary.
      const parsedArgs = parseToolArgs(name as ToolName, args);
      const currentSearchers = searcherFactory();
      const operation = currentSearchers.retrievalService.createOperation({
        signal: extra.signal,
        purpose: retrievalPurposeForToolCall(name as ToolName, parsedArgs)
      });
      try {
        return await handleToolCall(name, parsedArgs, currentSearchers, operation);
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
