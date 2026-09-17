// MCP servers for a browser host: npm servers run in this browser, remote ones
// are reached from it, and their tools become fx host tools.
//
// fx's wasm build has no MCP runtime of its own, so the page runs the official
// client and hands fx the tools (see sdk/mcp.js for the adapter). It also
// answers fx's `/mcp` command, which the terminal forwards to the host.
//
//   const mcp = createBrowserMcp({
//     hostUrl: "/fx-mcp-host.html",            // this origin, frame-ancestors 'self'
//     redirectUrl: `${origin}/fx-mcp-callback.html`,
//     gate: async (server, tool) => ({ run: true }),
//     onServersChange: (servers) => render(servers),
//   });
//   terminal.setTools(mcp.connect().then((r) => r.tools));
//   const answer = await mcp.command("add memory npx -y @modelcontextprotocol/server-memory");
//
// An npm server's code never runs on this origin: sdk/mcp-host.html holds it in
// a sandboxed frame, one Web Worker per server, and only this transport's port
// connects the two.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpAdapter } from "./mcp.js";
import { parseMcpAdd, shellWords } from "./mcp-install.js";
import { BrowserOAuthProvider, openSignInWindow, signIn, signOut } from "./mcp-oauth.js";

// fx takes at most 128 host tools, and its own shell and skill tools count
// toward the same per-request limit many providers set.
const DEFAULT_MAX_TOOLS = 126;
// An npm server downloads its package and dependencies before it starts.
const START_TIMEOUT_MS = 90_000;
const STDERR_TAIL = 2000;

const USAGE = [
  "/mcp                                   list servers and their tools",
  "/mcp add <name> <command> [args…]      add a server that runs with npx",
  "/mcp add --transport http <name> <url> add a remote server",
  "/mcp add-json <name> '<json>'          add a server from its JSON config",
  "/mcp remove <name>                     remove a server",
  "/mcp auth <name>                       sign in to a remote server",
  "/mcp logout <name>                     sign out of a remote server",
].join("\n");

/** A remote server that needs a sign-in before it lists its tools. */
export class McpSignInRequired extends Error {
  constructor(server) {
    super(`${server} asks you to sign in. Run /mcp auth ${server}.`);
    this.server = server;
  }
}

/** How a server is reached, which is what a connection is keyed by. */
const connectionKey = (server) =>
  JSON.stringify(
    server.kind === "npm"
      ? [server.kind, server.pkg, server.version, server.args, server.env]
      : [server.kind, server.transport, server.url, server.headers],
  );

export function describeServer(server) {
  if (server.kind === "remote") return server.url;
  const env = Object.keys(server.env).map((key) => `${key}=… `);
  const version = server.version === "latest" ? "" : `@${server.version}`;
  return `${env.join("")}npx -y ${server.pkg}${version}${server.args.length ? ` ${server.args.join(" ")}` : ""}`;
}

function withTimeout(pending, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), START_TIMEOUT_MS);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

/** One hidden sandboxed frame hosts every npm server's worker. */
function hostFrame(hostUrl) {
  let frame = null;
  return () => {
    if (!frame) {
      frame = new Promise((resolve, reject) => {
        const element = document.createElement("iframe");
        // allow-scripts without allow-same-origin gives the frame an opaque origin.
        element.setAttribute("sandbox", "allow-scripts");
        element.hidden = true;
        element.src = hostUrl;
        const onMessage = (event) => {
          if (event.source !== element.contentWindow || event.data?.type !== "mcp-host-ready") return;
          window.removeEventListener("message", onMessage);
          resolve(element.contentWindow);
        };
        window.addEventListener("message", onMessage);
        element.onerror = () => reject(new Error("the MCP host frame did not load"));
        document.body.appendChild(element);
      });
      frame.catch(() => {
        frame = null;
      });
    }
    return frame;
  };
}

/** Speaks MCP to an npm server over the stdio of its worker in the host frame. */
class NpmServerTransport {
  onclose;
  onerror;
  onmessage;
  #frame;
  #spec;
  #port = null;
  #stdout = "";
  #stderr = "";
  #closed = false;

  constructor(frame, spec) {
    this.#frame = frame;
    this.#spec = spec;
  }

  /** Resolves once the server's module has run, so it is reading its stdin. */
  async start() {
    const host = await this.#frame();
    const channel = new MessageChannel();
    this.#port = channel.port1;
    await new Promise((resolve, reject) => {
      let started = false;
      channel.port1.onmessage = ({ data }) => {
        if (data.type === "stdout") {
          this.#readStdout(data.text);
        } else if (data.type === "stderr") {
          this.#stderr = (this.#stderr + data.text).slice(-STDERR_TAIL);
        } else if (data.type === "started") {
          started = true;
          resolve();
        } else if (data.type === "error" || data.type === "exit") {
          const failure = data.type === "error" ? data.message : `exited with code ${data.code}`;
          const error = new Error(this.#failure(failure));
          if (started) {
            this.onerror?.(error);
            void this.close();
          } else {
            reject(error);
          }
        }
      };
      const { pkg, version, env, args } = this.#spec;
      host.postMessage({ type: "start", pkg, version, env, args }, "*", [channel.port2]);
    });
  }

  async send(message) {
    if (!this.#port || this.#closed) throw new Error("the MCP server is not running");
    this.#port.postMessage({ type: "stdin", line: `${JSON.stringify(message)}\n` });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#port?.postMessage({ type: "stop" });
    this.#port?.close();
    this.onclose?.();
  }

  /** stdout carries one JSON-RPC message per line, as MCP's stdio transport writes it. */
  #readStdout(text) {
    this.#stdout += text;
    let newline = this.#stdout.indexOf("\n");
    while (newline !== -1) {
      const line = this.#stdout.slice(0, newline).replace(/\r$/, "");
      this.#stdout = this.#stdout.slice(newline + 1);
      newline = this.#stdout.indexOf("\n");
      if (!line.trim()) continue;
      try {
        this.onmessage?.(JSON.parse(line));
      } catch {
        this.onerror?.(new Error(`the server wrote a line that is not JSON-RPC: ${line.slice(0, 200)}`));
      }
    }
  }

  /** The server's own stderr usually says why it stopped, a missing token say. */
  #failure(reason) {
    const said = this.#stderr.trim().split("\n").slice(-3).join(" ").trim();
    return said ? `${reason}: ${said}` : reason;
  }
}

const readServers = (key) => {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored) ? stored.filter((server) => server?.name && server?.kind) : [];
  } catch {
    return [];
  }
};

/**
 * The MCP runtime for one page. Options:
 *   hostUrl        where sdk/mcp-host.html is served on this origin
 *   redirectUrl    where sdk/mcp-callback.html is served, for OAuth
 *   gate           (server, tool) => {run:true} | {run:false, reason} before every call
 *   onServersChange runs when /mcp add, remove or a sign-in changes the list
 *   storagePrefix  localStorage namespace, default "fx"
 *   channel        BroadcastChannel the redirect page posts on, default "fx.mcp-oauth"
 *   clientName     what a remote server sees this client called
 *   maxTools       how many tools fx will take, default 126
 */
export function createBrowserMcp(options) {
  const {
    hostUrl,
    redirectUrl,
    gate = async () => ({ run: true }),
    onServersChange = () => {},
    storagePrefix = "fx",
    channel = "fx.mcp-oauth",
    clientName = "fx",
    maxTools = DEFAULT_MAX_TOOLS,
  } = options;
  const serversKey = `${storagePrefix}.mcp-servers`;
  const frame = hostFrame(hostUrl);
  const connections = new Map();
  const statuses = new Map();
  // A sign-in finishes in its own window, after the command has returned.
  const signInFailures = new Map();
  // The sign-in each server waits on, so one cancelled by removing or signing
  // out of the server cannot save its tokens when it finally lands.
  const signInAttempts = new Map();
  let servers = readServers(serversKey);

  const provider = (server) =>
    new BrowserOAuthProvider({ serverUrl: server.url, storagePrefix, redirectUrl, clientName });

  async function open(server) {
    const client = new Client({ name: clientName, version: "1.0.0" });
    if (server.kind === "npm") {
      await client.connect(new NpmServerTransport(frame, server));
      return client;
    }
    // A server given a static Authorization header does not need the OAuth flow.
    const hasAuthorization = Object.keys(server.headers).some((key) => key.toLowerCase() === "authorization");
    const transportOptions = {
      authProvider: hasAuthorization ? undefined : provider(server),
      requestInit: { headers: server.headers },
    };
    const url = new URL(server.url);
    const transport =
      server.transport === "sse"
        ? new SSEClientTransport(url, transportOptions)
        : new StreamableHTTPClientTransport(url, transportOptions);
    try {
      await client.connect(transport);
    } catch (error) {
      if (error instanceof UnauthorizedError) throw new McpSignInRequired(server.name);
      throw error;
    }
    return client;
  }

  function client(server) {
    const key = connectionKey(server);
    let pending = connections.get(key);
    if (!pending) {
      const opening = open(server);
      const forget = () => connections.get(key) === opening && connections.delete(key);
      connections.set(key, opening);
      opening.then((connected) => {
        connected.onclose = forget;
      }, forget);
      pending = opening;
    }
    return pending;
  }

  function reset(server) {
    const key = connectionKey(server);
    const pending = connections.get(key);
    connections.delete(key);
    pending?.then((connected) => connected.close()).catch(() => {});
  }

  function setServers(next) {
    servers = next;
    try {
      localStorage.setItem(serversKey, JSON.stringify(next));
    } catch {}
    const kept = new Set(next.map(connectionKey));
    for (const [key, pending] of connections) {
      if (kept.has(key)) continue;
      connections.delete(key);
      pending.then((connected) => connected.close()).catch(() => {});
    }
    onServersChange(next);
  }

  const status = (server) => statuses.get(connectionKey(server)) ?? { state: "starting" };

  async function listTools(server) {
    const connected = await client(server);
    const tools = [];
    let cursor;
    do {
      const page = await connected.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools.map(({ name, title, description }) => ({ name, title, description })));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Every server's tools, named `mcp__<server>__<tool>` as coding agents name them. */
  async function connect() {
    for (const server of servers) {
      if (status(server).state !== "ready") statuses.set(connectionKey(server), { state: "starting" });
    }
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const connected = await withTimeout(client(server), `${server.name} did not start within 90 seconds.`);
        const gated = {
          listTools: (params) => connected.listTools(params),
          async callTool(params, schema, callOptions) {
            const verdict = await gate(server.name, params.name);
            // fx prints a failed tool call on one line, so the message keeps to one.
            if (!verdict.run) {
              return { isError: true, content: [{ type: "text", text: verdict.reason.replace(/\s*\n\s*/g, " ") }] };
            }
            return connected.callTool(params, schema, callOptions);
          },
        };
        return createMcpAdapter(gated, { prefix: `mcp__${server.name}__` });
      }),
    );

    const tools = [];
    const failures = [];
    results.forEach((result, index) => {
      const server = servers[index];
      const key = connectionKey(server);
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        statuses.set(key, result.reason instanceof McpSignInRequired ? { state: "sign-in" } : { state: "failed", message });
        failures.push({ server: server.name, message });
        return;
      }
      const serverTools = result.value.tools;
      if (tools.length + serverTools.length > maxTools) {
        const message = `its ${serverTools.length} tools would pass the limit of ${maxTools} MCP tools. Remove a server to use it.`;
        statuses.set(key, { state: "failed", message });
        failures.push({ server: server.name, message });
        return;
      }
      tools.push(...serverTools);
      const prefix = `mcp__${server.name}__`;
      statuses.set(key, { state: "ready", tools: serverTools.map((tool) => tool.name.slice(prefix.length)) });
    });
    return { tools, failures };
  }

  function describeStatus(server) {
    const current = status(server);
    if (current.state === "ready") return `${current.tools.length} tools: ${current.tools.join(", ")}`;
    if (current.state === "starting") return server.kind === "npm" ? "installing…" : "connecting…";
    if (current.state === "sign-in") {
      const failure = signInFailures.get(server.name);
      return `needs sign-in: run /mcp auth ${server.name}${failure ? ` (last try: ${failure})` : ""}`;
    }
    return `failed: ${current.message}`;
  }

  function list() {
    if (servers.length === 0) return `No MCP servers.\n${USAGE}`;
    const lines = servers.flatMap((server) => [`${server.name}  ${describeServer(server)}`, `  ${describeStatus(server)}`]);
    return [`MCP servers (${servers.length}):`, ...lines].join("\n");
  }

  function addServer(words) {
    let server;
    try {
      server = parseMcpAdd(words);
    } catch (error) {
      return error.message;
    }
    const replaced = servers.some((existing) => existing.name === server.name);
    setServers([...servers.filter((existing) => existing.name !== server.name), { ...server, id: crypto.randomUUID() }]);
    const next = server.kind === "npm" ? "It installs in this browser." : "Connecting to it.";
    return `${replaced ? "Replaced" : "Added"} ${server.name}: ${describeServer(server)}\n${next} Run /mcp to see its tools.`;
  }

  /** Drops the server's tokens, and any sign-in still running for it. */
  function forgetCredentials(server) {
    signInAttempts.delete(server.url);
    signOut(storagePrefix, server.url);
  }

  function removeServer(server) {
    if (server.kind === "remote") forgetCredentials(server);
    setServers(servers.filter((existing) => existing !== server));
    return `Removed ${server.name}.`;
  }

  function authenticate(server) {
    // The window opens now, while the keypress still lets a page open one.
    const popup = openSignInWindow();
    if (!popup) return "The browser blocked the sign-in window. Allow popups for this page, then run the command again.";
    signInFailures.delete(server.name);
    const attempt = Symbol(server.url);
    signInAttempts.set(server.url, attempt);
    signIn({ serverUrl: server.url, popup, provider: provider(server), channel }).then(
      () => {
        // A sign-in that lands after remove or logout must not leave tokens
        // behind for a server the user let go of.
        if (signInAttempts.get(server.url) !== attempt) {
          signOut(storagePrefix, server.url);
          return;
        }
        reset(server);
        onServersChange(servers);
      },
      (error) => signInFailures.set(server.name, error.message),
    );
    return `Opened ${server.name}'s sign-in page in a new window. Finish there, then run /mcp.`;
  }

  function signOutOf(server) {
    forgetCredentials(server);
    reset(server);
    onServersChange(servers);
    return `Signed out of ${server.name}.`;
  }

  /** Answers fx's `/mcp …`, with the words after `/mcp`. */
  async function command(input) {
    let words;
    try {
      words = shellWords(input.trim());
    } catch (error) {
      return error.message;
    }
    const [sub = "list", name] = words;
    const named = servers.find((server) => server.name === name);
    if (["remove", "rm", "auth", "login", "logout"].includes(sub) && !named) {
      return `No MCP server is named ${name ?? "that"}. Run /mcp to see them.`;
    }
    const remote = named?.kind === "remote" ? named : null;
    const inBrowser = `${named?.name} runs in this browser. It has no sign-in.`;

    switch (sub) {
      case "list":
        return list();
      case "add":
      case "add-json":
        return addServer(words);
      case "remove":
      case "rm":
        return removeServer(named);
      case "auth":
      case "login":
        return remote ? authenticate(remote) : inBrowser;
      case "logout":
        return remote ? signOutOf(remote) : inBrowser;
      default:
        return `This host has no /mcp ${sub}.\n${USAGE}`;
    }
  }

  return {
    servers: () => servers,
    setServers,
    command,
    connect,
    listTools,
    status,
    connectionKey,
    reset,
  };
}
