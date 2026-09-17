#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "libfx-browser-package-"));
const packageDir = join(temp, "package");

try {
  const packaged = spawnSync(
    process.execPath,
    [resolve(repoRoot, "sdk/scripts/package-libfx.mjs"), packageDir, "--browser-only"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(packaged.status, 0, `${packaged.stdout}\n${packaged.stderr}`);

  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.equal(manifest.exports["./mcp/browser"], "./mcp-browser.js");
  assert.equal(manifest.exports["./mcp/install"], "./mcp-install.js");
  assert.equal(manifest.exports["./skills"], "./skills.js");
  assert.equal(manifest.exports["./fx-term.wasm"], "./fx-term.wasm");
  assert.equal(manifest.dependencies["@modelcontextprotocol/sdk"], "^1.30.0");

  for (const file of ["fx-term.wasm", "mcp-host.html", "mcp-callback.html", "mcp-browser.d.ts", "skills.d.ts"]) {
    await access(join(packageDir, file));
  }
  await assert.rejects(access(join(packageDir, "fx-core.wasm")));
  await assert.rejects(access(join(packageDir, "node.js")));

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(npm, ["pack", packageDir, "--ignore-scripts", "--pack-destination", temp, "--json"], {
    cwd: temp,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const [{ filename }] = JSON.parse(packed.stdout);

  const appDir = join(temp, "app");
  await mkdir(appDir);
  await writeFile(join(appDir, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: { libfx: `file:../${filename}` },
  }, null, 2)}\n`);
  const installed = spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: appDir,
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { strict as assert } from "node:assert";
    import { createBrowserMcp } from "libfx/mcp/browser";
    import { parseMcpAdd } from "libfx/mcp/install";
    import { BrowserOAuthProvider, signOut } from "libfx/mcp/oauth";
    import { createBrowserSkillTools } from "libfx/skills";
    assert.equal(typeof createBrowserMcp, "function");
    assert.equal(parseMcpAdd(["add", "memory", "npx", "-y", "@modelcontextprotocol/server-memory"]).name, "memory");
    const tools = createBrowserSkillTools([{ toolName: "unbound-test", content: [
      "---",
      "name: test",
      "description: Test package",
      "---",
      "Follow the packaged instructions.",
    ].join("\\n") }]);
    assert.deepEqual(tools[0].inputSchema.properties.name.enum, ["unbound-test"]);

    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const saved = { id: "saved", kind: "npm", name: "saved", pkg: "saved", version: "latest", args: [], env: {} };
    storage.setItem("test.mcp-servers", JSON.stringify([saved]));
    const mcp = createBrowserMcp({ hostUrl: "/host", redirectUrl: "/callback", storage, storagePrefix: "test" });
    assert.equal(mcp.servers()[0].name, "saved");
    assert.equal(await mcp.command("remove saved"), "Removed saved.");
    assert.deepEqual(JSON.parse(storage.getItem("test.mcp-servers")), []);
    mcp.setServers([{ id: "one", kind: "npm", name: "memory", pkg: "memory", version: "latest", args: [], env: {} }]);
    assert.equal(JSON.parse(storage.getItem("test.mcp-servers"))[0].name, "memory");
    const oauth = new BrowserOAuthProvider({
      serverUrl: "https://mcp.example.test",
      storage,
      storagePrefix: "test",
      redirectUrl: "/callback",
      clientName: "test",
    });
    oauth.saveTokens({ access_token: "secret", token_type: "bearer" });
    assert.equal(oauth.tokens().access_token, "secret");
    signOut("test", "https://mcp.example.test", storage);
    assert.equal(oauth.tokens(), undefined);
  `], { cwd: appDir, encoding: "utf8" });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  console.log("browser package passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}
