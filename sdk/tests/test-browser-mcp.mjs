#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "libfx-browser-mcp-"));
await Promise.all(
  ["mcp-browser.js", "mcp-install.js", "mcp-oauth.js", "mcp.js"].map((file) =>
    cp(new URL(`../${file}`, import.meta.url), join(root, file)),
  ),
);
const sdk = join(root, "node_modules", "@modelcontextprotocol", "sdk");
await mkdir(join(sdk, "client"), { recursive: true });
await writeFile(
  join(sdk, "package.json"),
  JSON.stringify({
    name: "@modelcontextprotocol/sdk",
    type: "module",
    exports: {
      "./client/auth.js": "./client/auth.js",
      "./client/index.js": "./client/index.js",
      "./client/sse.js": "./client/sse.js",
      "./client/streamableHttp.js": "./client/streamableHttp.js",
    },
  }),
);
await writeFile(
  join(sdk, "client", "auth.js"),
  "export class UnauthorizedError extends Error {}\nexport async function auth(...args) { return globalThis.__mcpTestAuth?.(...args) ?? 'AUTHORIZED'; }\n",
);
await writeFile(
  join(sdk, "client", "index.js"),
  `export class Client {
    constructor() { globalThis.__mcpTestClients?.push(this); }
    async connect(transport) {
      this.transport = transport;
      await globalThis.__mcpTestConnect?.(transport);
    }
    listTools(params) { return globalThis.__mcpTestListTools(this.transport, params); }
    callTool(params) { return globalThis.__mcpTestCallTool?.(this.transport, params) ?? { content: [] }; }
    async close() {
      await this.transport?.close?.();
      this.onclose?.();
    }
  }
  `,
);
const transport = `export class Transport {
  constructor(url, options) { this.url = String(url); this.options = options; }
}
`;
await writeFile(join(sdk, "client", "sse.js"), `${transport}export { Transport as SSEClientTransport };\n`);
await writeFile(
  join(sdk, "client", "streamableHttp.js"),
  `${transport}export { Transport as StreamableHTTPClientTransport };\n`,
);

const { createBrowserMcp } = await import(pathToFileURL(join(root, "mcp-browser.js")));
const remote = (name, suffix = name) => ({
  name,
  kind: "remote",
  transport: "http",
  url: `https://mcp.example/${suffix}`,
  headers: { Authorization: "Bearer test" },
});
const storage = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

const first = createBrowserMcp();
assert.match(await first.command("add --transport http one https://mcp.example/one -H 'Authorization: Bearer test'"), /Added/);
assert.equal(first.servers().length, 1);
assert.doesNotMatch(first.connectionKey(first.servers()[0]), /Bearer|test/, "connection keys must not retain credentials");
assert.equal(createBrowserMcp().servers().length, 0, "default storage is per-runtime memory");
const copied = first.servers();
copied[0].headers.Authorization = "changed";
assert.equal(first.servers()[0].headers.Authorization, "Bearer test", "server snapshots do not expose mutable state");
assert.throws(() => createBrowserMcp({ maxTools: 64 }), /1 to 63/);

const persisted = storage();
const persistedOne = createBrowserMcp({ storage: persisted, storagePrefix: "test" });
persistedOne.setServers([remote("saved")]);
assert.equal(createBrowserMcp({ storage: persisted, storagePrefix: "test" }).servers()[0].name, "saved");
persisted.values.set("test.mcp-oauth.https://mcp.example/saved", JSON.stringify({ tokens: { access_token: "secret" } }));
persistedOne.setServers([remote("saved", "replacement")]);
assert.equal(persisted.values.has("test.mcp-oauth.https://mcp.example/saved"), false, "replacing a URL clears credentials");
assert.throws(() => persistedOne.setServers(Array.from({ length: 17 }, (_, index) => remote(`s${index}`))), /at most 16/);

let active = 0;
let peak = 0;
globalThis.__mcpTestConnect = async () => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 5));
  active -= 1;
};
globalThis.__mcpTestListTools = (server) => ({
  tools: [{ name: server.url.split("/").at(-1), description: "test", inputSchema: { type: "object" } }],
});
const concurrent = createBrowserMcp();
concurrent.setServers(Array.from({ length: 6 }, (_, index) => remote(`server${index}`)));
const staleServer = concurrent.servers()[0];
const connecting = concurrent.connect();
concurrent.setServers([]);
await assert.rejects(connecting, /servers changed while they were connecting/);
assert.equal(peak, 4, "server connection concurrency is bounded");
assert.equal(concurrent.status(staleServer).state, "starting", "a stale connect must not restore removed status");

const clients = [];
globalThis.__mcpTestClients = clients;
globalThis.__mcpTestConnect = undefined;
let disconnectNotifications = 0;
const closed = createBrowserMcp({
  onServersChange: () => {
    disconnectNotifications += 1;
  },
});
const closedServer = remote("closed");
closed.setServers([closedServer]);
await closed.connect();
disconnectNotifications = 0;
assert.equal(closed.status(closed.servers()[0]).state, "ready");
clients.at(-1).onclose();
assert.equal(closed.status(closed.servers()[0]).state, "starting", "a spontaneous close clears ready status");
assert.equal(disconnectNotifications, 1, "a spontaneous close tells the host to refresh its tool set");

const oauthStorage = storage();
const oauth = createBrowserMcp({
  storage: oauthStorage,
  storagePrefix: "oauth-test",
  redirectUrl: "https://app.example/fx-mcp-callback.html",
});
const oauthServer = { ...remote("oauth"), headers: {} };
oauth.setServers([oauthServer]);
let popupCount = 0;
const popup = { close() {}, location: { href: "" } };
globalThis.window = { open: () => (popupCount += 1, popup) };
let finishFirstAuth;
globalThis.__mcpTestAuth = async (provider) => {
  await new Promise((resolve) => {
    finishFirstAuth = resolve;
  });
  provider.saveTokens({ access_token: "stale" });
  return "AUTHORIZED";
};
assert.match(await oauth.command("auth oauth"), /Opened oauth's sign-in page/);
assert.match(await oauth.command("auth oauth"), /already in progress/);
assert.equal(popupCount, 1, "only one OAuth popup opens per server URL");
oauth.setServers([]);
oauth.setServers([oauthServer]);
assert.match(await oauth.command("auth oauth"), /already in progress/, "a cancelled attempt remains serialized until it settles");
finishFirstAuth();
await new Promise((resolve) => setTimeout(resolve, 0));
const oauthKey = "oauth-test.mcp-oauth.https://mcp.example/oauth";
assert.equal(oauthStorage.values.has(oauthKey), false, "a removed server cannot regain stale OAuth credentials");
globalThis.__mcpTestAuth = async (provider) => {
  provider.saveTokens({ access_token: "current" });
  return "AUTHORIZED";
};
assert.match(await oauth.command("auth oauth"), /Opened oauth's sign-in page/);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(JSON.parse(oauthStorage.values.get(oauthKey)).tokens.access_token, "current");

const configured = createBrowserMcp({ redirectUrl: "https://app.example/fx-mcp-callback.html" });
configured.setServers([remote("configured")]);
assert.match(await configured.command("auth configured"), /uses a configured Authorization header/);
assert.match(await configured.command("logout configured"), /uses a configured Authorization header/);
assert.equal(popupCount, 2, "configured credentials never open an OAuth popup");

const switchStorage = storage();
const switching = createBrowserMcp({
  storage: switchStorage,
  storagePrefix: "switch-test",
  redirectUrl: "https://app.example/fx-mcp-callback.html",
});
const switchingOauth = { ...remote("switching", "switching"), headers: {} };
const switchingStatic = remote("switching", "switching");
const switchKey = "switch-test.mcp-oauth.https://mcp.example/switching";
switching.setServers([switchingOauth]);
switchStorage.values.set(switchKey, JSON.stringify({ tokens: { access_token: "old-oauth" } }));
let finishSwitchAuth;
globalThis.__mcpTestAuth = async (provider) => {
  await new Promise((resolve) => {
    finishSwitchAuth = resolve;
  });
  provider.saveTokens({ access_token: "late-oauth" });
  return "AUTHORIZED";
};
assert.match(await switching.command("auth switching"), /Opened switching's sign-in page/);
switching.setServers([switchingStatic]);
assert.equal(switchStorage.values.has(switchKey), false, "switching to static auth clears stored OAuth credentials");
finishSwitchAuth();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(switchStorage.values.has(switchKey), false, "a cancelled OAuth attempt cannot restore credentials");
switchStorage.values.set(switchKey, JSON.stringify({ tokens: { access_token: "stale-oauth" } }));
switching.setServers([switchingOauth]);
assert.equal(switchStorage.values.has(switchKey), false, "switching from static auth clears stale OAuth storage");

let hostMessage;
let hostStartCount = 0;
const hostWindow = {
  postMessage() {
    hostStartCount += 1;
  },
};
globalThis.window = {
  location: { href: "https://app.example/harness", origin: "https://app.example" },
  addEventListener: (_type, listener) => {
    hostMessage = listener;
  },
  removeEventListener: () => {},
};
globalThis.document = {
  createElement: () => ({
    contentWindow: hostWindow,
    hidden: false,
    setAttribute() {},
    src: "",
  }),
  body: { appendChild() {} },
};
globalThis.__mcpTestConnect = (npmTransport) => npmTransport.start();
const npmClosing = createBrowserMcp({ hostUrl: "/fx-mcp-host.html" });
npmClosing.setServers([
  { name: "npm-closing", kind: "npm", pkg: "example-mcp", version: "latest", args: [], env: {} },
]);
const npmConnecting = npmClosing.connect();
npmClosing.setServers([]);
assert.equal(typeof hostMessage, "function", "npm startup reached the pending host frame");
hostMessage({ source: hostWindow, origin: "null", data: { type: "mcp-host-ready" } });
await assert.rejects(npmConnecting, /servers changed while they were connecting/);
assert.equal(hostStartCount, 0, "a removed npm server never starts when the host frame becomes ready later");

const pagination = createBrowserMcp({ maxTools: 2 });
const pagedServer = remote("paged");
pagination.setServers([pagedServer]);
globalThis.__mcpTestConnect = undefined;
globalThis.__mcpTestListTools = (_server, params) => ({
  tools: [{ name: params ? "two" : "one" }],
  nextCursor: "same",
});
await assert.rejects(pagination.listTools(pagedServer), /invalid tools\/list cursor/);
pagination.reset(pagedServer);
globalThis.__mcpTestListTools = () => ({ tools: [{ name: "one" }, { name: "two" }, { name: "three" }] });
await assert.rejects(pagination.listTools(pagedServer), /more than 2 tools/);
pagination.reset(pagedServer);
globalThis.__mcpTestListTools = () => ({ nope: [] });
await assert.rejects(pagination.listTools(pagedServer), /invalid tools\/list response/);

delete globalThis.__mcpTestConnect;
delete globalThis.__mcpTestListTools;
delete globalThis.__mcpTestCallTool;
delete globalThis.__mcpTestClients;
delete globalThis.__mcpTestAuth;
delete globalThis.window;
delete globalThis.document;
await rm(root, { recursive: true, force: true });
console.error("browser MCP runtime bounds passed");
