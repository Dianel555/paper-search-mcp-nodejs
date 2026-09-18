import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  InitializeRequestSchema,
  PingRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { initializeSearchers, type Searchers } from './searchers.js';
import { createCallToolHandler } from './callToolHandler.js';
import { logDebug } from '../utils/Logger.js';

/** Register the complete MCP request surface on a server instance. */
export function registerMcpHandlers(
  server: Server,
  searcherFactory: () => Searchers = initializeSearchers
): void {
  server.setRequestHandler(InitializeRequestSchema, async request => {
    logDebug('Received initialize request:', request.params);
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {
          listChanged: true
        }
      },
      serverInfo: {
        name: 'paper-search-mcp-nodejs',
        version: '0.3.2'
      }
    };
  });

  server.setRequestHandler(PingRequestSchema, async () => {
    logDebug('Received ping request');
    return {};
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logDebug('Received tools/list request');
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, createCallToolHandler(searcherFactory));
}

export default registerMcpHandlers;
