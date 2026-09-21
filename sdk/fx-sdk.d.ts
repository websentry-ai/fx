export interface HostTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: unknown, options: { signal?: AbortSignal }): unknown | Promise<unknown>;
}

export interface TerminalAdapter {
  write(data: string | Uint8Array): void;
  onData(listener: (data: string) => void): () => void;
  onKeyData?(listener: (data: string) => void): () => void;
  onResize(listener: (size: { cols: number; rows: number }) => void): () => void;
  readonly cols: number;
  readonly rows: number;
  drain?(): void | Promise<void>;
}

export interface FxTerminal {
  interactive: Promise<void>;
  exited: Promise<number>;
  write(data: string): void;
  resize(): void;
  setTools(tools: HostTool[] | Promise<HostTool[]>): Promise<void>;
  abort(): void;
}

export type WasmSource =
  | string
  | Response
  | ArrayBuffer
  | ArrayBufferView
  | WebAssembly.Module
  | Promise<Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module>;

/**
 * Unbound fork: a read-only filesystem the wasm reads through WASI.
 *
 * Keys are paths relative to `workspaceRoot`, with no leading slash, and each
 * value is the file's contents. Directories come from the keys, so
 * `{ "skills/bro/SKILL.md": "..." }` makes both `skills/` and `skills/bro/`.
 *
 * This is how a browser host gives the agent skills. fx discovers them by
 * scanning `skills`, `.fx/skills`, `.opencode/skills` and `.codex/skills`, all
 * relative to `/`, so a host supplying skills wants `workspaceRoot: "/"`. A
 * root further down leaves those other roots outside the preopened directory,
 * and fx then calls its whole inventory unreadable rather than empty. Writes
 * are not served.
 */
export type FxFiles = Record<string, string | Uint8Array>;

export interface FxTerminalOptions {
  terminal: TerminalAdapter;
  wasm?: WasmSource;
  tools?: HostTool[];
  /** Files the wasm reads. Omit and it has no filesystem at all. */
  files?: FxFiles;
  /** Where `files` is preopened. Defaults to "/workspace"; skills want "/". */
  workspaceRoot?: string;
  mcpCommand?: (input: string) => string | Promise<string>;
  interruptKey?: string;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string>;
  onEvent?: (event: { type: string; timestamp: number; [key: string]: unknown }) => void;
  [key: string]: unknown;
}

export type FxPromptBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; text?: string } }
  | { type: "resource"; uri: string; text?: string };

export type FxAgentEvent =
  | { type: "text_delta" | "reasoning_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; content?: string; isError: boolean };

export interface FxAgentResult {
  stopReason: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

export interface FxAgentTurn extends AsyncIterable<FxAgentEvent> {
  readonly result: Promise<FxAgentResult>;
  cancel(): void;
}

export interface FxAgent {
  prompt(input: string | FxPromptBlock[], options?: { signal?: AbortSignal }): FxAgentTurn;
  checkpoint(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface FxAgentOptions {
  apiKey: string;
  model?: string;
  gatewayChatUrl?: string;
  wasm?: WasmSource;
  fetch?: typeof globalThis.fetch;
  instructions?: string | string[];
  tools?: HostTool[];
  checkpoint?: ArrayBuffer | ArrayBufferView;
  onEvent?: (event: { type: string; timestamp: number; [key: string]: unknown }) => void;
  onPermission?: (request: unknown) => string | null | undefined | Promise<string | null | undefined>;
  [key: string]: unknown;
}

export interface ListModelsOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

export const fxSdkApiVersion: number;
export function supportsJspi(): boolean;
export function xtermAdapter(terminal: unknown): TerminalAdapter;
export function encodeXtermKeyEvent(event: KeyboardEvent): string | null;
export function createFxTerminal(options: FxTerminalOptions): Promise<FxTerminal>;
export function createFxAgent(options: FxAgentOptions): Promise<FxAgent>;
export function listModels(options: ListModelsOptions): Promise<string[]>;
