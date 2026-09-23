// Browser MCP runtime for remote servers and sandboxed npm-server workers.
// The host owns persistence, policy gating, and wiring these tools into fx.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpAdapter } from "./mcp.js";
import { parseMcpAdd, shellWords } from "./mcp-install.js";
import { BrowserOAuthProvider, openSignInWindow, signIn, signOut } from "./mcp-oauth.js";

// fx accepts 64 host tools. The browser skill tool occupies one slot.
// Unbound fork: 127, not 63. Linear alone lists 74 tools.
const DEFAULT_MAX_TOOLS = 127;
const MAX_SERVERS = 16;
const CONNECT_CONCURRENCY = 4;
const MAX_TOOL_PAGES = 64;
const MAX_CURSOR_LENGTH = 4096;
// An npm server downloads its package and dependencies before it starts.
const START_TIMEOUT_MS = 90_000;
const STDERR_TAIL = 2000;

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};

const isStringRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).length <= 64 &&
  Object.entries(value).every(
    ([key, entry]) => key.length > 0 && key.length <= 256 && typeof entry === "string" && entry.length <= 16_384,
  );

const isServer = (server) => {
  if (
    !server ||
    typeof server !== "object" ||
    (server.id !== undefined &&
      (typeof server.id !== "string" || server.id.length === 0 || server.id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(server.id))) ||
    typeof server.name !== "string" ||
    server.name.length > 64 ||
    !/^[A-Za-z0-9_-]+$/.test(server.name)
  ) {
    return false;
  }
  if (server.kind === "npm") {
    return (
      typeof server.pkg === "string" &&
      server.pkg.length <= 256 &&
      /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(server.pkg) &&
      typeof server.version === "string" &&
      server.version.length > 0 &&
      server.version.length <= 256 &&
      Array.isArray(server.args) &&
      server.args.length <= 128 &&
      server.args.every((arg) => typeof arg === "string" && arg.length <= 16_384) &&
      isStringRecord(server.env) &&
      Object.keys(server.env).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    );
  }
  if (server.kind !== "remote" || !["http", "sse"].includes(server.transport) || !isStringRecord(server.headers)) {
    return false;
  }
  try {
    const url = new URL(server.url);
    new Headers(server.headers);
    return server.url.length <= 8192 && url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

const cloneServer = (server) =>
  server.kind === "npm"
    ? { ...server, args: [...server.args], env: { ...server.env } }
    : { ...server, headers: { ...server.headers } };

const withServerIds = (servers) => {
  const ids = new Set();
  return servers.map((server) => {
    const preferred = server.id;
    const id = typeof preferred === "string" && !ids.has(preferred) ? preferred : crypto.randomUUID();
    ids.add(id);
    return { ...cloneServer(server), id };
  });
};

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
  `${server.kind}:${typeof server.id === "string" ? server.id : server.name}`;

const hasAuthorizationHeader = (server) =>
  server.kind === "remote" && Object.keys(server.headers).some((key) => key.toLowerCase() === "authorization");

export function describeServer(server) {
  if (server.kind === "remote") return server.url;
  const env = Object.keys(server.env).map((key) => `${key}=… `);
  const version = server.version === "latest" ? "" : `@${server.version}`;
  return `${env.join("")}npx -y ${server.pkg}${version}${server.args.length ? ` ${server.args.join(" ")}` : ""}`;
}

function withTimeout(pending, message, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {}
      reject(new Error(message));
    }, START_TIMEOUT_MS);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function requestTools(connected, params, serverName) {
  const controller = new AbortController();
  return withTimeout(
    connected.listTools(params, {
      signal: controller.signal,
      timeout: START_TIMEOUT_MS,
      maxTotalTimeout: START_TIMEOUT_MS,
    }),
    `${serverName} did not answer tools/list within 90 seconds.`,
    () => controller.abort(),
  );
}

/** One hidden sandboxed frame hosts every npm server's worker. */
function hostFrame(hostUrl) {
  let frame = null;
  return () => {
    if (!frame) {
      frame = new Promise((resolve, reject) => {
        const url = new URL(hostUrl, window.location.href);
        if (url.origin !== window.location.origin) {
          reject(new Error("the MCP host frame must be served from this origin"));
          return;
        }
        const element = document.createElement("iframe");
        // allow-scripts without allow-same-origin gives the frame an opaque origin.
        element.setAttribute("sandbox", "allow-scripts");
        element.hidden = true;
        element.src = url.href;
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          callback();
        };
        const onMessage = (event) => {
          if (
            event.source !== element.contentWindow ||
            event.origin !== "null" ||
            event.data?.type !== "mcp-host-ready"
          ) {
            return;
          }
          finish(() => resolve(element.contentWindow));
        };
        window.addEventListener("message", onMessage);
        const fail = () => finish(() => {
          element.remove();
          reject(new Error("the MCP host frame did not become ready"));
        });
        const timer = setTimeout(fail, START_TIMEOUT_MS);
        element.onerror = fail;
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
  #rejectStart = null;

  constructor(frame, spec) {
    this.#frame = frame;
    this.#spec = spec;
  }

  /** Resolves once the server's module has run, so it is reading its stdin. */
  async start() {
    const host = await this.#frame();
    if (this.#closed) throw new DOMException("This operation was aborted", "AbortError");
    const channel = new MessageChannel();
    this.#port = channel.port1;
    await new Promise((resolve, reject) => {
      let started = false;
      const rejectStart = (error) => {
        if (started) return;
        started = true;
        this.#rejectStart = null;
        reject(error);
      };
      this.#rejectStart = rejectStart;
      const fail = (failure) => {
        const error = new Error(this.#failure(failure));
        if (started) this.onerror?.(error);
        else rejectStart(error);
        void this.close();
      };
      channel.port1.onmessage = ({ data }) => {
        if (!data || typeof data !== "object") {
          fail("the MCP host sent an invalid response");
        } else if (data.type === "stdout" && typeof data.text === "string") {
          this.#readStdout(data.text);
        } else if (data.type === "stderr" && typeof data.text === "string") {
          this.#stderr = (this.#stderr + data.text).slice(-STDERR_TAIL);
        } else if (data.type === "started") {
          if (this.#closed) {
            rejectStart(new DOMException("This operation was aborted", "AbortError"));
            return;
          }
          started = true;
          this.#rejectStart = null;
          resolve();
        } else if (data.type === "error" || data.type === "exit") {
          let failure = "the MCP host reported an invalid error";
          if (data.type === "error" && typeof data.message === "string") failure = data.message;
          else if (data.type === "exit") failure = `exited with code ${String(data.code)}`;
          fail(failure);
        } else {
          fail("the MCP host sent an invalid response");
        }
      };
      const { pkg, version, env, args } = this.#spec;
      try {
        host.postMessage({ type: "start", pkg, version, env, args }, "*", [channel.port2]);
      } catch (error) {
        channel.port2.close();
        fail(error instanceof Error ? error.message : String(error));
      }
    });
  }

  async send(message) {
    if (!this.#port || this.#closed) throw new Error("the MCP server is not running");
    this.#port.postMessage({ type: "stdin", line: `${JSON.stringify(message)}\n` });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectStart?.(new DOMException("This operation was aborted", "AbortError"));
    this.#rejectStart = null;
    this.#port?.postMessage({ type: "stop" });
    this.#port?.close();
    this.#port = null;
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
        this.onerror?.(new Error(this.#redact(`the server wrote a line that is not JSON-RPC: ${line.slice(0, 200)}`)));
      }
    }
  }

  #redact(message) {
    return Object.values(this.#spec.env).reduce(
      (redacted, value) => (value ? redacted.split(value).join("[redacted]") : redacted),
      message,
    );
  }

  /** The server's own stderr usually says why it stopped, a missing token say. */
  #failure(reason) {
    const said = this.#stderr.trim().split("\n").slice(-3).join(" ").trim();
    return this.#redact(said ? `${reason}: ${said}` : reason);
  }
}

const readServers = (storage, key) => {
  try {
    const stored = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const names = new Set();
    const valid = stored
      .filter((server) => {
        if (!isServer(server) || names.has(server.name)) return false;
        names.add(server.name);
        return true;
      })
      .slice(0, MAX_SERVERS);
    return withServerIds(valid);
  } catch {
    return [];
  }
};

async function settleWithConcurrency(items, run) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONNECT_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The MCP runtime for one page. Options:
 *   hostUrl        where sdk/mcp-host.html is served on this origin
 *   redirectUrl    where sdk/mcp-callback.html is served, for OAuth
 *   gate           (server, tool) => {run:true} | {run:false, reason} before every call
 *   onServersChange runs when /mcp add, remove or a sign-in changes the list
 *   storage        Web Storage for configs and OAuth; default is memory for this runtime
 *   storagePrefix  storage namespace, default "fx"
 *   clientName     what a remote server sees this client called
 *   maxTools       how many tools fx will take, from 1 to 127
 */
export function createBrowserMcp(options = {}) {
  const {
    hostUrl,
    redirectUrl,
    gate = async () => ({ run: true }),
    onServersChange = () => {},
    storage = memoryStorage(),
    storagePrefix = "fx",
    clientName = "fx",
    maxTools = DEFAULT_MAX_TOOLS,
  } = options;
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > DEFAULT_MAX_TOOLS) {
    throw new RangeError(`maxTools must be an integer from 1 to ${DEFAULT_MAX_TOOLS}`);
  }
  const serversKey = `${storagePrefix}.mcp-servers`;
  const frame = hostFrame(hostUrl);
  const connections = new Map();
  const statuses = new Map();
  // A sign-in finishes in its own window, after the command has returned.
  const signInFailures = new Map();
  // The sign-in each server waits on, so one cancelled by removing or signing
  // out of the server cannot save its tokens when it finally lands.
  const signInAttempts = new Map();
  let servers = readServers(storage, serversKey);
  let serversGeneration = 0;

  const provider = (server) =>
    new BrowserOAuthProvider({ serverUrl: server.url, storage, storagePrefix, redirectUrl, clientName });

  async function open(server, connected) {
    const connect = (transport) =>
      withTimeout(
        connected.connect(transport),
        `${server.name} did not start within 90 seconds.`,
        () => void connected.close().catch(() => {}),
      );
    if (server.kind === "npm") {
      if (!hostUrl) throw new Error("hostUrl is required for browser-hosted npm MCP servers");
      await connect(new NpmServerTransport(frame, server));
      return connected;
    }
    // A server given a static Authorization header does not need the OAuth flow.
    const transportOptions = {
      authProvider: hasAuthorizationHeader(server) ? undefined : provider(server),
      requestInit: { headers: server.headers },
    };
    const url = new URL(server.url);
    const transport =
      server.transport === "sse"
        ? new SSEClientTransport(url, transportOptions)
        : new StreamableHTTPClientTransport(url, transportOptions);
    try {
      await connect(transport);
    } catch (error) {
      if (error instanceof UnauthorizedError) throw new McpSignInRequired(server.name);
      throw error;
    }
    return connected;
  }

  function client(server) {
    const key = connectionKey(server);
    let entry = connections.get(key);
    if (!entry) {
      const connected = new Client({ name: clientName, version: "1.0.0" });
      const opening = open(server, connected);
      entry = { opening, close: () => connected.close() };
      const forget = (notify) => {
        if (connections.get(key) !== entry) return;
        connections.delete(key);
        statuses.delete(key);
        if (notify) onServersChange(servers.map(cloneServer));
      };
      connections.set(key, entry);
      opening.then((ready) => {
        ready.onclose = () => forget(true);
      }, () => forget(false));
    }
    return entry.opening;
  }

  function reset(server) {
    const key = connectionKey(server);
    const entry = connections.get(key);
    connections.delete(key);
    statuses.delete(key);
    void entry?.close().catch(() => {});
  }

  function setServers(next) {
    if (!Array.isArray(next) || next.length > MAX_SERVERS || next.some((server) => !isServer(server))) {
      throw new TypeError(`MCP servers must be an array of at most ${MAX_SERVERS} valid server configs`);
    }
    if (new Set(next.map((server) => server.name)).size !== next.length) {
      throw new TypeError("MCP server names must be unique");
    }
    for (const existing of servers) {
      if (existing.kind !== "remote") continue;
      const keepsAuthentication = next.some(
        (candidate) =>
          candidate.kind === "remote" &&
          candidate.url === existing.url &&
          hasAuthorizationHeader(candidate) === hasAuthorizationHeader(existing),
      );
      if (!keepsAuthentication) forgetCredentials(existing);
    }
    servers = withServerIds(next);
    serversGeneration += 1;
    try {
      storage.setItem(serversKey, JSON.stringify(servers));
    } catch {}
    const closing = [...connections.values()];
    connections.clear();
    statuses.clear();
    for (const entry of closing) void entry.close().catch(() => {});
    const keptNames = new Set(servers.map((server) => server.name));
    for (const name of signInFailures.keys()) {
      if (!keptNames.has(name)) signInFailures.delete(name);
    }
    onServersChange(servers.map(cloneServer));
  }

  const status = (server) => statuses.get(connectionKey(server)) ?? { state: "starting" };

  async function listTools(server) {
    if (!isServer(server)) throw new TypeError("MCP server config is invalid");
    const connected = await client(server);
    const tools = [];
    const names = new Set();
    const cursors = new Set();
    let cursor;
    for (let pageNumber = 0; ; pageNumber += 1) {
      if (pageNumber >= MAX_TOOL_PAGES) throw new Error(`${server.name} returned too many tools/list pages.`);
      const page = await requestTools(connected, cursor ? { cursor } : undefined, server.name);
      if (!page || typeof page !== "object" || !Array.isArray(page.tools)) {
        throw new TypeError(`${server.name} returned an invalid tools/list response.`);
      }
      if (tools.length + page.tools.length > maxTools) {
        throw new RangeError(`${server.name} returned more than ${maxTools} tools.`);
      }
      page.tools.forEach((tool, index) => {
        if (
          !tool ||
          typeof tool !== "object" ||
          typeof tool.name !== "string" ||
          tool.name.length === 0 ||
          tool.name.length > 256 ||
          (tool.title !== undefined && typeof tool.title !== "string") ||
          (tool.description !== undefined && typeof tool.description !== "string")
        ) {
          throw new TypeError(`${server.name} returned an invalid tool at index ${tools.length + index}.`);
        }
        if (names.has(tool.name)) throw new TypeError(`${server.name} returned the tool ${tool.name} more than once.`);
        names.add(tool.name);
      });
      tools.push(...page.tools.map(({ name, title, description }) => ({ name, title, description })));
      cursor = page.nextCursor;
      if (cursor === undefined || cursor === null) break;
      if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || cursors.has(cursor)) {
        throw new TypeError(`${server.name} returned an invalid tools/list cursor.`);
      }
      cursors.add(cursor);
    }
    return tools;
  }

  /** Every server's tools, named `mcp__<server>__<tool>` as coding agents name them. */
  async function connect() {
    const currentServers = servers.map(cloneServer);
    const generation = serversGeneration;
    const updateStatus = (key, value) => {
      if (generation === serversGeneration) statuses.set(key, value);
    };
    for (const server of currentServers) {
      if (status(server).state !== "ready") updateStatus(connectionKey(server), { state: "starting" });
    }
    const results = await settleWithConcurrency(currentServers, async (server) => {
      const connected = await client(server);
      const gated = {
        listTools: (params) => requestTools(connected, params, server.name),
        async callTool(params, schema, callOptions) {
          const signal = callOptions?.signal;
          if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
          const verdict = await gate(server.name, params.name, signal);
          if (signal?.aborted) throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
          if (!verdict || typeof verdict !== "object" || typeof verdict.run !== "boolean") {
            throw new TypeError("The MCP gate must return { run: boolean }.");
          }
          // fx prints a failed tool call on one line, so the message keeps to one.
          if (!verdict.run) {
            const reason = typeof verdict.reason === "string" ? verdict.reason : "Blocked by the host policy.";
            return { isError: true, content: [{ type: "text", text: reason.replace(/\s*\n\s*/g, " ") }] };
          }
          return connected.callTool(params, schema, callOptions);
        },
      };
      return createMcpAdapter(gated, { prefix: `mcp__${server.name}__`, server: server.name });
    });
    if (generation !== serversGeneration) {
      throw new Error("MCP servers changed while they were connecting.");
    }

    const tools = [];
    const toolNames = new Set();
    const failures = [];
    results.forEach((result, index) => {
      const server = currentServers[index];
      const key = connectionKey(server);
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        updateStatus(key, result.reason instanceof McpSignInRequired ? { state: "sign-in" } : { state: "failed", message });
        failures.push({ server: server.name, message });
        return;
      }
      const serverTools = result.value.tools;
      if (tools.length + serverTools.length > maxTools) {
        const message = `its ${serverTools.length} tools would pass the limit of ${maxTools} MCP tools. Remove a server to use it.`;
        updateStatus(key, { state: "failed", message });
        failures.push({ server: server.name, message });
        return;
      }
      if (serverTools.some((tool) => toolNames.has(tool.name))) {
        const message = "one or more tool names collide with another MCP server after normalization.";
        updateStatus(key, { state: "failed", message });
        failures.push({ server: server.name, message });
        return;
      }
      tools.push(...serverTools);
      for (const tool of serverTools) toolNames.add(tool.name);
      const prefix = `mcp__${server.name}__`;
      updateStatus(key, { state: "ready", tools: serverTools.map((tool) => tool.name.slice(prefix.length)) });
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
    const previous = servers.find((existing) => existing.name === server.name);
    const replaced = Boolean(previous);
    if (!replaced && servers.length >= MAX_SERVERS) return `This host supports at most ${MAX_SERVERS} MCP servers.`;
    setServers([...servers.filter((existing) => existing.name !== server.name), { ...server, id: crypto.randomUUID() }]);
    const next =
      server.kind === "npm"
        ? "It runs in an isolated browser worker, but receives its configured environment and can access the network. Use a pinned package you trust."
        : "The browser sends its configured headers directly to this server. Connecting to it.";
    return `${replaced ? "Replaced" : "Added"} ${server.name}: ${describeServer(server)}\n${next} Run /mcp to see its tools.`;
  }

  /** Drops the server's tokens, and any sign-in still running for it. */
  function forgetCredentials(server) {
    const attempt = signInAttempts.get(server.url);
    if (attempt) attempt.cancelled = true;
    signOut(storagePrefix, server.url, storage);
  }

  function removeServer(server) {
    setServers(servers.filter((existing) => existing !== server));
    return `Removed ${server.name}.`;
  }

  function authenticate(server) {
    if (hasAuthorizationHeader(server)) {
      return `${server.name} uses a configured Authorization header. Remove that header from the server config to use OAuth sign-in.`;
    }
    if (!redirectUrl) return "This host has no redirectUrl for MCP sign-in.";
    if (signInAttempts.has(server.url)) return `A sign-in for ${server.name} is already in progress.`;
    // The window opens now, while the keypress still lets a page open one.
    const popup = openSignInWindow();
    if (!popup) return "The browser blocked the sign-in window. Allow popups for this page, then run the command again.";
    signInFailures.delete(server.name);
    const attempt = { cancelled: false };
    signInAttempts.set(server.url, attempt);
    signIn({ serverUrl: server.url, popup, provider: provider(server) }).then(
      () => {
        if (signInAttempts.get(server.url) !== attempt) return;
        signInAttempts.delete(server.url);
        // A sign-in that lands after remove or logout must not leave tokens
        // behind for a server the user let go of.
        if (attempt.cancelled) {
          signOut(storagePrefix, server.url, storage);
          return;
        }
        reset(server);
        onServersChange(servers.map(cloneServer));
      },
      (error) => {
        if (signInAttempts.get(server.url) !== attempt) return;
        signInAttempts.delete(server.url);
        if (!attempt.cancelled) {
          signInFailures.set(server.name, error instanceof Error ? error.message : String(error));
        }
      },
    );
    return `Opened ${server.name}'s sign-in page in a new window. Finish there, then run /mcp.`;
  }

  function signOutOf(server) {
    if (hasAuthorizationHeader(server)) {
      return `${server.name} uses a configured Authorization header. Remove that header from the server config to sign out.`;
    }
    forgetCredentials(server);
    reset(server);
    onServersChange(servers.map(cloneServer));
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
    servers: () => servers.map(cloneServer),
    setServers,
    command,
    connect,
    listTools,
    status,
    connectionKey,
    reset,
  };
}
