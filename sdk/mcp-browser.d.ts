import type { HostTool } from "./fx-sdk.js";
import type { McpServerConfig } from "./mcp-install.js";
import type { BrowserMcpStorage } from "./mcp-oauth.js";

export type { HostTool } from "./fx-sdk.js";
export type { BrowserMcpStorage } from "./mcp-oauth.js";

export type BrowserMcpServer = McpServerConfig & { id: string };
export type BrowserMcpServerInput = McpServerConfig & { id?: string };

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
}

export type BrowserMcpStatus =
  | { state: "starting" }
  | { state: "ready"; tools: string[] }
  | { state: "sign-in" }
  | { state: "failed"; message: string };

export interface BrowserMcpOptions {
  /** Required only for npm MCP servers. Must be served from the page's origin. */
  hostUrl?: string;
  /** Required only for remote-server OAuth sign-in. */
  redirectUrl?: string;
  gate?: (
    server: string,
    tool: string,
    signal?: AbortSignal,
  ) => Promise<{ run: true } | { run: false; reason: string }>;
  onServersChange?: (servers: BrowserMcpServer[]) => void;
  storage?: BrowserMcpStorage;
  storagePrefix?: string;
  clientName?: string;
  maxTools?: number;
}

export interface BrowserMcp {
  servers(): BrowserMcpServer[];
  setServers(servers: BrowserMcpServerInput[]): void;
  command(input: string): Promise<string>;
  connect(): Promise<{ tools: HostTool[]; failures: Array<{ server: string; message: string }> }>;
  listTools(server: BrowserMcpServer): Promise<McpToolInfo[]>;
  status(server: BrowserMcpServer): BrowserMcpStatus;
  connectionKey(server: BrowserMcpServer): string;
  reset(server: BrowserMcpServer): void;
}

export class McpSignInRequired extends Error {
  constructor(server: string);
  server: string;
}

export function createBrowserMcp(options?: BrowserMcpOptions): BrowserMcp;
export function describeServer(server: McpServerConfig): string;
