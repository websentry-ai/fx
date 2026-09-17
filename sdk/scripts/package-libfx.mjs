#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const args = process.argv.slice(2);
const browserOnly = args.includes("--browser-only");
const positional = args.filter((arg) => arg !== "--browser-only");
const outputDir = resolve(positional[0] || resolve(repoRoot, browserOnly ? "sdk/dist/libfx-browser" : "sdk/dist/libfx"));
const requestedNativeAddons = positional.slice(1).map((path) => resolve(path));
const defaultNativeAddon = resolve(repoRoot, "zig-out/lib/libfx.node");
const nativeAddons = requestedNativeAddons.length ? requestedNativeAddons : [defaultNativeAddon];
const requiredNativeNames = new Set([
  "libfx.linux-x64.node",
  "libfx.linux-arm64.node",
  "libfx.darwin-x64.node",
  "libfx.darwin-arm64.node",
]);
const localNativeName = {
  "linux-x64": "libfx.linux-x64.node",
  "linux-arm64": "libfx.linux-arm64.node",
  "darwin-x64": "libfx.darwin-x64.node",
  "darwin-arm64": "libfx.darwin-arm64.node",
}[`${process.platform}-${process.arch}`];
const browserFiles = [
  ["sdk/package.json", "package.json"],
  ["sdk/README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["NOTICE.unbound", "NOTICE.unbound"],
  ["sdk/fx-sdk.js", "fx-sdk.js"],
  ["sdk/fx-sdk.d.ts", "fx-sdk.d.ts"],
  ["sdk/wasm-module.js", "wasm-module.js"],
  ["sdk/core-output.js", "core-output.js"],
  ["sdk/mcp.js", "mcp.js"],
  ["sdk/mcp.d.ts", "mcp.d.ts"],
  ["sdk/mcp-browser.js", "mcp-browser.js"],
  ["sdk/mcp-browser.d.ts", "mcp-browser.d.ts"],
  ["sdk/mcp-install.js", "mcp-install.js"],
  ["sdk/mcp-install.d.ts", "mcp-install.d.ts"],
  ["sdk/mcp-oauth.js", "mcp-oauth.js"],
  ["sdk/mcp-oauth.d.ts", "mcp-oauth.d.ts"],
  ["sdk/mcp-host.html", "mcp-host.html"],
  ["sdk/mcp-callback.html", "mcp-callback.html"],
  ["sdk/skills.js", "skills.js"],
  ["sdk/skills.d.ts", "skills.d.ts"],
  ["zig-out/bin/fx-term.wasm", "fx-term.wasm"],
];
const files = browserOnly ? browserFiles : [
  ...browserFiles,
  ["sdk/browser.js", "browser.js"],
  ["sdk/node.js", "node.js"],
  ["sdk/skills-node.js", "skills-node.js"],
  ["zig-out/bin/fx-core.wasm", "fx-core.wasm"],
];

if (!browserOnly && requestedNativeAddons.length) {
  const names = nativeAddons.map((addon) => basename(addon));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const missing = [...requiredNativeNames].filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !requiredNativeNames.has(name));
  if (duplicates.length || missing.length || unexpected.length) {
    throw new Error([
      "publishable package requires exactly one addon for every supported platform",
      duplicates.length ? `duplicates: ${duplicates.join(", ")}` : null,
      missing.length ? `missing: ${missing.join(", ")}` : null,
      unexpected.length ? `unexpected: ${unexpected.join(", ")}` : null,
    ].filter(Boolean).join("; "));
  }
}
if (!browserOnly && !requestedNativeAddons.length && !localNativeName) {
  throw new Error(`local native packaging is unsupported on ${process.platform}-${process.arch}`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
if (!browserOnly) {
  const cjsBuild = spawnSync(process.execPath, [
    resolve(repoRoot, "sdk/scripts/build-node-cjs.mjs"),
    resolve(outputDir, "node.cjs"),
  ], { cwd: repoRoot, stdio: "inherit" });
  if (cjsBuild.error) throw cjsBuild.error;
  if (cjsBuild.status !== 0) process.exit(cjsBuild.status ?? 1);
}
for (const [source, destination] of files) {
  await cp(resolve(repoRoot, source), resolve(outputDir, destination));
}
for (const addon of browserOnly ? [] : nativeAddons) {
  if (!addon.endsWith(".node")) throw new Error(`native addon must end in .node: ${addon}`);
  const destination = requestedNativeAddons.length ? basename(addon) : localNativeName;
  await cp(addon, resolve(outputDir, destination));
}

const manifest = JSON.parse(await readFile(resolve(outputDir, "package.json"), "utf8"));
manifest.files = undefined;
manifest.scripts = undefined;
if (browserOnly) {
  manifest.types = undefined;
  manifest.exports = {
    "./wasm": "./fx-sdk.js",
    "./mcp": "./mcp.js",
    "./mcp/browser": "./mcp-browser.js",
    "./mcp/install": "./mcp-install.js",
    "./mcp/oauth": "./mcp-oauth.js",
    "./skills": "./skills.js",
    "./fx-term.wasm": "./fx-term.wasm",
    "./mcp-host.html": "./mcp-host.html",
    "./mcp-callback.html": "./mcp-callback.html",
  };
}
await writeFile(resolve(outputDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`packaged ${manifest.name} in ${outputDir}`);
if (!browserOnly) console.log("  node.cjs");
for (const [, destination] of files) console.log(`  ${destination}`);
for (const addon of browserOnly ? [] : nativeAddons) {
  console.log(`  ${requestedNativeAddons.length ? basename(addon) : localNativeName}`);
}
