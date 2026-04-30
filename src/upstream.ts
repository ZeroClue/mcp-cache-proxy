import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerConfig } from './config.js';

export class UpstreamManager {
  private clients: Map<string, Client> = new Map();
  private processes: Map<string, ChildProcess> = new Map();

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

  async callTool(serverName: string, toolName: string, args: unknown): Promise<unknown> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Upstream server ${serverName} not connected`);
    }

    const result = await client.callTool({
      name: toolName,
      arguments: args as Record<string, unknown> | undefined
    });
    return result;
  }

  async listTools(serverName: string): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Upstream server ${serverName} not connected`);
    }

    const result = await client.listTools();
    return result.tools;
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
