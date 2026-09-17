import type { HostTool } from "./fx-sdk.js";

export interface SkillResource {
  uri: string;
  text: string;
}

export interface SkillRecord {
  name: string;
  description?: string;
  instructions: string;
  resources?: SkillResource[];
  tools?: HostTool[];
}

export interface BrowserSkillRecord {
  content: string;
  toolName?: string;
}

export type ParsedSkillFile =
  | { ok: true; name: string; description: string; instructions: string }
  | { ok: false; message: string };

export const MAX_SKILL_FILE_CHARS: number;
export function parseSkillFile(content: unknown): ParsedSkillFile;
export function createSkillsAdapter(records: SkillRecord[]): { instructions: string; tools: HostTool[] };
export function createBrowserSkillTools(
  records: BrowserSkillRecord[],
  options?: { onLoad?: (name: string) => void | Promise<void> },
): HostTool[];
