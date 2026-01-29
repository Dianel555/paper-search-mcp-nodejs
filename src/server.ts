#!/usr/bin/env node
/**
 * Paper Search MCP Server - Node.js Implementation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  InitializeRequestSchema,
  PingRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import * as dotenv from 'dotenv';
import { TOOLS } from './mcp/tools.js';
import { initializeSearchers } from './mcp/searchers.js';
import { handleToolCall } from './mcp/handleToolCall.js';
import { isMCPMode, logDebug } from './utils/Logger.js';

dotenv.config();

const server = new Server(
  {
    name: 'paper-search-mcp-nodejs',
    version: '0.2.6'
  },
  {
    capabilities: {
      tools: {
        listChanged: true
      }
    }
  }
);

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
      version: '0.2.6'
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

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args } = request.params;
  logDebug(`Received tools/call request: ${name}`);

  try {
    const currentSearchers = initializeSearchers();
    return await handleToolCall(name, args, currentSearchers);
  } catch (error: any) {
    logDebug(`Error in tool ${name}:`, error);
    return {
      content: [
        {
          type: 'text',
          text: `Error executing tool '${name}': ${error?.message || 'Unknown error occurred'}`
        }
      ],
      isError: true
    };
  }
});

/**
 * 启动服务器
 */
async function main() {
  try {
    logDebug('Starting Paper Search MCP Server (Node.js)...');
    logDebug(`Working directory: ${process.cwd()}`);
    logDebug(`Node.js version: ${process.version}`);
    logDebug('Process arguments:', process.argv);
    
    // 连接到标准输入输出传输
    const transport = new StdioServerTransport();
    
    logDebug('Connecting to stdio transport...');
    await server.connect(transport);
    
    logDebug('Paper Search MCP Server is running');
  } catch (error) {
    logDebug('Failed to start server:', error);
    process.exit(1);
  }
}

// 处理未捕获的错误 - MCP模式下更温和
process.on('uncaughtException', (error) => {
  if (!isMCPMode()) {
    logDebug('Uncaught Exception:', error);
    process.exit(1);
  }
  // MCP模式下不立即退出，避免干扰协议通信
});

process.on('unhandledRejection', (reason, promise) => {
  if (!isMCPMode()) {
    logDebug('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  }
});

// 启动服务器 - 直接调用main()确保服务器总是启动
main().catch((error) => {
  logDebug('Failed to start MCP server:', error);
  process.exit(1);
});