'use strict';

/**
 * Node.js port of the Driver `Tool` trait.
 *
 * Turbo-comfy. Params are an ordered array of `{ name, type, description }`.
 * Order matters — it's the positional order args are passed to `call`. `type`
 * is optional: omit it and it's inferred at runtime from the `call` signature
 * (default-value literals).
 *
 *   const fetchUsers = defineTool({
 *     name: 'fetch_users',
 *     params: [
 *       { name: 'page',  type: 'number', description: 'zero-based page index' },
 *       { name: 'limit', description: 'max users to return' }, // type inferred
 *     ],
 *     call: (page = 0, limit = 20) => db.users(page, limit),
 *   });
 *
 * `call` gets positional args spread in, returns any plain value (or a Promise),
 * and throws normally. Wrapping into ToolResult / ToolError is internal.
 */

/** Max length of a param description (chars). */
const PARAM_DESC_MAX = 200;

/** A single declared parameter. Mirrors Rust `Param`. */
class Param {
  /**
   * @param {object|string} opts  name, or { name, type, description, required }
   */
  constructor(opts = {}) {
    const o = typeof opts === 'string' ? { name: opts } : opts;
    if (!o.name) throw new Error('Param: name is required');
    const description = o.description || '';
    if (description.length > PARAM_DESC_MAX) {
      throw new Error(
        `Param "${o.name}": description is ${description.length} chars, max ${PARAM_DESC_MAX}`
      );
    }
    this.name = o.name;
    this.type = o.type || 'unknown'; // inferred later when built from a function
    this.description = description;
    this.required = o.required !== false;
  }

  toJSON() {
    return { name: this.name, type: this.type, description: this.description, required: this.required };
  }

  /**
   * Wire form the server expects: a `[name, type]` tuple. The kernel's catalog
   * only renders `name(type)` — description/required stay client-side.
   */
  toWire() {
    return [this.name, this.type];
  }
}

// ── runtime signature analysis ────────────────────────────────────────────────

/** Infer a coarse type from a default-value expression source. */
function inferType(def) {
  if (def === undefined || def === '') return 'unknown';
  const d = def.trim();
  if (/^['"`]/.test(d)) return 'string';
  if (/^(true|false)\b/.test(d)) return 'boolean';
  if (/^[-+]?(?:\d|\.\d)/.test(d) || /^(?:0x|0b|0o)/i.test(d) || /^BigInt\b/.test(d)) return 'number';
  if (/^\[/.test(d)) return 'array';
  if (/^\{/.test(d) || /^new\s+Object\b/.test(d)) return 'object';
  return 'unknown';
}

/** Split a string on top-level `sep`, respecting brackets and string literals. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let last = 0;
  let str = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      if (c === str && s[i - 1] !== '\\') str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') str = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  if (s.slice(last).trim()) out.push(s.slice(last));
  return out;
}

/** Pull the raw param-list source out of a function's `toString()`. */
function extractParamSource(src) {
  const s = src.trim();
  // arrow with a single bare identifier: `x => …`
  const bare = s.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
  if (bare) return bare[1];
  const open = s.indexOf('(');
  if (open === -1) return '';
  let depth = 0;
  let i = open;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) break;
  }
  return s.slice(open + 1, i);
}

/**
 * Parse a function's signature into ordered params with inferred types.
 * Best-effort: rest params and destructured params are flagged and skipped for
 * positional listing. Returns [] when the source can't be analyzed.
 * @returns {Array<{ name: string, type: string, rest: boolean, destructured: boolean }>}
 */
function parseSignature(fn) {
  let src;
  try {
    src = Function.prototype.toString.call(fn);
  } catch (_) {
    return [];
  }
  if (/\{\s*\[native code\]\s*\}/.test(src)) return []; // native / bound fn

  const paramSrc = extractParamSource(src);
  if (!paramSrc.trim()) return [];

  return splitTop(paramSrc, ',')
    .map((part) => {
      let p = part.trim();
      if (!p) return null;
      let rest = false;
      // split off a top-level default (`= expr`)
      const [head, ...tail] = splitTop(p, '=');
      const def = tail.length ? tail.join('=').trim() : undefined;
      let name = head.trim();
      if (name.startsWith('...')) {
        rest = true;
        name = name.slice(3).trim();
      }
      const destructured = name.startsWith('{') || name.startsWith('[');
      return { name, type: inferType(def), rest, destructured };
    })
    .filter(Boolean);
}

/**
 * Build the catalog Param[] for a tool: order and types come from the function
 * signature; descriptions come from the `{ name: description }` map.
 * @param {object|string|Array} spec  description map (preferred), or string/array
 * @param {Function} [fn]
 * @returns {Param[]}
 */
function normalizeParams(spec, fn) {
  const sig = fn ? parseSignature(fn) : [];
  const typeByName = {};
  sig.forEach((s) => { typeByName[s.name] = s.type; });

  // Explicit array / 'a, b, c' string → honor as given, enrich type from sig.
  if (Array.isArray(spec) || typeof spec === 'string') {
    const list = typeof spec === 'string' ? spec.split(',') : spec;
    return list
      .map((p) => (typeof p === 'string' ? p.trim() : p))
      .filter((p) => p !== '' && p != null)
      .map((p) => {
        const param = p instanceof Param ? p : new Param(p);
        if (param.type === 'unknown' && typeByName[param.name]) param.type = typeByName[param.name];
        return param;
      });
  }

  // Object map `{ name: description }` (the comfy path), or nothing.
  const descMap = spec && typeof spec === 'object' ? spec : {};

  if (sig.length) {
    return sig
      .filter((s) => s.name && !s.rest && !s.destructured)
      .map((s) => new Param({ name: s.name, type: s.type, description: descMap[s.name] || '' }));
  }
  // Couldn't analyze the function — fall back to the described names, type unknown.
  return Object.keys(descMap).map((name) => new Param({ name, type: 'unknown', description: descMap[name] }));
}

// ── result / error wrappers (internal) ────────────────────────────────────────

/** Successful tool output. Internal wrapper — `call` returns plain values. */
class ToolResult {
  constructor(value, meta = {}) {
    this.value = value;
    this.meta = meta;
  }

  static of(value, meta) {
    return new ToolResult(value, meta);
  }

  toJSON() {
    return { ok: true, value: this.value, meta: this.meta };
  }
}

/** Tool failure. Internal wrapper for a throw out of `call`. */
class ToolError extends Error {
  constructor(message, { category = 'tool', cause } = {}) {
    super(message);
    this.name = 'ToolError';
    this.category = category;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON() {
    return { ok: false, category: this.category, message: this.message };
  }
}

// ── Tool ──────────────────────────────────────────────────────────────────────

/**
 * Base class equivalent of the Rust `Tool` trait. Subclass and override, or
 * just use `defineTool`.
 */
class Tool {
  /** Fully-qualified id, conventionally `module.member` (e.g. `fs.read_file`). */
  name() {
    throw new ToolError('Tool.name() not implemented', { category: 'engine' });
  }

  /** One-line description shown in the catalog — the only thing the LLM sees. */
  description() {
    return '';
  }

  /** Ordered params: `[{ name, type?, description? }]`. Types inferred from `call`. */
  params() {
    return [];
  }

  /** Execute. Positional args spread in; return any plain value. May be async. */
  call(...args) { // eslint-disable-line no-unused-vars
    throw new ToolError('Tool.call() not implemented', { category: 'engine' });
  }

  /**
   * Catalog entry sent to the cloud — the `tools` payload shape. `params` are
   * `[name, type]` tuples (what the server's RunRequest expects); per-param
   * descriptions stay client-side.
   */
  toJSON() {
    return {
      name: this.name(),
      description: this.description(),
      params: normalizeParams(this.params(), this.call).map((p) => p.toWire()),
    };
  }

  /**
   * Run `call`, normalizing the return into a ToolResult and any throw into a
   * ToolError. Always resolves; never rejects.
   * @param {Array<*>} args  positional args (spread into `call`)
   */
  async callSafe(args = []) {
    try {
      const out = await this.call(...args);
      return out instanceof ToolResult ? out : new ToolResult(out);
    } catch (e) {
      if (e instanceof ToolError) return e;
      return new ToolError(e && e.message ? e.message : String(e), { category: 'tool', cause: e });
    }
  }
}

/**
 * Build a Tool from a plain spec — no class, no wrapping.
 *
 *   defineTool({
 *     name: 'fetch_users',
 *     description: 'List users.',      // optional
 *     params: [
 *       { name: 'page',  type: 'number', description: 'page index' },
 *       { name: 'limit', description: 'page size' }, // type inferred
 *     ],
 *     call: (page = 0, limit = 20) => fetchUsers(page, limit),
 *   });
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} [spec.description]
 * @param {Array<{name: string, type?: string, description?: string}>} [spec.params]
 * @param {(...args: any[]) => any} spec.call
 * @returns {Tool}
 */
function defineTool(spec = {}) {
  if (!spec.name) throw new Error('defineTool: name is required');
  if (typeof spec.call !== 'function') throw new Error('defineTool: call must be a function');

  // Build params eagerly so a too-long description fails fast at definition time.
  const params = normalizeParams(spec.params, spec.call);

  const t = new Tool();
  t.name = () => spec.name;
  t.description = () => spec.description || '';
  t.params = () => params;
  t.call = spec.call;
  return t;
}

module.exports = {
  Tool,
  Param,
  ToolResult,
  ToolError,
  defineTool,
  parseSignature,
  normalizeParams,
  PARAM_DESC_MAX,
};
