#!/usr/bin/env node
// Unbound fork: the browser terminal hands `/mcp` to its host, and host tools
// set after boot (setTools) reach the model at the next prompt, which waits for
// a replacement the host is still preparing.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFxTerminal, supportsJspi } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const wasmPath = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/bin/fx-term.wasm"));

if (!supportsJspi()) {
  console.error("Node JSPI is disabled. Run with: node --experimental-wasm-jspi sdk/tests/test-term-host-mcp.mjs");
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

const waitFor = async (what, check, ms = 10000) => {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}\n${screen.slice(-2000)}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

const stream = (...events) =>
  new Response([...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };

const commands = [];
const requests = [];
let toolCalls = 0;
let toolsReleasedAt;
let firstRequestAt;
const mockFetch = async (_url, init) => {
  const body = new TextDecoder().decode(init.body);
  requests.push(body);
  if (requests.length === 1) {
    firstRequestAt = performance.now();
    return stream(
      { type: "tool-call", toolCallId: "call_1", toolName: "mcp__memory__read_graph", input: {} },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
    );
  }
  return stream({ type: "text-delta", delta: "done" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
};

const runtime = await createFxTerminal({
  backend: "wasm",
  wasm: await readFile(wasmPath),
  terminal,
  env: { AI_GATEWAY_API_KEY: "term-host-mcp-key", HOME: "/home/test" },
  fetch: mockFetch,
  // The browser terminal runs tools through its workspace executor, as the harness page does.
  workspace: {
    info: { version: 1, root: "/workspace", cwd: "/workspace", home: "/home/test", gitAvailable: false, ephemeral: true },
    permission: "allow-sandboxed",
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  },
  async mcpCommand(input) {
    commands.push(input);
    return `host answered: ${input}`;
  },
  stderr(bytes) { process.stderr.write(bytes); },
});
await runtime.interactive;
await waitFor("startup", () => screen.includes("Run /help for commands"));

runtime.write("/mcp add memory npx -y @modelcontextprotocol/server-memory\r");
await waitFor("the host's /mcp answer", () => screen.includes("host answered: add memory npx -y"));
assert.deepEqual(commands, ["add memory npx -y @modelcontextprotocol/server-memory"]);

// The host is still starting the server when the prompt goes in.
let release;
runtime.setTools(new Promise((done) => { release = done; }).then(() => [{
  name: "mcp__memory__read_graph",
  description: "Read the knowledge graph.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    toolCalls += 1;
    return "graph: alice owns checkout";
  },
}]));
setTimeout(() => {
  toolsReleasedAt = performance.now();
  release();
}, 300);
runtime.write("what is in memory?\r");
await waitFor("the second model step", () => requests.length >= 2 && screen.includes("done"), 15000);

assert.ok(firstRequestAt > toolsReleasedAt, "the prompt went out before the host's tools were ready");
assert.ok(requests[0].includes("mcp__memory__read_graph"), "the tools set after boot were not advertised");
assert.equal(toolCalls, 1, `the host tool did not run:\n${screen.slice(-1500)}`);
assert.ok(requests[1].includes("graph: alice owns checkout"), "the host tool's result did not reach the model");
assert.ok(screen.includes("Called mcp__memory__read_graph"), "the transcript did not name the host tool");

runtime.write("/exit\r");
assert.equal(await runtime.exited, 0);
console.error("term host MCP passed");
