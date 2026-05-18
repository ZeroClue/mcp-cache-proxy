import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyError, type ClassifiedError } from '../dist/upstream.js';

describe('Error Classification (Phase 1)', () => {
  it('should classify quota_exceeded errors', () => {
    const result = classifyError(new Error('Quota exceeded'));
    assert.strictEqual(result.type, 'quota_exceeded');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify limit errors as quota_exceeded', () => {
    const result = classifyError(new Error('Rate limit exceeded'));
    assert.strictEqual(result.type, 'quota_exceeded');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify 429 errors as quota_exceeded', () => {
    const result = classifyError(new Error('429 Too Many Requests'));
    assert.strictEqual(result.type, 'quota_exceeded');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify timeout errors', () => {
    const result = classifyError(new Error('ETIMEDOUT'));
    assert.strictEqual(result.type, 'timeout');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify connection aborted errors as timeout', () => {
    const result = classifyError(new Error('ECONNABORTED'));
    assert.strictEqual(result.type, 'timeout');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify connection refused errors', () => {
    const result = classifyError(new Error('ECONNREFUSED'));
    assert.strictEqual(result.type, 'connection_refused');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify connection refused message errors', () => {
    const result = classifyError(new Error('Connection refused'));
    assert.strictEqual(result.type, 'connection_refused');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify http 4xx errors', () => {
    const result = classifyError(new Error('400 Bad Request'));
    assert.strictEqual(result.type, 'http_4xx');
    assert.strictEqual(result.retryable, false);
  });

  it('should classify http 401 errors', () => {
    const result = classifyError(new Error('401 Unauthorized'));
    assert.strictEqual(result.type, 'http_4xx');
    assert.strictEqual(result.retryable, false);
  });

  it('should classify http 5xx errors', () => {
    const result = classifyError(new Error('500 Internal Server Error'));
    assert.strictEqual(result.type, 'http_5xx');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify http 503 errors', () => {
    const result = classifyError(new Error('503 Service Unavailable'));
    assert.strictEqual(result.type, 'http_5xx');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify upstream down errors', () => {
    const result = classifyError(new Error('upstream server down'));
    assert.strictEqual(result.type, 'upstream_down');
    assert.strictEqual(result.retryable, true);
  });

  it('should classify unknown errors', () => {
    const result = classifyError(new Error('Some random error'));
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.retryable, false);
  });

  it('should handle non-Error objects', () => {
    const result = classifyError('string error');
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.retryable, false);
    assert.ok(result.error instanceof Error);
  });

  it('should handle null errors', () => {
    const result = classifyError(null);
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.retryable, false);
    assert.ok(result.error instanceof Error);
  });
});

