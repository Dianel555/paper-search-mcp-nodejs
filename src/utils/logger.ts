/**
 * Logger utility with automatic log rotation
 * Uses winston for logging and winston-daily-rotate-file for log rotation
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log directory path
const logDir = path.join(__dirname, '../../logs');

// Ensure log directory exists
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

// Custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Daily rotate file transport for access logs
const accessLogTransport = new DailyRotateFile({
  filename: path.join(logDir, 'access-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d', // Keep logs for 14 days
  format: logFormat,
  level: 'info',
});

// Daily rotate file transport for error logs
const errorLogTransport = new DailyRotateFile({
  filename: path.join(logDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d', // Keep error logs for 30 days
  format: logFormat,
  level: 'error',
});

// Daily rotate file transport for combined logs
const combinedLogTransport = new DailyRotateFile({
  filename: path.join(logDir, 'combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '7d', // Keep combined logs for 7 days
  format: logFormat,
});

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    accessLogTransport,
    errorLogTransport,
    combinedLogTransport,
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
    }),
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
    }),
  ],
});

// Add console transport in development mode
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

// Helper functions for structured logging
export const logToolCall = (toolName: string, args: any, sessionId?: string) => {
  logger.info('Tool call', {
    type: 'tool_call',
    tool: toolName,
    arguments: args,
    sessionId,
    timestamp: new Date().toISOString(),
  });
};

export const logToolResponse = (
  toolName: string,
  success: boolean,
  duration: number,
  error?: string,
  sessionId?: string
) => {
  const level = success ? 'info' : 'error';
  logger.log(level, 'Tool response', {
    type: 'tool_response',
    tool: toolName,
    success,
    duration,
    error,
    sessionId,
    timestamp: new Date().toISOString(),
  });
};

export const logAccess = (method: string, path: string, sessionId?: string, statusCode?: number) => {
  logger.info('HTTP access', {
    type: 'access',
    method,
    path,
    sessionId,
    statusCode,
    timestamp: new Date().toISOString(),
  });
};

export const logError = (error: Error, context?: any) => {
  logger.error('Error occurred', {
    type: 'error',
    message: error.message,
    stack: error.stack,
    context,
    timestamp: new Date().toISOString(),
  });
};

export const logInfo = (message: string, meta?: any) => {
  logger.info(message, { ...meta, timestamp: new Date().toISOString() });
};

export const logWarning = (message: string, meta?: any) => {
  logger.warn(message, { ...meta, timestamp: new Date().toISOString() });
};

export default logger;
