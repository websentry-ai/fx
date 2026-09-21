#!/usr/bin/env node
// Unbound fork: fx's own skills, in a host with no real filesystem.
//
// The browser terminal hands skills to the wasm as files. With the in-memory
// filesystem in place, /skills lists them by name. Without it the wasm answers
// "Skills are unavailable in this host because filesystem access is not
// provided", which is what shipped to production on 2026-09-18.
//
// Run: node --experimental-wasm-jspi sdk/tests/test-term-skills-memfs.mjs
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
  async drain() {},
  onData(callback) {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },
  onResize() {
    return () => {};
  },
};

const skill = ["---", "name: bro", "description: Restate the last message in plain words.", "---", "", "Say it plainly.", ""].join("\n");

const runtime = await createFxTerminal({
  backend: "wasm",
  wasm: await readFile(wasmPath),
  terminal,
  env: { AI_GATEWAY_API_KEY: "term-test-key", HOME: "/home/visitor" },
  fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  // What the harness page passes: the skill as a file the agent can discover.
  workspaceRoot: "/",
  files: { "home/visitor/.keep": "", "skills/bro/SKILL.md": skill },
  stderr() {},
});

await Promise.race([
  runtime.interactive,
  new Promise((_, reject) => setTimeout(() => reject(new Error("fx-term never became interactive")), 15000)),
]);

// The session notice carries what the agent actually got: how many skills are
// in its catalog, and any root it could not read.
runtime.write("\x0f");
const deadline = Date.now() + 10000;
const plain = () => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
while (Date.now() < deadline && !/skills: \d+ in catalog/.test(plain())) {
  await new Promise((done) => setTimeout(done, 200));
}
const view = plain();
runtime.dispose?.();

const fail = (why) => {
  console.error(`FAIL: ${why}`);
  console.error(view.slice(-500));
  process.exit(1);
};

if (/filesystem access is not provided/.test(view)) fail("the wasm reports no filesystem, so skills are off in this host");
if (/discovery issues/.test(view)) fail("skill discovery could not read the roots the host supplied");
const catalog = /skills: (\d+) in catalog/.exec(view);
if (!catalog) fail("the session notice never reported a skill catalog");
if (Number(catalog[1]) !== 1) fail(`the agent sees ${catalog[1]} skills, not the 1 the host supplied`);

console.error("term skills over the in-memory filesystem passed");
process.exit(0);
