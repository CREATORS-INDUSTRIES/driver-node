import { EventEmitter } from 'events';

/** Max length of a param description (chars). */
export const PARAM_DESC_MAX: number;

/** Inferred param type from runtime signature analysis. */
export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';

/** A single declared parameter. */
export class Param {
  name: string;
  type: ParamType | string;
  description: string;
  required: boolean;
  constructor(opts: string | {
    name: string;
    type?: string;
    description?: string;
    required?: boolean;
  });
  toJSON(): { name: string; type: string; description: string; required: boolean };
  /** Wire form: a `[name, type]` tuple — what the server's RunRequest expects. */
  toWire(): [string, string];
}

/**
 * One param declaration. `name` is required and the array order is the
 * positional arg order passed to `call`. `type` is optional — omit it and it's
 * inferred from the `call` signature at runtime. `description` is capped at
 * PARAM_DESC_MAX chars.
 */
export interface ParamSpec {
  name: string;
  type?: ParamType | string;
  description?: string;
  required?: boolean;
}

/** Ordered param declarations. */
export type ParamList = Array<ParamSpec | Param>;

/** Parse a function's signature into ordered params with inferred types. */
export function parseSignature(fn: Function): Array<{
  name: string;
  type: ParamType | string;
  rest: boolean;
  destructured: boolean;
}>;

/** Build catalog Param[] — order from `spec`, missing types inferred from `fn`. */
export function normalizeParams(spec?: ParamList | string, fn?: Function): Param[];

/** Successful tool output. Internal wrapper — `call` returns plain values. */
export class ToolResult {
  value: any;
  meta: Record<string, any>;
  constructor(value: any, meta?: Record<string, any>);
  static of(value: any, meta?: Record<string, any>): ToolResult;
  toJSON(): { ok: true; value: any; meta: Record<string, any> };
}

/** Tool failure. Internal wrapper for a throw out of `call`. */
export class ToolError extends Error {
  category: string;
  cause?: any;
  constructor(message: string, opts?: { category?: string; cause?: any });
  toJSON(): { ok: false; category: string; message: string };
}

/**
 * Node.js port of the Driver `Tool` trait. Subclass and override, or build one
 * with `defineTool`.
 */
export class Tool {
  /** Fully-qualified id, conventionally `module.member` (e.g. `fs.read_file`). */
  name(): string;
  /** One-line description shown in the catalog — the only thing the LLM sees. */
  description(): string;
  /** Ordered params `[{ name, type?, description? }]`. Types inferred from `call`. */
  params(): ParamList;
  /** Execute. Positional args spread in; return any plain value. May be async. */
  call(...args: any[]): any;
  /** Catalog entry sent to the cloud. `params` are `[name, type]` tuples. */
  toJSON(): { name: string; description: string; params: Array<[string, string]> };
  /** Run `call`, normalizing the return/throw. Never rejects. */
  callSafe(args?: any[]): Promise<ToolResult | ToolError>;
}

/** Build a Tool from a plain spec — no class, no wrapping. */
export function defineTool(spec: {
  name: string;
  description?: string;
  params?: ParamList;
  call: (...args: any[]) => any;
}): Tool;

export interface DataPayload {
  var: string;
  label: string;
  value: string;
}

/** Opaque tool category exposed on `action` events (no internal tool id). */
export type ToolCategory =
  | 'filesystem'
  | 'http fetching'
  | 'web'
  | 'integration'
  | 'network'
  | 'compute';

/** Error category exposed on `fatal` events (raw message is hidden). */
export type FatalCategory = 'provider' | 'decode' | 'tool' | 'engine';

/**
 * Flat, JSON-friendly event streamed from Driver cloud. `kind` is always set;
 * the remaining fields are present only for the variants that carry them.
 *
 * Only five kinds are emitted: `plan`, `plan_item_start`, `action`, `done`,
 * `fatal`. Internal details (raw tool ids, action args, raw error messages) are
 * never exposed.
 */
export interface AgentEvent {
  kind: 'plan' | 'plan_item_start' | 'action' | 'done' | 'fatal' | string;
  /** plan: the list of subtasks (text). */
  items?: string[];
  /** plan_item_start: index of the item that started. */
  num?: number;
  /** plan_item_start: the item text. */
  def?: string;
  /** action: opaque tool category (not the internal tool id). */
  tool?: ToolCategory | string;
  /** action: whether the tool touches the network. */
  is_network?: boolean;
  /** done: the final answer. */
  result?: string;
  /** done: structured output payloads. */
  data?: DataPayload[];
  /** done: error count over the run. */
  errors?: number;
  /** done: step count over the run. */
  steps?: number;
  /** fatal: error category only; closes the stream. */
  semantic?: FatalCategory | string;
}

export interface DriverOptions {
  /** The `dr_…` API key (machine credential). Falls back to DRIVER_API_KEY. */
  apiKey?: string;
  /** Cloud base URL. Defaults to https://driver.tors.app or DRIVER_BASE_URL. */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to global fetch (Node 18+). */
  fetch?: typeof fetch;
  /** Default tools sent with every `run`. A per-run `tools` overrides this. */
  tools?: Array<Tool | object>;
  /**
   * Request zero data retention for every run by default; a per-run `zdr`
   * overrides it. Requires the account entitlement (403 otherwise).
   */
  zdr?: boolean;
  /**
   * LLM backend for the runs: "openai" | "mistral" | "claude" | "openrouter".
   * Left out, the cloud uses its default engine.
   */
  engine?: string;
  /** Model id for the selected engine. */
  model?: string;
  /**
   * Bring-your-own key for the selected engine (NOT the `dr_…` credential —
   * that's `apiKey`).
   */
  engineKey?: string;
}

export interface RunOptions {
  /** Per-event callback, invoked for every AgentEvent. */
  onEvent?: (ev: AgentEvent) => void;
  /** Abort the SSE stream early. */
  signal?: AbortSignal;
  /** Tools for this run; overrides constructor `tools`. */
  tools?: Array<Tool | object>;
  /**
   * Zero data retention for THIS run; overrides the constructor default. The
   * cloud stores nothing the execution sees: no prompt, no event log, no
   * outputs. Events stream to this client and die here. Requires the account
   * entitlement; without it the run fails with 403.
   */
  zdr?: boolean;
}

/**
 * Node.js client for Driver cloud.
 *
 * Events surface as an EventEmitter (`on('event', …)` firehose, `on('action', …)`,
 * `on('done', …)`, … per kind) and as a Promise (`run` resolves with `done`).
 */
export class Driver extends EventEmitter {
  apiKey: string;
  baseUrl: string;
  tools: Array<Tool | object>;
  zdr: boolean;
  engine?: string;
  model?: string;
  engineKey?: string;

  constructor(opts?: DriverOptions);
  run(prompt: string, opts?: RunOptions): Promise<AgentEvent | null>;
  /** Sugar for `run(prompt, { zdr: true })`: zero-data-retention run. */
  runZdr(prompt: string, opts?: Omit<RunOptions, 'zdr'>): Promise<AgentEvent | null>;

  on(event: 'event', listener: (ev: AgentEvent) => void): this;
  on(event: 'plan', listener: (ev: AgentEvent) => void): this;
  on(event: 'plan_item_start', listener: (ev: AgentEvent) => void): this;
  on(event: 'action', listener: (ev: AgentEvent) => void): this;
  on(event: 'done', listener: (ev: AgentEvent) => void): this;
  on(event: 'fatal', listener: (ev: AgentEvent) => void): this;
  on(event: string, listener: (ev: AgentEvent) => void): this;
}

export default Driver;
