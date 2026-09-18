#!/usr/bin/env node
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

const waitFor = async (what, check, ms = 10_000) => {
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
let slowToolStarted = false;
let slowToolAborted = false;
let releaseSlowTool;
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
  if (requests.length === 3) {
    return stream(
      { type: "tool-call", toolCallId: "call_2", toolName: "mcp__memory__wait", input: {} },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
    );
  }
  return stream(
    { type: "text-delta", delta: "done" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  );
};

const runtime = await createFxTerminal({
  backend: "wasm",
  wasm: await readFile(wasmPath),
  terminal,
  env: { AI_GATEWAY_API_KEY: "term-host-mcp-key", HOME: "/home/test" },
  fetch: mockFetch,
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

let releaseTools;
runtime.setTools(new Promise((done) => { releaseTools = done; }).then(() => [{
  name: "mcp__memory__read_graph",
  description: "Read the knowledge graph.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, { signal }) {
    assert.equal(signal.aborted, false);
    toolCalls += 1;
    return "graph: alice owns checkout";
  },
}]));
setTimeout(() => {
  toolsReleasedAt = performance.now();
  releaseTools();
}, 300);
runtime.write("what is in memory?\r");
await waitFor("the second model step", () => requests.length >= 2 && screen.includes("done"), 15_000);

assert.ok(firstRequestAt > toolsReleasedAt, "the prompt went out before the host's tools were ready");
assert.ok(requests[0].includes("mcp__memory__read_graph"), "the tools set after boot were not advertised");
assert.equal(toolCalls, 1, `the host tool did not run:\n${screen.slice(-1500)}`);
assert.ok(requests[1].includes("graph: alice owns checkout"), "the host tool's result did not reach the model");
assert.ok(screen.includes("Called mcp__memory__read_graph"), "the transcript did not name the host tool");

const invalidTool = (name, description, inputSchema = { type: "object" }) => ({
  name,
  description,
  inputSchema,
  execute() {},
});
await assert.rejects(
  runtime.setTools([invalidTool("too_long", "x".repeat(64 * 1024 + 1))]),
  /description exceeds/,
);
await assert.rejects(
  runtime.setTools([invalidTool("schema_too_large", "test", { value: "x".repeat(64 * 1024) })]),
  /inputSchema exceeds/,
);
await assert.rejects(
  runtime.setTools(
    Array.from({ length: 23 }, (_, index) => invalidTool(`escaped_${index}`, "\0".repeat(64 * 1024))),
  ),
  /tool descriptors exceed/,
);

await runtime.setTools([{
  name: "mcp__memory__wait",
  description: "Wait until cancelled.",
  inputSchema: { type: "object", properties: {} },
  execute(_input, { signal }) {
    slowToolStarted = true;
    return new Promise((resolveTool) => {
      releaseSlowTool = resolveTool;
      signal.addEventListener("abort", () => { slowToolAborted = true; }, { once: true });
    });
  },
}]);
runtime.write("wait for memory\r");
await waitFor("the cancellable host tool", () => slowToolStarted);
runtime.write("\x03");
await waitFor("the host tool AbortSignal", () => slowToolAborted);
releaseSlowTool("late result");
runtime.abort();
assert.equal(await runtime.exited, 130);
console.error("terminal host MCP bridge passed");
