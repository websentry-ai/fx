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

export const fxSdkApiVersion: number;
export function supportsJspi(): boolean;
export function xtermAdapter(terminal: unknown): TerminalAdapter;
export function encodeXtermKeyEvent(event: KeyboardEvent): string | null;
export function createFxTerminal(options: Record<string, unknown>): Promise<FxTerminal>;
export function createFxAgent(options?: Record<string, unknown>): Promise<unknown>;
export function listModels(options?: Record<string, unknown>): Promise<string[]>;
