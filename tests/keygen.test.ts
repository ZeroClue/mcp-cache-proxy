import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateKey } from '../src/keygen.ts';

describe('generateKey', () => {
  it('should generate consistent keys for identical args', () => {
    const args = { query: 'test', limit: 10 };
    const key1 = generateKey('search', args);
    const key2 = generateKey('search', args);
    assert.strictEqual(key1, key2);
  });

  it('should generate different keys for different args', () => {
    const key1 = generateKey('search', { query: 'test' });
    const key2 = generateKey('search', { query: 'other' });
    assert.notStrictEqual(key1, key2);
  });

  it('should generate different keys for different tools', () => {
    const args = { query: 'test' };
    const key1 = generateKey('tool_a', args);
    const key2 = generateKey('tool_b', args);
    assert.notStrictEqual(key1, key2);
  });

  it('should be case-insensitive for string values', () => {
    const key1 = generateKey('search', { query: 'TEST' });
    const key2 = generateKey('search', { query: 'test' });
    assert.strictEqual(key1, key2);
  });

  it('should trim string values', () => {
    const key1 = generateKey('search', { query: '  test  ' });
    const key2 = generateKey('search', { query: 'test' });
    assert.strictEqual(key1, key2);
  });

  it('should handle nested objects with sorted keys', () => {
    const key1 = generateKey('search', { a: 1, b: { c: 2, d: 3 } });
    const key2 = generateKey('search', { b: { d: 3, c: 2 }, a: 1 });
    assert.strictEqual(key1, key2);
  });

  it('should produce 64-character hex hash', () => {
    const key = generateKey('search', { query: 'test' });
    assert.strictEqual(key.length, 64);
    assert.strictEqual(/^[a-f0-9]{64}$/.test(key), true);
  });
});
