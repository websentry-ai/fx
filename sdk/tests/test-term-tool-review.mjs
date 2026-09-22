#!/usr/bin/env node
// Unbound fork: the browser terminal's pre-tool hook, reviewToolCall.
//
// A policy page answers allow, ask or deny for every tool call, workspace
// shell calls and host tools alike. An ask must use fx's own approval prompt,
// never the page's. This drives the real term wasm through each answer and
// checks what ran, what the model was told, and what the transcript shows.
//
// Run: node --experimental-wasm-jspi sdk/tests/test-term-tool-review.mjs
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFxTerminal, supportsJspi } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const wasmPath = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/bin/fx-term.wasm"));

if (!supportsJspi()) {
  console.error("Node JSPI is disabled. Run with: node --experimental-wasm-jspi sdk/tests/test-term-tool-review.mjs");
  process.exit(2);
}

const decoder = new TextDecoder();
let raw = "";
const terminal = {
  cols: 120,
  rows: 40,
  write(bytes) {
    raw += decoder.decode(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes), { stream: true });
    return true;
  },
  onData() { return () => {}; },
  onResize() { return () => {}; },
};
// Styles split words on the wire; assertions read the text without them.
// eslint-disable-next-line no-control-regex
const screen = () => raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "");

const waitFor = async (what, check, ms = 10_000) => {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}\n${screen().slice(-3000)}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

const stream = (...events) =>
  new Response([...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const callTool = (id, toolName, input) => stream(
  { type: "tool-call", toolCallId: id, toolName, input },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
);
const say = (text) => stream(
  { type: "text-delta", delta: text },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
);

// The WARN explanation Unbound's policy sandbox sends as an ask's reason: an
// LLM-written box, led by a blank line.
const boxLines = [
  "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓",
  "┃                                                                    ┃",
  "┃ ▍ WHAT'S HAPPENING                                                 ┃",
  "┃   Creates two memory entities on the `memory` MCP server: a person ┃",
  "┃   named `Alice` with the observation `Owns the checkout service`.  ┃",
  "┃                                                                    ┃",
  "┃ ▍ REVERSIBLE ● yes                                                 ┃",
  "┃   The created entities can be removed later with the               ┃",
  "┃   `delete_entities` tool on the `memory` server.                   ┃",
  "┃                                                                    ┃",
  "┃ ▍ MATCHES YOUR ASK ● aligned                                       ┃",
  "┃   You asked to remember that Alice owns the checkout service.      ┃",
  "┃                                                                    ┃",
  "┃ ▍ ORG POLICY · Approve MCP writes                                  ┃",
  "┃   New memories are shared with every agent in the workspace.       ┃",
  "┃                                                                    ┃",
  "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛",
];
const boxReason = `\n${boxLines.join("\n")}\n`;

// Each case is one prompt: the model makes one call, the hook answers, and the
// model's next request carries the tool result the test inspects.
const lookup = "mcp__policy__lookup";
const cases = {
  "shell-allow": { tool: "shell", input: { action: "run", command: "printf shell-allow" }, review: { decision: "allow", context: "not forwarded" } },
  "shell-ask-yes": { tool: "shell", input: { action: "run", command: "printf shell-ask-yes" }, review: { decision: "ask", reason: "Policy P-2 wants a human for shell-ask-yes" }, answer: "\r" },
  "shell-ask-no": { tool: "shell", input: { action: "run", command: "printf shell-ask-no" }, review: { decision: "ask", reason: "Policy P-3 wants a human for shell-ask-no", context: "Ask #infra first" }, answer: "2\r" },
  "shell-deny": { tool: "shell", input: { action: "run", command: "printf shell-deny" }, review: { decision: "deny", reason: "Policy P-4 blocks shell-deny", context: "See go/p4" } },
  "shell-throw": { tool: "shell", input: { action: "run", command: "printf shell-throw" }, review: new Error("policy service down") },
  "shell-malformed": { tool: "shell", input: { action: "run", command: "printf shell-malformed" }, review: { decision: "block" } },
  "shell-interrupt": { tool: "shell", input: { action: "run", command: "printf shell-interrupt" }, review: "hold" },
  "tool-allow": { tool: lookup, input: { q: "tool-allow" }, review: { decision: "allow" } },
  "tool-ask-yes": { tool: lookup, input: { q: "tool-ask-yes" }, review: { decision: "ask", reason: "Policy P-6 wants a human for tool-ask-yes" }, answer: "\r" },
  "tool-ask-no": { tool: lookup, input: { q: "tool-ask-no" }, review: { decision: "ask", reason: "Policy P-7 wants a human for tool-ask-no", context: "Lookups leak PII" }, answer: "2\r" },
  "tool-deny": { tool: lookup, input: { q: "tool-deny" }, review: { decision: "deny", reason: "Policy P-8 blocks tool-deny", context: "See go/p8" } },
  "tool-throw": { tool: lookup, input: { q: "tool-throw" }, review: Promise.reject(new Error("policy timeout")) },
  // Multi-line reasons: the prompt shows every line, the tool line one.
  "box-ask-yes": { tool: lookup, input: { q: "box-ask-yes" }, review: { decision: "ask", reason: boxReason }, answer: "\r" },
  "box-ask-no": { tool: lookup, input: { q: "box-ask-no" }, review: { decision: "ask", reason: boxReason, context: "Ask #memory first" }, answer: "2\r" },
  "box-ask-summary": { tool: lookup, input: { q: "box-ask-summary" }, review: { decision: "ask", reason: boxReason, summary: "Writes two shared memories" }, answer: "2\r" },
  "lines-shell-deny": { tool: "shell", input: { action: "run", command: "printf lines-shell-deny" }, review: { decision: "deny", reason: "Needs guidance loaded first, per your org's policy.\nInvoke the policy skill, then retry." } },
  "summary-shell-deny": { tool: "shell", input: { action: "run", command: "printf summary-shell-deny" }, review: { decision: "deny", reason: boxReason, summary: "Reads a private key", context: "See go/keys" } },
};
cases["tool-throw"].review.catch(() => {});

const executed = [];
const reviewed = [];
const events = [];
const requests = [];
let holdStarted = false;
let holdAborted = false;

const caseFor = (body) => {
  for (let index = body.prompt.length - 1; index >= 0; index -= 1) {
    const message = body.prompt[index];
    if (message.role !== "user") continue;
    const text = JSON.stringify(message.content);
    const id = Object.keys(cases).find((key) => text.includes(`run ${key}`));
    if (id) return id;
  }
  return null;
};
const toolResultFor = (body, id) => body.prompt
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .find((part) => part.type === "tool-result" && part.toolCallId === `call-${id}`);

const mockFetch = async (_url, init = {}) => {
  if ((init.method || "GET") === "GET") {
    return new Response(JSON.stringify({ object: "list", data: [{ id: "test/review-model", type: "language", released: 1, tags: ["tool-use"], context_window: 128000, max_tokens: 8192 }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const body = JSON.parse(new TextDecoder().decode(init.body));
  const id = caseFor(body);
  assert.ok(id, `unexpected model request: ${JSON.stringify(body.prompt).slice(-500)}`);
  const result = toolResultFor(body, id);
  if (!result) return callTool(`call-${id}`, cases[id].tool, cases[id].input);
  requests.push({ id, result: JSON.stringify(result) });
  return say(`finished ${id}`);
};

const runtime = await createFxTerminal({
  backend: "wasm",
  wasm: await readFile(wasmPath),
  terminal,
  env: { AI_GATEWAY_API_KEY: "tool-review-key", HOME: "/home/test" },
  fetch: mockFetch,
  configStore: { get(id) { return id === "model" ? "test/review-model" : null; }, set() {} },
  workspace: {
    info: { version: 1, root: "/workspace", cwd: "/workspace", home: "/home/test", gitAvailable: false, ephemeral: true },
    permission: "allow-sandboxed",
    async exec({ command }) {
      executed.push(command);
      return { stdout: `ran ${command}\n`, stderr: "", exitCode: 0 };
    },
  },
  tools: [{
    name: lookup,
    description: "Look something up.",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    async execute(input) {
      executed.push(`${lookup} ${input.q}`);
      return `looked up ${input.q}`;
    },
  }],
  reviewToolCall(call, { signal }) {
    reviewed.push(call);
    const key = call.command ? call.command.replace("printf ", "") : call.input?.q;
    const review = cases[key]?.review;
    if (review instanceof Error) throw review;
    if (review === "hold") {
      holdStarted = true;
      return new Promise((resolveReview) => {
        signal.addEventListener("abort", () => {
          holdAborted = true;
          // Answering allow after the interrupt must not run the call.
          resolveReview({ decision: "allow" });
        }, { once: true });
      });
    }
    return review;
  },
  onEvent(event) { if (event.type === "tool_review_error") events.push(event); },
  stderr(bytes) { process.stderr.write(bytes); },
});
await runtime.interactive;
await waitFor("startup", () => screen().includes("Run /help for commands"));

const resultOf = (id) => requests.find((request) => request.id === id)?.result;

async function run(id) {
  const before = screen().length;
  runtime.write(`run ${id}\r`);
  const { answer, review } = cases[id];
  if (review?.decision === "ask") {
    const shown = review.reason === boxReason ? boxLines.at(-1) : review.reason;
    await waitFor(`the approval prompt for ${id}`, () => screen().slice(before).includes(shown));
    const prompt = screen().slice(before);
    if (review.reason === boxReason) {
      for (const line of boxLines) assert.ok(prompt.includes(line), `${id}: the prompt is missing the reason line "${line}"`);
      assert.ok(!prompt.includes("\\x0a"), `${id}: the prompt escaped the reason's line breaks`);
    }
    assert.match(prompt, /1\. Confirm/, `${id}: the ask did not use fx's confirm prompt`);
    assert.match(prompt, /2\. Cancel/, `${id}: the ask did not use fx's confirm prompt`);
    assert.doesNotMatch(prompt, /don't ask again|Allow this MCP tool for this session/, `${id}: the ask offered a standing grant`);
    runtime.write(answer);
  }
  await waitFor(`the model's answer to ${id}`, () => screen().includes(`finished ${id}`), 15_000);
}

// Shell calls.
await run("shell-allow");
assert.ok(executed.includes("printf shell-allow"), "an allowed shell call did not run");
assert.match(resultOf("shell-allow"), /ran printf shell-allow/);
assert.doesNotMatch(resultOf("shell-allow"), /not forwarded/, "allow context is documented as not forwarded");
assert.deepEqual(
  { name: reviewed[0].name, command: reviewed[0].command, input: reviewed[0].input },
  { name: "shell", command: "printf shell-allow", input: { action: "run", command: "printf shell-allow" } },
);

await run("shell-ask-yes");
assert.ok(executed.includes("printf shell-ask-yes"), "an approved ask did not run");
assert.equal(reviewed.filter((call) => call.command === "printf shell-ask-yes").length, 1, "an approved ask was reviewed twice");

await run("shell-ask-no");
assert.ok(!executed.includes("printf shell-ask-no"), "a declined ask ran");
assert.match(resultOf("shell-ask-no"), /Policy P-3 wants a human for shell-ask-no/);
assert.match(resultOf("shell-ask-no"), /Ask #infra first/);

await run("shell-deny");
assert.ok(!executed.includes("printf shell-deny"), "a denied shell call ran");
assert.match(resultOf("shell-deny"), /Policy P-4 blocks shell-deny/);
assert.match(resultOf("shell-deny"), /See go\/p4/);

await run("shell-throw");
assert.ok(executed.includes("printf shell-throw"), "a throwing hook did not fail open");
await run("shell-malformed");
assert.ok(executed.includes("printf shell-malformed"), "a malformed review did not fail open");
assert.deepEqual(events.map((event) => event.name), ["shell", "shell"], "fail-open reviews were not reported");
assert.match(String(events[0].error), /policy service down/);

// An interrupt while the host is still deciding: the call never runs.
runtime.write("run shell-interrupt\r");
await waitFor("the held review", () => holdStarted);
runtime.write("\x03");
await waitFor("the review AbortSignal", () => holdAborted);
await waitFor("the interrupted turn to settle", () => screen().includes("finished shell-interrupt") || /[Ii]nterrupted|[Cc]ancelled/.test(screen().slice(-2000)), 15_000);
assert.ok(!executed.includes("printf shell-interrupt"), "a call interrupted during review ran");

// Host tools, which is how MCP tools reach the terminal.
await run("tool-allow");
assert.ok(executed.includes(`${lookup} tool-allow`), "an allowed host tool did not run");
const toolReview = reviewed.find((call) => call.name === lookup);
assert.deepEqual({ command: toolReview.command, input: toolReview.input }, { command: undefined, input: { q: "tool-allow" } });

await run("tool-ask-yes");
assert.ok(executed.includes(`${lookup} tool-ask-yes`), "an approved host tool ask did not run");

await run("tool-ask-no");
assert.ok(!executed.includes(`${lookup} tool-ask-no`), "a declined host tool ask ran");
assert.match(resultOf("tool-ask-no"), /Policy P-7 wants a human for tool-ask-no/);
assert.match(resultOf("tool-ask-no"), /Lookups leak PII/);

await run("tool-deny");
assert.ok(!executed.includes(`${lookup} tool-deny`), "a denied host tool ran");
assert.match(resultOf("tool-deny"), /Policy P-8 blocks tool-deny/);
assert.match(resultOf("tool-deny"), /See go\/p8/);

await run("tool-throw");
assert.ok(executed.includes(`${lookup} tool-throw`), "a rejecting hook did not fail open for a host tool");
assert.equal(events.at(-1).name, lookup);

// A multi-line reason: shown whole, answered, then one line in the transcript.
await run("box-ask-yes");
assert.ok(executed.includes(`${lookup} box-ask-yes`), "an approved multi-line ask did not run");
await run("box-ask-no");
assert.ok(!executed.includes(`${lookup} box-ask-no`), "a declined multi-line ask ran");
assert.ok(resultOf("box-ask-no").includes(JSON.stringify(boxLines.join("\n")).slice(1, -1)), "the model did not get the whole reason");
assert.match(resultOf("box-ask-no"), /Ask #memory first/);
await run("box-ask-summary");
assert.ok(!executed.includes(`${lookup} box-ask-summary`), "a declined ask with a summary ran");
assert.doesNotMatch(resultOf("box-ask-summary"), /Writes two shared memories/, "the summary reached the model");
await run("lines-shell-deny");
assert.match(resultOf("lines-shell-deny"), /Invoke the policy skill, then retry\./);
await run("summary-shell-deny");
assert.ok(!executed.includes("printf summary-shell-deny"), "a denied shell call with a summary ran");
assert.match(resultOf("summary-shell-deny"), /See go\/keys/);
assert.match(resultOf("summary-shell-deny"), /ORG POLICY · Approve MCP writes/);

// The transcript still shows a tool line for the calls that never ran.
const transcript = screen();
for (const line of [
  "Failed printf shell-deny: Denied by host policy: Policy P-4 blocks shell-deny",
  "Failed printf shell-ask-no: Not approved (host policy asked for approval): Policy P-3",
  "Failed mcp__policy__lookup: Denied by host policy: Policy P-8 blocks tool-deny",
  "Failed mcp__policy__lookup: Not approved (host policy asked for approval): Policy P-7",
  "Failed mcp__policy__lookup: Not approved (host policy asked for approval): WHAT'S HAPPENING",
  "Failed mcp__policy__lookup: Not approved (host policy asked for approval): Writes two shared memories",
  "Failed printf lines-shell-deny: Denied by host policy: Needs guidance loaded first, per your org's policy.",
  "Failed printf summary-shell-deny: Denied by host policy: Reads a private key",
]) {
  assert.ok(transcript.includes(line), `the transcript has no tool line reading "${line}"`);
}
assert.ok(!transcript.includes("\\x0a"), "a line break reached the terminal escaped as \\x0a");

runtime.abort();
assert.equal(await runtime.exited, 130);
console.error("terminal tool review passed: allow, ask (confirm/cancel), deny, fail-open and interrupt for shell and host tools");
