import { createHash } from 'node:crypto';

interface CanonicalizerReplacer {
  (key: string, value: unknown): unknown;
}

function generateKey(toolName: string, args: unknown): string {
  const replacer: CanonicalizerReplacer = (_, value) => {
    if (typeof value === 'string') {
      return value.trim().toLowerCase();
    }
    return value;
  };

  const normalized = JSON.stringify(args, replacer);
  const sorted = canonicalizeObject(JSON.parse(normalized));

  const input = toolName + JSON.stringify(sorted);
  return createHash('sha256').update(input).digest('hex');
}

function canonicalizeObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(canonicalizeObject);
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    result[key] = canonicalizeObject((obj as Record<string, unknown>)[key]);
  }
  return result;
}

export { generateKey };
