#!/usr/bin/env node
// Unbound fork: the changes a sync with upstream must not quietly drop.
//
// Every assertion here stands for a bug we shipped once. A merge that takes
// upstream's side of these files makes this test fail, which is the whole
// point: the failure names the feature and the file to look in.
//
// Run: node --experimental-wasm-jspi sdk/tests/test-unbound-fork.mjs
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

// 1. Host tools: 128, not upstream's 64.
// Linear alone lists 74 tools. At 64 its whole catalog is refused and the
// terminal prints a failure for the server.
const hostToolRuntime = read("src/core/tooling/host_tool_runtime.zig");
const declared = /pub const max_tools: usize = (\d+);/.exec(hostToolRuntime);
assert.ok(declared, "host_tool_runtime.zig no longer declares max_tools");
assert.ok(
  Number(declared[1]) >= 128,
  `host tools are capped at ${declared[1]}; one large MCP server needs 128`,
);

const { maxTools } = await import("../mcp.js").then((m) => ({ maxTools: m.maxTools ?? null }));
const mcpSource = read("sdk/mcp.js");
const jsCap = /const maxTools = (\d+);/.exec(mcpSource);
assert.ok(jsCap && Number(jsCap[1]) >= 128, "sdk/mcp.js caps tools below 128");
void maxTools;

// setTools has its own ceiling, and it is the one the page actually hits. At
// 64 a 74-tool server is refused whole: /mcp still prints its catalog while the
// model reports no MCP tools at all, which is what production showed.
const sdkSource = read("sdk/fx-sdk.js");
const sdkCap = /const maxHostTools = (\d+);/.exec(sdkSource);
assert.ok(
  sdkCap && Number(sdkCap[1]) >= 128,
  `sdk/fx-sdk.js caps setTools at ${sdkCap?.[1]}; one large MCP server plus the skill tool needs 128`,
);

const browserSource = read("sdk/mcp-browser.js");
const browserCap = /const DEFAULT_MAX_TOOLS = (\d+);/.exec(browserSource);
assert.ok(
  browserCap && Number(browserCap[1]) >= 127,
  "sdk/mcp-browser.js caps tools below 127",
);

// 2. Skills in a browser: the wasm host profile keeps the capability, and the
// SDK backs the WASI read calls with an in-memory filesystem. Without both,
// fx reports "Skills are unavailable in this host because filesystem access is
// not provided", and /skills, listing and loading by name all stop working.
const profile = read("src/core/hosts/runtime_profile.zig");
const wasmProfile = profile.slice(profile.indexOf("wasm"));
assert.ok(
  /\.skills = true/.test(wasmProfile),
  "the wasm runtime profile no longer enables skills",
);

const sdk = read("sdk/fx-sdk.js");
for (const call of ["path_open", "fd_readdir", "path_filestat_get", "fd_prestat_get", "fd_read", "fd_seek"]) {
  assert.ok(
    sdk.includes(`wasiFs.${call}(`),
    `sdk/fx-sdk.js leaves ${call} unbacked; skills cannot scan the workspace`,
  );
}
const memfs = await import("../memfs.js");
assert.equal(typeof memfs.createMemFs, "function", "sdk/memfs.js lost createMemFs");
assert.equal(typeof memfs.createWasiFs, "function", "sdk/memfs.js lost createWasiFs");

// The filesystem actually serves the layout skill discovery walks.
const fs = memfs.createMemFs({
  root: "/workspace",
  files: { "skills/bro/SKILL.md": "---\nname: bro\ndescription: d\n---\n\nBody.\n" },
});
assert.ok(fs, "createMemFs returned nothing for a skills layout");

// The published package must carry memfs.js too. fx-sdk.js imports it, so a
// package list without it produces a library that cannot even load.
const packager = read("sdk/scripts/package-libfx.mjs");
assert.match(
  packager,
  /"sdk\/memfs\.js"/,
  "package-libfx.mjs leaves memfs.js out of the package; fx-sdk.js imports it",
);

// 3. A host that runs MCP servers in the page ships with the SDK.
for (const file of ["sdk/mcp-browser.js", "sdk/mcp-install.js", "sdk/mcp-oauth.js", "sdk/mcp-host.html"]) {
  assert.ok(read(file).length > 0, `${file} is missing from the fork`);
}

// 4. The record of what this fork changes, so the next sync has a checklist.
const notice = read("NOTICE.unbound");
assert.match(notice, /host_tool_runtime/, "NOTICE.unbound no longer records the tool cap");
assert.match(notice, /memfs/, "NOTICE.unbound no longer records the in-memory filesystem");

console.error("unbound fork guards passed");
