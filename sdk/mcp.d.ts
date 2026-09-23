import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { HostTool } from "./fx-sdk.js";

export type McpClient = Pick<Client, "listTools" | "callTool"> &
  Partial<Pick<Client, "readResource" | "getPrompt" | "close">>;

export function createMcpAdapter(
  client: McpClient,
  options?: {
    prefix?: string;
    /** Unbound fork: the server name carried on each tool's `source`. */
    server?: string;
    resources?: string[];
    prompts?: Array<string | Record<string, unknown>>;
  },
): Promise<{ tools: HostTool[]; instructions: string; close(): Promise<void> }>;
