export interface NpmMcpServerConfig {
  name: string;
  kind: "npm";
  pkg: string;
  version: string;
  args: string[];
  env: Record<string, string>;
}

export interface RemoteMcpServerConfig {
  name: string;
  kind: "remote";
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = NpmMcpServerConfig | RemoteMcpServerConfig;

export function shellWords(line: string): string[];
export function parseMcpAdd(words: string[]): McpServerConfig;
