#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";

const html = await readFile(new URL("../mcp-host.html", import.meta.url), "utf8");
const workerSource = html.match(/<script type="text\/plain" id="server-worker">([\s\S]*?)<\/script>/)?.[1];
assert.ok(workerSource, "MCP worker source is present");

const context = vm.createContext({
  Blob,
  DecompressionStream,
  Map,
  Set,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  URL,
  btoa,
  crypto: webcrypto,
  fetch,
  self: {},
});
vm.runInContext(workerSource, context);
const verifyIntegrity = vm.runInContext("verifyIntegrity", context);
const readBounded = vm.runInContext("readBounded", context);
const unpackTar = vm.runInContext("unpackTar", context);
const unpackTarball = vm.runInContext("unpackTarball", context);

const bytes = new TextEncoder().encode("trusted package");
const digest = Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("base64");
await verifyIntegrity(bytes, `sha256-${digest}`);
await assert.rejects(verifyIntegrity(bytes, "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), /integrity/);
await assert.rejects(verifyIntegrity(bytes, "md5-deadbeef"), /supported integrity/);

const bounded = new ReadableStream({
  start(controller) {
    controller.enqueue(Uint8Array.of(1, 2));
    controller.enqueue(Uint8Array.of(3));
    controller.close();
  },
});
assert.deepEqual([...await readBounded(bounded, 3, "fixture")], [1, 2, 3]);
const oversized = new ReadableStream({
  start(controller) {
    controller.enqueue(Uint8Array.of(1, 2, 3, 4));
  },
});
await assert.rejects(readBounded(oversized, 3, "fixture"), /exceeds 3 bytes/);

function tarEntry(name, contents = "x") {
  const body = new TextEncoder().encode(contents);
  const tar = new Uint8Array(512 + Math.ceil(body.length / 512) * 512 + 512);
  tar.set(new TextEncoder().encode(name), 0);
  tar.set(new TextEncoder().encode(body.length.toString(8).padStart(11, "0")), 124);
  tar[156] = "0".charCodeAt(0);
  tar.set(body, 512);
  return tar;
}

const writes = [];
const fs = {
  mkdirSync() {},
  writeFileSync(path, contents) {
    writes.push([path, new TextDecoder().decode(contents)]);
  },
};
unpackTar(tarEntry("package/bin/server.js", "ok"), fs, "/node_modules/server");
assert.deepEqual(writes, [["/node_modules/server/bin/server.js", "ok"]]);
assert.throws(
  () => unpackTar(tarEntry("package/../../secret", "no"), fs, "/node_modules/server"),
  /unsafe file path/,
);
const archive = gzipSync(tarEntry("package/bin/verified.js", "verified"));
const archiveDigest = Buffer.from(await webcrypto.subtle.digest("SHA-512", archive)).toString("base64");
await unpackTarball(
  `data:application/octet-stream;base64,${archive.toString("base64")}`,
  `sha512-${archiveDigest}`,
  fs,
  "/node_modules/verified",
);
assert.deepEqual(writes.at(-1), ["/node_modules/verified/bin/verified.js", "verified"]);

const relaySource = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
assert.ok(relaySource, "MCP relay source is present");
const topLevelWindow = { origin: "https://example.com" };
topLevelWindow.parent = topLevelWindow;
assert.throws(
  () => vm.runInNewContext(relaySource, { window: topLevelWindow }),
  /opaque-origin sandboxed iframe/,
);

console.error("browser MCP host security passed");
