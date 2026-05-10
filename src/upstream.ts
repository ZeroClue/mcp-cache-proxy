import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerConfig } from './config.js';

/**
 * Error types for failover classification
 */
export type ErrorType =
  | 'quota_exceeded'
  | 'timeout'
  | 'connection_refused'
  | 'http_4xx'
  | 'http_5xx'
  | 'upstream_down'
  | 'unknown';

/**
 * Classified error with retryable flag
 */
export interface ClassifiedError {
  error: Error;
  type: ErrorType;
  retryable: boolean;
}

/**
 * Per-server request statistics
 */
export interface ServerStats {
  totalRequests: number;
  successful: number;
  failed: number;
  failedByTool: Record<string, number>;
  failedByErrorType: Record<string, number>;
  activeRequests: number;
}

/**
 * Aggregate proxy statistics across all servers
 */
export interface ProxyStats {
  totalRequests: number;
  successful: number;
  failed: number;
  successfulByServer: Record<string, number>;
  failedByServer: Record<string, number>;
  byServer: Record<string, ServerStats>;
}

export class UpstreamManager {
  private clients: Map<string, Client> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private serverStats: Map<string, ServerStats> = new Map();
  private activeRequests: Map<string, number> = new Map();

  async connect(serverName: string, config: ServerConfig): Promise<Client> {
    if (this.clients.has(serverName)) {
      return this.clients.get(serverName)!;
    }

    const client = new Client({
      name: `mcp-cache-proxy-${serverName}`,
      version: '0.1.0'
    }, {
      capabilities: {}
    });

    let transport;

    if (config.url) {
      // HTTP-based server (streamable HTTP transport)
      const headers: Record<string, string> = {};
      if (config.env) {
        // Collect all environment variables as headers
        for (const [key, value] of Object.entries(config.env)) {
          // If value is empty string, try to get from process.env
          const headerValue = value || process.env[key];
          if (headerValue) {
            // Convert env var names to header format (e.g., ANTHROPIC_AUTH_TOKEN -> Authorization)
            if (key.includes('AUTH_TOKEN') || key.includes('API_KEY')) {
              headers['Authorization'] = headerValue;
            } else {
              headers[key] = headerValue;
            }
          }
        }
      }

      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers
          }
        }
      );
    } else if (config.command) {
      // Stdio-based server
      const childProcess = spawn(config.command, config.args || [], {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'inherit']
      });
      this.processes.set(serverName, childProcess);
      transport = new StdioServerTransport(
        childProcess.stdout,
        childProcess.stdin
      );
    } else {
      throw new Error(`Server ${serverName} must have either 'url' or 'command'`);
    }

    await client.connect(transport);
    this.clients.set(serverName, client);

    return client;
  }

  private ensureServerStats(serverName: string): ServerStats {
    if (!this.serverStats.has(serverName)) {
      this.serverStats.set(serverName, {
        totalRequests: 0,
        successful: 0,
        failed: 0,
        failedByTool: {},
        failedByErrorType: {},
        activeRequests: 0
      });
    }
    return this.serverStats.get(serverName)!;
  }

  async callTool(serverName: string, toolName: string, args: unknown): Promise<unknown> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Upstream server ${serverName} not connected`);
    }

    // Initialize stats for this server
    const stats = this.ensureServerStats(serverName);

    // Track active request
    stats.totalRequests++;
    stats.activeRequests++;
    this.activeRequests.set(serverName, (this.activeRequests.get(serverName) || 0) + 1);

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown> | undefined
      });

      // Track success
      stats.successful++;

      return result;
    } catch (error) {
      // Track failure
      stats.failed++;

      // Track failure by tool
      stats.failedByTool[toolName] = (stats.failedByTool[toolName] || 0) + 1;

      // Track failure by error type
      const classified = classifyError(error);
      stats.failedByErrorType[classified.type] = (stats.failedByErrorType[classified.type] || 0) + 1;

      throw error;
    } finally {
      // Decrement active request
      stats.activeRequests--;
      this.activeRequests.set(serverName, Math.max(0, (this.activeRequests.get(serverName) || 0) - 1));
    }
  }

  async listTools(serverName: string): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Upstream server ${serverName} not connected`);
    }

    const result = await client.listTools();
    return result.tools;
  }

  /**
   * Get aggregate proxy statistics across all servers
   */
  getProxyStats(): ProxyStats {
    let totalRequests = 0;
    let successful = 0;
    let failed = 0;
    const successfulByServer: Record<string, number> = {};
    const failedByServer: Record<string, number> = {};

    // Build byServer object (deep copy to avoid mutation)
    const byServer: Record<string, ServerStats> = {};
    for (const [serverName, stats] of this.serverStats.entries()) {
      totalRequests += stats.totalRequests;
      successful += stats.successful;
      failed += stats.failed;

      // Only add to successfulByServer if there are successful requests
      if (stats.successful > 0) {
        successfulByServer[serverName] = stats.successful;
      }

      // Only add to failedByServer if there are failed requests
      if (stats.failed > 0) {
        failedByServer[serverName] = stats.failed;
      }

      // Deep copy the stats object
      byServer[serverName] = {
        totalRequests: stats.totalRequests,
        successful: stats.successful,
        failed: stats.failed,
        failedByTool: { ...stats.failedByTool },
        failedByErrorType: { ...stats.failedByErrorType },
        activeRequests: stats.activeRequests
      };
    }

    return {
      totalRequests,
      successful,
      failed,
      successfulByServer,
      failedByServer,
      byServer
    };
  }

  /**
   * Reset stats for a specific server or all servers
   */
  resetStats(serverName?: string): void {
    if (serverName) {
      this.serverStats.delete(serverName);
      this.activeRequests.delete(serverName);
    } else {
      this.serverStats.clear();
      this.activeRequests.clear();
    }
  }

  close(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    for (const process of this.processes.values()) {
      process.kill();
    }
    this.clients.clear();
    this.processes.clear();
  }
}

/**
 * Classify an error into a specific error type for failover decisions.
 * 
 * Detection rules:
 * - quota_exceeded: Response contains "quota" or "limit" (case-insensitive), or HTTP 429
 * - timeout: ECONNABORTED, ETIMEDOUT, or request exceeds timeout
 * - connection_refused: ECONNREFUSED or message contains "Connection refused"
 * - http_4xx: HTTP status 400-499
 * - http_5xx: HTTP status 500-599
 * - upstream_down: All retries to upstream fail (circuit breaker state)
 * - unknown: Catch-all for unclassified errors
 * 
 * @param error - The error to classify
 * @returns ClassifiedError with type and retryable flag
 */
export function classifyError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message.toLowerCase();
  const errorMessage = err.message;
  
  // Check for quota exceeded errors
  if (
    message.includes('quota') ||
    message.includes('limit') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    // HTTP 429 is typically rate limit
    message.includes('429')
  ) {
    return { error: err, type: 'quota_exceeded', retryable: true };
  }
  
  // Check for timeout errors
  if (
    message.includes('etimedout') ||
    message.includes('econnaborted') ||
    message.includes('timeout') ||
    message.includes('timed out')
  ) {
    return { error: err, type: 'timeout', retryable: true };
  }
  
  // Check for connection refused errors
  if (
    message.includes('econnrefused') ||
    message.includes('connection refused') ||
    message.includes('econnreset')
  ) {
    return { error: err, type: 'connection_refused', retryable: true };
  }
  
  // Check for HTTP 4xx errors (client errors, typically not retryable)
  // But 429 (rate limit) is already handled above as quota_exceeded
  if (
    message.includes('400') ||
    message.includes('401') ||
    message.includes('403') ||
    message.includes('404') ||
    message.includes('http 4')
  ) {
    return { error: err, type: 'http_4xx', retryable: false };
  }
  
  // Check for HTTP 5xx errors (server errors, typically retryable)
  if (
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('http 5')
  ) {
    return { error: err, type: 'http_5xx', retryable: true };
  }
  
  // Check for upstream down errors
  if (
    message.includes('upstream') ||
    message.includes('service unavailable') ||
    message.includes('bad gateway')
  ) {
    return { error: err, type: 'upstream_down', retryable: true };
  }
  
  // Default: unknown error
  return { error: err, type: 'unknown', retryable: false };
}
