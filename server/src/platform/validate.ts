/**
 * A very small schema checker for request bodies: no dependency, errors as
 * readable paths ("payload.unit: expected a string"), and inferred types.
 */
export type Check<T> = (value: unknown, path: string, errors: string[]) => T;
export type Infer<C> = C extends Check<infer T> ? T : never;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type OptionalKeys<S> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
/** An object schema's type: fields checked with `v.optional` become optional properties. */
export type Shape<S> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

const describe = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value);

export const v = {
  string(opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Check<string> {
    const { min = 0, max = 10_000, pattern, trim = false } = opts;
    return (value, path, errors) => {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected a string, got ${describe(value)}`);
        return '';
      }
      const s = trim ? value.trim() : value;
      if (s.length < min) errors.push(`${path}: must be at least ${min} characters`);
      if (s.length > max) errors.push(`${path}: must be at most ${max} characters`);
      if (pattern && !pattern.test(s)) errors.push(`${path}: has an invalid format`);
      return s;
    };
  },
  number(opts: { min?: number; max?: number; int?: boolean } = {}): Check<number> {
    const { min = -Number.MAX_VALUE, max = Number.MAX_VALUE, int = false } = opts;
    return (value, path, errors) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path}: expected a finite number, got ${describe(value)}`);
        return 0;
      }
      if (int && !Number.isInteger(value)) errors.push(`${path}: must be a whole number`);
      if (value < min || value > max) errors.push(`${path}: must be between ${min} and ${max}`);
      return value;
    };
  },
  boolean(): Check<boolean> {
    return (value, path, errors) => {
      if (typeof value !== 'boolean') errors.push(`${path}: expected true or false, got ${describe(value)}`);
      return value === true;
    };
  },
  literal<T extends string>(values: readonly T[]): Check<T> {
    return (value, path, errors) => {
      if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
        errors.push(`${path}: must be one of ${values.join(', ')}`);
        return values[0]!;
      }
      return value as T;
    };
  },
  array<T>(item: Check<T>, opts: { min?: number; max?: number } = {}): Check<T[]> {
    const { min = 0, max = 10_000 } = opts;
    return (value, path, errors) => {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected an array, got ${describe(value)}`);
        return [];
      }
      if (value.length < min) errors.push(`${path}: needs at least ${min} items`);
      if (value.length > max) {
        errors.push(`${path}: at most ${max} items`);
        return [];
      }
      return value.map((entry, i) => item(entry, `${path}[${i}]`, errors));
    };
  },
  object<S extends Record<string, Check<unknown>>>(shape: S, opts: { extra?: boolean } = {}): Check<Shape<S>> {
    return (value, path, errors) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected an object, got ${describe(value)}`);
        return {} as Shape<S>;
      }
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = opts.extra ? { ...record } : {};
      for (const [key, check] of Object.entries(shape)) {
        const parsed = check(record[key], path ? `${path}.${key}` : key, errors);
        if (parsed !== undefined) out[key] = parsed;
      }
      if (!opts.extra) {
        for (const key of Object.keys(record)) if (!(key in shape)) errors.push(`${path ? `${path}.` : ''}${key}: is not a known field`);
      }
      return out as Shape<S>;
    };
  },
  optional<T>(check: Check<T>): Check<T | undefined> {
    return (value, path, errors) => (value === undefined ? undefined : check(value, path, errors));
  },
  nullable<T>(check: Check<T>): Check<T | null> {
    return (value, path, errors) => (value === null ? null : check(value, path, errors));
  },
  /** Any JSON value, bounded in size and depth. */
  json(opts: { maxBytes?: number; maxDepth?: number } = {}): Check<JsonValue> {
    const { maxBytes = 2 * 1024 * 1024, maxDepth = 32 } = opts;
    return (value, path, errors) => {
      if (value === undefined) {
        errors.push(`${path}: is required`);
        return null;
      }
      if (depthOf(value) > maxDepth) errors.push(`${path}: nested deeper than ${maxDepth}`);
      else if (JSON.stringify(value).length > maxBytes) errors.push(`${path}: larger than ${maxBytes} bytes`);
      return value as JsonValue;
    };
  },
  record<T>(item: Check<T>, opts: { maxKeys?: number } = {}): Check<Record<string, T>> {
    const { maxKeys = 1000 } = opts;
    return (value, path, errors) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected an object, got ${describe(value)}`);
        return {};
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > maxKeys) errors.push(`${path}: at most ${maxKeys} keys`);
      return Object.fromEntries(entries.map(([k, item2]) => [k, item(item2, `${path}.${k}`, errors)]));
    };
  },
  any(): Check<unknown> {
    return (value) => value;
  },
};

function depthOf(value: unknown, depth = 0): number {
  if (depth > 64) return depth;
  if (typeof value !== 'object' || value === null) return depth;
  let max = depth + 1;
  for (const child of Array.isArray(value) ? value : Object.values(value)) max = Math.max(max, depthOf(child, depth + 1));
  return max;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parse<T>(check: Check<T>, value: unknown, path = ''): Parsed<T> {
  const errors: string[] = [];
  const parsed = check(value, path, errors);
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, value: parsed };
}

/** Lower-case ids for streams, scopes and documents: letters, digits, dot, dash, underscore. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const STREAM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/;
export const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The scope a stream belongs to: `osu-2026-10-31/op-1` → `osu-2026-10-31`. */
export const scopeOfStream = (stream: string) => stream.split('/')[0]!;
