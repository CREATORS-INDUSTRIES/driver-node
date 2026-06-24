import { EventEmitter } from 'events';

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
}

export interface RunOptions {
  /** Per-event callback, invoked for every AgentEvent. */
  onEvent?: (ev: AgentEvent) => void;
  /** Abort the SSE stream early. */
  signal?: AbortSignal;
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

  constructor(opts?: DriverOptions);
  run(prompt: string, opts?: RunOptions): Promise<AgentEvent | null>;

  on(event: 'event', listener: (ev: AgentEvent) => void): this;
  on(event: 'plan', listener: (ev: AgentEvent) => void): this;
  on(event: 'plan_item_start', listener: (ev: AgentEvent) => void): this;
  on(event: 'action', listener: (ev: AgentEvent) => void): this;
  on(event: 'done', listener: (ev: AgentEvent) => void): this;
  on(event: 'fatal', listener: (ev: AgentEvent) => void): this;
  on(event: string, listener: (ev: AgentEvent) => void): this;
}

export default Driver;
