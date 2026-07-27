'use strict';

const { EventEmitter } = require('events');
const { Tool, Param, ToolResult, ToolError, defineTool, parseSignature, normalizeParams, PARAM_DESC_MAX } = require('./tool');

const DEFAULT_BASE_URL = 'https://driver.tors.app';
const RUN_PATH = '/api/driver/run';

/** The only event kinds the client surfaces; everything else is dropped. */
const ALLOWED_KINDS = new Set(['plan', 'plan_item_start', 'action', 'done', 'fatal']);

/**
 * Node.js client for Driver cloud.
 *
 * You give it an API key (`dr_…`, the *machine* credential) and a prompt. It
 * POSTs to `/api/driver/run`, then streams the agent's events back over SSE in
 * real time — you don't wait for the run to finish.
 *
 * Events surface two ways:
 *   - EventEmitter: `driver.on('event', …)` firehose, plus per-kind channels
 *     (`driver.on('action', …)`, `driver.on('done', …)`, …).
 *   - Promise: `await driver.run(prompt)` resolves with the final `done` event.
 */
class Driver extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey  the `dr_…` API key (machine credential)
   * @param {string} [opts.baseUrl] cloud base URL; defaults to driver.tors.app
   * @param {typeof fetch} [opts.fetch] custom fetch impl (defaults to global fetch)
   * @param {object[]} [opts.tools] default tools sent with every `run`; a per-run
   *   `tools` option overrides this list for that call.
   * @param {boolean} [opts.zdr] request zero data retention for every run by
   *   default; a per-run `zdr` option overrides it. Needs the account
   *   entitlement — without it the server rejects the run with 403.
   * @param {string} [opts.engine] LLM backend for the runs:
   *   "openai" | "mistral" | "claude" | "openrouter". Left out, the cloud uses
   *   its default engine.
   * @param {string} [opts.model] model id for the selected engine.
   * @param {string} [opts.engineKey] bring-your-own key for the selected
   *   engine (NOT the `dr_…` credential — that's `apiKey`).
   */
  constructor(opts = {}) {
    super();
    const apiKey = opts.apiKey || process.env.DRIVER_API_KEY;
    if (!apiKey) {
      throw new Error('Driver: missing apiKey (pass { apiKey } or set DRIVER_API_KEY)');
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl || process.env.DRIVER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._fetch = opts.fetch || globalThis.fetch.bind(globalThis);
    if (typeof this._fetch !== 'function') {
      throw new Error('Driver: no fetch available — use Node 18+ or pass { fetch }');
    }
    this.tools = opts.tools || [];
    this.zdr = assertZdr(opts.zdr) ?? false;
    this.engine = opts.engine;
    this.model = opts.model;
    this.engineKey = opts.engineKey;
    // Choosing an engine requires bringing its key — the cloud rejects the
    // run otherwise. Fail here, at construction, instead of on the first run.
    if (this.engine && !this.engineKey) {
      throw new Error('the engine requires engineKey');
    }
  }

  /**
   * Run a prompt as an autonomous agent in the cloud, streaming events.
   *
   * @param {string} prompt        the task description
   * @param {object} [opts]
   * @param {(ev: object) => void} [opts.onEvent] per-event callback
   * @param {AbortSignal} [opts.signal] abort the stream early
   * @param {Array<Tool|object>} [opts.tools] tools for this run; overrides
   *   constructor `tools`. Tool instances run locally on `tool_request`.
   * @param {boolean} [opts.zdr] zero data retention for THIS run; overrides the
   *   constructor default. The cloud stores nothing the execution sees (no
   *   prompt, no event log, no outputs) — events stream here and die here.
   *   Requires the account entitlement; without it the run fails with 403.
   * @returns {Promise<object>} resolves with the final `done` event
   */
  async run(prompt, opts = {}) {
    const tools = opts.tools || this.tools;
    const body = { prompt };
    // Tool instances serialize to their catalog shape; plain dicts pass through.
    if (tools && tools.length) {
      body.tools = tools.map((t) => (t instanceof Tool ? t.toJSON() : t));
    }
    // Explicit per-run choice wins over the constructor default, both ways:
    // `zdr: false` on a zdr-by-default client forces a retained run.
    const zdr = assertZdr(opts.zdr) ?? this.zdr;
    if (zdr) body.zdr = true;
    // Engine config from the constructor rides along with every run.
    if (this.engine) body.engine = this.engine;
    if (this.model) body.model = this.model;
    if (this.engineKey) body.engineKey = this.engineKey;
    const res = await this._fetch(this.baseUrl + RUN_PATH, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Driver run failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
    }
    if (!res.body) {
      throw new Error('Driver run failed: empty response body (no SSE stream)');
    }

    // Registry of locally-runnable tools, keyed by name, for tool_request.
    const registry = new Map();
    for (const t of tools || []) if (t instanceof Tool) registry.set(t.name(), t);
    let runId = null;

    let done = null;
    for await (const ev of parseSSE(res.body)) {
      if (!ev || typeof ev.kind !== 'string') continue;
      // `run`: first event, carries the run_id we POST tool results against.
      if (ev.kind === 'run') {
        runId = ev.run_id;
        continue;
      }
      // `tool_request`: the cloud is asking us to run one of OUR tools locally
      // and hand back the result. Internal — not surfaced to the client.
      if (ev.kind === 'tool_request') {
        await this._answerToolRequest(runId, ev, registry, opts.signal);
        continue;
      }
      // Allowlist: only surface the five public kinds. Anything else is
      // dropped so internal events can never leak to the client.
      if (!ALLOWED_KINDS.has(ev.kind)) continue;
      if (opts.onEvent) opts.onEvent(ev);
      this.emit('event', ev);
      this.emit(ev.kind, ev);
      if (ev.kind === 'done') done = ev;
      if (ev.kind === 'fatal') {
        // Only the error category is exposed; the raw message stays server-side.
        throw new Error(ev.semantic || 'fatal');
      }
    }
    return done;
  }

  /**
   * Run a prompt with zero data retention. Sugar for `run(prompt, { zdr: true })`:
   * same streaming, same tools, same return — the cloud just never writes the
   * run down. Requires the account entitlement (403 otherwise).
   *
   * @param {string} prompt      the task description
   * @param {object} [opts]      same options as `run` (`zdr` is forced true)
   * @returns {Promise<object>} resolves with the final `done` event
   */
  runZdr(prompt, opts = {}) {
    return this.run(prompt, { ...opts, zdr: true });
  }

  /**
   * Run a locally-registered tool for a `tool_request` and POST the result back
   * to `/run/{runId}/result`. Never throws into the stream.
   * @param {string|null} runId
   * @param {object} ev        the tool_request event
   * @param {Map<string, Tool>} registry
   * @param {AbortSignal} [signal]
   */
  async _answerToolRequest(runId, ev, registry, signal) {
    const callId = ev.call_id;
    const name = String(ev.tool || '');
    if (!runId || callId == null) return; // nothing to answer against

    const tool = registry.get(name);
    if (!tool) {
      await this._postResult(runId, callId, { error: `unknown tool: ${name}` }, signal);
      return;
    }

    // Named-args wire: a single plain object keyed by param name is zipped
    // against the tool's declared param order (same contract as every other
    // host). Arrays pass through positionally; a bare scalar is one arg.
    const raw = ev.args;
    let args;
    if (Array.isArray(raw)) {
      args = raw;
    } else if (raw == null) {
      args = [];
    } else if (typeof raw === 'object') {
      const names = (tool.params() || []).map((p) => p.name);
      args = names.length ? names.map((n) => raw[n]) : [raw];
    } else {
      args = [raw];
    }

    const outcome = await tool.callSafe(args); // never rejects
    if (outcome instanceof ToolError) {
      await this._postResult(runId, callId, { error: outcome.message }, signal);
    } else {
      await this._postResult(runId, callId, { result: outcome.value }, signal);
    }
  }

  /**
   * POST a tool outcome to `/run/{runId}/result`. Failures are swallowed so a
   * dead result channel can't crash the event stream.
   * @param {string} runId
   * @param {*} callId
   * @param {{ result?: any, error?: string }} outcome
   * @param {AbortSignal} [signal]
   */
  async _postResult(runId, callId, outcome, signal) {
    const payload = { call_id: String(callId) };
    if (outcome.error !== undefined) payload.error = outcome.error;
    else payload.result = outcome.result;
    try {
      await this._fetch(`${this.baseUrl}${RUN_PATH}/${runId}/result`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (_) {
      // Result delivery failed (server timed out the call, run ended, …). Keep
      // reading the stream; the server handles the missing result.
    }
  }
}

/**
 * Validate a `zdr` option: strictly boolean or absent, no coercion. A truthy
 * string like `"false"` silently ENABLING retention semantics the caller did
 * not ask for is exactly the surprise this guards against — fail loud instead.
 * @param {*} value
 * @returns {boolean|undefined} the boolean, or undefined when not provided
 */
function assertZdr(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new TypeError(`Driver: zdr must be a boolean, got ${typeof value} (${JSON.stringify(value)})`);
  }
  return value;
}

/** Read a response body as text, swallowing errors (used for error messages). */
async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch (_) {
    return '';
  }
}

/**
 * Async-iterate parsed JSON events from an SSE stream.
 *
 * Handles multi-line `data:` fields and `\n\n` event delimiters. `data` lines
 * that aren't valid JSON are skipped (never surfaced as raw text).
 *
 * @param {ReadableStream<Uint8Array>} body
 */
async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    // SSE events are separated by a blank line.
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseEvent(raw);
      if (ev !== undefined) yield ev;
    }
  }

  // Flush a trailing event with no final blank line.
  const tail = buffer.trim();
  if (tail) {
    const ev = parseEvent(tail);
    if (ev !== undefined) yield ev;
  }
}

/** Parse one SSE event block into a JS object, or undefined if there's no data. */
function parseEvent(raw) {
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join('\n');
  try {
    return JSON.parse(data);
  } catch (_) {
    return undefined; // non-JSON data is dropped, never surfaced as raw text
  }
}

module.exports = { Driver, Tool, Param, ToolResult, ToolError, defineTool, parseSignature, normalizeParams, PARAM_DESC_MAX };
module.exports.default = Driver;
module.exports.parseSSE = parseSSE;
