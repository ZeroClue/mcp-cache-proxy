import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { UpstreamManager, classifyError } from '../src/upstream.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('Proxy Stats', () => {
  let upstreamManager: UpstreamManager;

  before(async () => {
    upstreamManager = new UpstreamManager();
  });

  after(() => {
    try {
      upstreamManager.close();
    } catch (error) {
      // Ignore if close fails due to mocks
    }
  });

  describe('getProxyStats()', () => {
    beforeEach(() => {
      // Reset stats before each test
      upstreamManager.resetStats();
    });

    it('should return empty stats when no requests have been made', () => {
      const stats = upstreamManager.getProxyStats();

      assert.strictEqual(stats.totalRequests, 0);
      assert.strictEqual(stats.successful, 0);
      assert.strictEqual(stats.failed, 0);
      assert.deepStrictEqual(stats.successfulByServer, {});
      assert.deepStrictEqual(stats.failedByServer, {});
      assert.deepStrictEqual(stats.byServer, {});
    });

    it('should track successful requests', async () => {
      // Mock a successful callTool
      const mockClient = {
        callTool: mock.fn(async (params: unknown) => {
          return { content: [{ type: 'text', text: 'success' }] };
        })
      } as unknown as Client;

      // Manually add the client to bypass connect() for testing
      (upstreamManager as any).clients.set('test-server', mockClient);

      await upstreamManager.callTool('test-server', 'test_tool', { query: 'test' });

      const stats = upstreamManager.getProxyStats();

      assert.strictEqual(stats.totalRequests, 1);
      assert.strictEqual(stats.successful, 1);
      assert.strictEqual(stats.failed, 0);
      assert.strictEqual(stats.successfulByServer['test-server'], 1);
      // failedByServer should not have an entry for servers with 0 failures
      assert.strictEqual(stats.failedByServer['test-server'], undefined);

      assert(stats.byServer['test-server']);
      assert.strictEqual(stats.byServer['test-server'].totalRequests, 1);
      assert.strictEqual(stats.byServer['test-server'].successful, 1);
      assert.strictEqual(stats.byServer['test-server'].failed, 0);
      assert.deepStrictEqual(stats.byServer['test-server'].failedByTool, {});
      assert.deepStrictEqual(stats.byServer['test-server'].failedByErrorType, {});
      assert.strictEqual(stats.byServer['test-server'].activeRequests, 0);
    });

    it('should track failed requests with error classification', async () => {
      const mockClient = {
        callTool: mock.fn(async (params: unknown) => {
          throw new Error('quota exceeded: too many requests');
        })
      } as unknown as Client;

      (upstreamManager as any).clients.set('test-server-2', mockClient);

      try {
        await upstreamManager.callTool('test-server-2', 'search_tool', { query: 'test' });
        assert.fail('Should have thrown an error');
      } catch (error) {
        // Expected error
      }

      const stats = upstreamManager.getProxyStats();

      assert.strictEqual(stats.totalRequests, 1);
      assert.strictEqual(stats.successful, 0);
      assert.strictEqual(stats.failed, 1);
      assert.strictEqual(stats.failedByServer['test-server-2'], 1);

      assert(stats.byServer['test-server-2']);
      assert.strictEqual(stats.byServer['test-server-2'].failed, 1);
      assert.strictEqual(stats.byServer['test-server-2'].failedByTool['search_tool'], 1);
      assert.strictEqual(stats.byServer['test-server-2'].failedByErrorType['quota_exceeded'], 1);
    });

    it('should aggregate stats across multiple servers', async () => {
      const mockClient1 = {
        callTool: mock.fn(async (params: unknown) => ({ content: [] }))
      } as unknown as Client;

      const mockClient2 = {
        callTool: mock.fn(async (params: unknown) => {
          throw new Error('connection refused');
        })
      } as unknown as Client;

      (upstreamManager as any).clients.set('server-a', mockClient1);
      (upstreamManager as any).clients.set('server-b', mockClient2);

      // Make 3 successful calls to server-a
      await upstreamManager.callTool('server-a', 'tool1', {});
      await upstreamManager.callTool('server-a', 'tool2', {});
      await upstreamManager.callTool('server-a', 'tool1', {});

      // Make 2 failed calls to server-b
      for (let i = 0; i < 2; i++) {
        try {
          await upstreamManager.callTool('server-b', 'tool3', {});
          assert.fail('Should have thrown');
        } catch (error) {
          // Expected
        }
      }

      const stats = upstreamManager.getProxyStats();

      // Aggregate stats
      assert.strictEqual(stats.totalRequests, 5);
      assert.strictEqual(stats.successful, 3);
      assert.strictEqual(stats.failed, 2);
      assert.strictEqual(stats.successfulByServer['server-a'], 3);
      assert.strictEqual(stats.failedByServer['server-b'], 2);

      // Per-server stats
      assert.strictEqual(stats.byServer['server-a'].totalRequests, 3);
      assert.strictEqual(stats.byServer['server-a'].successful, 3);
      assert.strictEqual(stats.byServer['server-a'].failed, 0);

      assert.strictEqual(stats.byServer['server-b'].totalRequests, 2);
      assert.strictEqual(stats.byServer['server-b'].successful, 0);
      assert.strictEqual(stats.byServer['server-b'].failed, 2);
      assert.strictEqual(stats.byServer['server-b'].failedByErrorType['connection_refused'], 2);
    });

    it('should track active requests during execution', async () => {
      const mockClient = {
        callTool: mock.fn(async (params: unknown) => {
          // Simulate a slow request
          await new Promise(resolve => setTimeout(resolve, 100));
          return { content: [] };
        })
      } as unknown as Client;

      (upstreamManager as any).clients.set('slow-server', mockClient);

      const promise = upstreamManager.callTool('slow-server', 'slow_tool', {});

      // Check stats while request is in flight
      const inFlightStats = upstreamManager.getProxyStats();
      assert.strictEqual(inFlightStats.byServer['slow-server']?.activeRequests, 1);

      // Wait for completion
      await promise;

      // Check stats after completion
      const completedStats = upstreamManager.getProxyStats();
      assert.strictEqual(completedStats.byServer['slow-server']?.activeRequests, 0);
    });
  });

  describe('resetStats()', () => {
    beforeEach(() => {
      // Reset stats before each test
      upstreamManager.resetStats();
    });

    it('should reset stats for a specific server', async () => {
      const mockClient = {
        callTool: mock.fn(async (params: unknown) => ({ content: [] }))
      } as unknown as Client;

      (upstreamManager as any).clients.set('reset-test-server', mockClient);
      await upstreamManager.callTool('reset-test-server', 'tool', {});

      const beforeStats = upstreamManager.getProxyStats();
      assert.strictEqual(beforeStats.byServer['reset-test-server']?.totalRequests, 1);

      upstreamManager.resetStats('reset-test-server');

      const afterStats = upstreamManager.getProxyStats();
      assert.strictEqual(afterStats.byServer['reset-test-server'], undefined);
    });

    it('should reset all stats when no server name is provided', async () => {
      const mockClient = {
        callTool: mock.fn(async (params: unknown) => ({ content: [] }))
      } as unknown as Client;

      (upstreamManager as any).clients.set('server1', mockClient);
      (upstreamManager as any).clients.set('server2', mockClient);

      await upstreamManager.callTool('server1', 'tool', {});
      await upstreamManager.callTool('server2', 'tool', {});

      const beforeStats = upstreamManager.getProxyStats();
      assert.strictEqual(beforeStats.totalRequests, 2);

      upstreamManager.resetStats();

      const afterStats = upstreamManager.getProxyStats();
      assert.strictEqual(afterStats.totalRequests, 0);
      assert.deepStrictEqual(afterStats.byServer, {});
    });
  });

  describe('Error Classification', () => {
    it('should classify quota exceeded errors', () => {
      const error = new Error('quota exceeded: too many requests');
      const classified = classifyError(error);

      assert.strictEqual(classified.type, 'quota_exceeded');
      assert.strictEqual(classified.retryable, true);
    });

    it('should classify timeout errors', () => {
      const error = new Error('ETIMEDOUT: connection timeout');
      const classified = classifyError(error);

      assert.strictEqual(classified.type, 'timeout');
      assert.strictEqual(classified.retryable, true);
    });

    it('should classify connection refused errors', () => {
      const error = new Error('ECONNREFUSED: connection refused');
      const classified = classifyError(error);

      assert.strictEqual(classified.type, 'connection_refused');
      assert.strictEqual(classified.retryable, true);
    });

    it('should classify HTTP 4xx errors', () => {
      const error = new Error('HTTP 404: not found');
      const classified = classifyError(error);

      assert.strictEqual(classified.type, 'http_4xx');
      assert.strictEqual(classified.retryable, false);
    });

    it('should classify HTTP 5xx errors', () => {
      const error = new Error('HTTP 503: service unavailable');
      const classified = classifyError(error);

      assert.strictEqual(classified.type, 'http_5xx');
      assert.strictEqual(classified.retryable, true);
    });

    it('should classify unknown errors', () => {
      const error = new Error('something went wrong');
      const classified = classifyError(error);

      assert.strictEqual(classified.type, 'unknown');
      assert.strictEqual(classified.retryable, false);
    });
  });
});
