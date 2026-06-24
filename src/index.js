'use strict';

const { EventEmitter } = require('events');

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
   */
  constructor(opts = {}) {
    super();
    const apiKey = opts.apiKey || process.env.DRIVER_API_KEY;
    if (!apiKey) {
      throw new Error('Driver: missing apiKey (pass { apiKey } or set DRIVER_API_KEY)');
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl || process.env.DRIVER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._fetch = opts.fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new Error('Driver: no fetch available — use Node 18+ or pass { fetch }');
    }
  }

  /**
   * Run a prompt as an autonomous agent in the cloud, streaming events.
   *
   * @param {string} prompt        the task description
   * @param {object} [opts]
   * @param {(ev: object) => void} [opts.onEvent] per-event callback
   * @param {AbortSignal} [opts.signal] abort the stream early
   * @returns {Promise<object>} resolves with the final `done` event
   */
  async run(prompt, opts = {}) {
    const res = await this._fetch(this.baseUrl + RUN_PATH, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({ prompt }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Driver run failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
    }
    if (!res.body) {
      throw new Error('Driver run failed: empty response body (no SSE stream)');
    }

    let done = null;
    for await (const ev of parseSSE(res.body)) {
      // Allowlist: only surface the five public kinds. Anything else is
      // dropped so internal events can never leak to the client.
      if (!ev || !ALLOWED_KINDS.has(ev.kind)) continue;
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

module.exports = { Driver };
module.exports.default = Driver;
module.exports.parseSSE = parseSSE;
