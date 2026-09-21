#!/usr/bin/env node
// Unbound fork: one large MCP server's whole catalog must reach the model.
//
// Linear lists 74 tools. A harness session showed `/mcp` printing all 74 while
// the agent answered "there are no mcp__linear__* functions connected", so the
// catalog reached the host and not the model. This drives the same shape
// through the real wasm: set 74 tools after boot, send a prompt, and check
// every name is advertised in the request.
//
// Run: node --experimental-wasm-jspi sdk/tests/test-term-large-mcp-catalog.mjs
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFxTerminal, supportsJspi } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const wasmPath = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/bin/fx-term.wasm"));

if (!supportsJspi()) {
  console.error("Node JSPI is disabled. Run with: node --experimental-wasm-jspi");
  process.exit(2);
}

const decoder = new TextDecoder();
let screen = "";
const dataListeners = new Set();
const terminal = {
  cols: 100,
  rows: 30,
  write(bytes) {
    screen += decoder.decode(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes), { stream: true });
    return true;
  },
  onData(callback) {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },
  onResize() {
    return () => {};
  },
};

const waitFor = async (what, check, ms = 20_000) => {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}\n${screen.slice(-1500)}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

const stream = (...events) =>
  new Response([...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

const requests = [];
const mockFetch = async (_url, init) => {
  requests.push(new TextDecoder().decode(init.body));
  return stream({ type: "text-delta", delta: "done" }, { type: "finish", finishReason: "stop", usage });
};

// The names Linear actually ships, so the sizes are the real ones.
const LINEAR_TOOLS = [
  "get_attachment", "prepare_attachment_upload", "create_attachment_from_upload", "create_attachment",
  "delete_attachment", "list_agent_skills", "get_agent_skill", "list_comments", "save_comment",
  "delete_comment", "list_cycles", "get_document", "list_documents", "save_document", "extract_images",
  "get_issue", "list_issues", "save_issue", "list_issue_statuses", "get_issue_status", "list_issue_labels",
  "save_issue_label", "create_issue_label", "retire_issue_label", "restore_issue_label", "list_projects",
  "get_project", "save_project", "list_project_labels", "retire_project_label", "restore_project_label",
  "save_project_label", "list_release_pipelines", "list_releases", "get_release", "save_release",
  "list_release_notes", "get_release_note", "save_release_note", "get_diff", "list_diffs", "get_diff_threads",
  "save_diff_comment", "resolve_diff_thread", "delete_diff_comment", "submit_diff_review", "update_diff",
  "merge_diff", "share_issue", "unshare_issue", "list_milestones", "get_milestone", "save_milestone",
  "get_notifications", "mark_notification", "list_teams", "get_team", "list_templates", "get_template",
  "list_users", "get_user", "get_workspace", "search_documentation", "list_initiatives", "get_initiative",
  "save_initiative", "list_initiative_labels", "save_initiative_label", "create_initiative_label",
  "retire_initiative_label", "restore_initiative_label", "get_status_updates", "save_status_update",
  "delete_status_update",
];
assert.equal(LINEAR_TOOLS.length, 74, "the fixture is meant to be Linear's 74 tools");

const runtime = await createFxTerminal({
  backend: "wasm",
  wasm: await readFile(wasmPath),
  terminal,
  env: { AI_GATEWAY_API_KEY: "term-large-catalog-key", HOME: "/home/test" },
  fetch: mockFetch,
  workspace: {
    info: { version: 1, root: "/workspace", cwd: "/workspace", home: "/home/test", gitAvailable: false, ephemeral: true },
    permission: "allow-sandboxed",
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  },
  async mcpCommand(input) {
    return `host answered: ${input}`;
  },
  stderr() {},
});

await runtime.interactive;
await waitFor("startup", () => screen.includes("Run /help for commands"));

// The page's own shape: a skill tool, then the server's catalog behind it.
const tools = [
  {
    name: "skill",
    description: "Load a skill's instructions.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute() {
      return "skill body";
    },
  },
  ...LINEAR_TOOLS.map((name) => ({
    name: `mcp__linear__${name}`,
    description: `Linear's ${name.replaceAll("_", " ")} operation, as the server describes it.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The identifier the operation acts on." },
        query: { type: "string", description: "A search string." },
        limit: { type: "number", description: "How many records to return." },
      },
      additionalProperties: false,
    },
    async execute() {
      return `${name} ran`;
    },
  })),
];

await runtime.setTools(tools);
runtime.write("fetch WEB-5784 from linear\r");
await waitFor("the model request", () => requests.length >= 1);

const advertised = requests[0];
const missing = LINEAR_TOOLS.filter((name) => !advertised.includes(`mcp__linear__${name}`));
assert.equal(
  missing.length,
  0,
  `${missing.length} of 74 MCP tools never reached the model, starting with ${missing[0]}`,
);
assert.ok(advertised.includes('"skill"'), "the skill tool was dropped when the MCP catalog arrived");

runtime.dispose?.();
console.error("a 74-tool MCP catalog reached the model");
process.exit(0);
