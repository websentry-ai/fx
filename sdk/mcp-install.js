// Reads the arguments of `/mcp add`, as typed into fx: `/mcp add <name> <command> [args…]` or `/mcp add --transport http <name>
// <url>`. It also takes `claude mcp add`'s options (`-e`, `--header`, `--`,
// `--transport sse`) and `/mcp add-json`, so a README's command pastes as is.
// The harness runs npm servers in the browser and connects to remote ones over
// HTTP; anything else has to say so.

/**
 * @typedef {{name: string, kind: "npm", pkg: string, version: string, args: string[], env: Record<string,string>}
 *   | {name: string, kind: "remote", transport: "http"|"sse", url: string, headers: Record<string,string>}} McpServerConfig
 */

const NOT_IN_BROWSER = {
  uvx: "a Python package",
  uv: "a Python package",
  python: "Python",
  python3: "Python",
  pipx: "a Python package",
  docker: "a Docker container",
  podman: "a container",
  node: "a file on your machine",
  deno: "Deno",
  bun: "Bun",
  bunx: "Bun",
  go: "a Go program",
  java: "Java",
};

/** Splits a command line into words, as a POSIX shell would quote them. */
export function shellWords(line) {
  const words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) word += line[++i];
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < line.length) {
      // A backslash-newline continues the line.
      if (line[i + 1] !== "\n") {
        word += line[i + 1];
        inWord = true;
      }
      i++;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) throw new Error("The command has an unclosed quote.");
  if (inWord) words.push(word);
  return words;
}

/** fx's rule for a server name, which becomes its tools' prefix and what MCP policies target. */
function checkName(name) {
  if (typeof name !== "string" || name.length > 64 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`\`${name}\` is not a server name. Use letters, digits, hyphens and underscores.`);
  }
  return name;
}

function remote(name, url, transport, headers) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("A remote server must have a valid https:// URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("A remote server must use an https:// URL.");
  if (parsed.username || parsed.password) throw new Error("Put credentials in a header, not in the server URL.");
  if (!["http", "sse"].includes(transport)) throw new Error("A remote server transport must be `http` or `sse`.");
  if (Object.keys(headers).length > 64) throw new Error("The remote server has too many headers.");
  try {
    new Headers(headers);
  } catch {
    throw new Error("The remote server has an invalid header.");
  }
  return { name: checkName(name), kind: "remote", transport, url, headers };
}

/** `npx -y <package>[@version] [args…]`, with `env KEY=value …` in front allowed. */
function npmServer(name, command, args, env) {
  const rest = [...args];
  let program = command.split("/").pop() ?? command;
  if (program === "env") {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) {
      const [key, value] = keyValue(rest.shift(), "=", "KEY=value pair");
      env[key] = value;
    }
    program = rest.shift() ?? "";
  }
  if (program !== "npx") {
    const what = NOT_IN_BROWSER[program] ?? `\`${program}\``;
    throw new Error(`This server runs ${what}, which a browser cannot run. Use the server's remote URL if it has one.`);
  }
  if (
    Object.keys(env).length > 64 ||
    Object.keys(env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  ) {
    throw new Error("The npm server environment is invalid.");
  }
  while (rest[0]?.startsWith("-")) {
    const flag = rest.shift();
    if (flag === "-p" || flag.startsWith("--package")) {
      throw new Error("`npx --package` is not supported. Give the package as npx's first argument.");
    }
  }
  const spec = rest.shift();
  if (!spec) throw new Error("The npx command names no package.");
  const at = spec.indexOf("@", 1);
  const pkg = at === -1 ? spec : spec.slice(0, at);
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg)) {
    throw new Error(`\`${pkg}\` is not an npm package name.`);
  }
  const version = (at === -1 ? "" : spec.slice(at + 1)) || "latest";
  if (version.length > 256 || /[\0-\x1f\x7f]/.test(version)) throw new Error("The npm package version is invalid.");
  if (rest.length > 128) throw new Error("The npm server has too many arguments.");
  return {
    name: checkName(name),
    kind: "npm",
    pkg,
    version,
    args: rest,
    env,
  };
}

function keyValue(entry, separator, what) {
  const at = entry.indexOf(separator);
  if (at <= 0) throw new Error(`\`${entry}\` is not a ${what}.`);
  return [entry.slice(0, at).trim(), entry.slice(at + separator.length).trim()];
}

function stringRecord(value, what) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be a JSON object.`);
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`${what} has too many entries.`);
  return Object.fromEntries(
    entries.map(([key, entry]) => {
      if (!key || !["string", "number", "boolean"].includes(typeof entry)) {
        throw new Error(`${what} must contain simple values.`);
      }
      return [key, String(entry)];
    }),
  );
}

/** One server's JSON, in the shape Claude Code, Cursor and VS Code share. */
function fromJson(name, text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`The JSON does not parse: ${error.message}`);
  }
  if (!config || typeof config !== "object") throw new Error("The config must be a JSON object.");
  if (typeof config.url === "string") {
    return remote(name, config.url, config.type === "sse" ? "sse" : "http", stringRecord(config.headers, "headers"));
  }
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.map(String) : [];
    return npmServer(name, config.command, args, stringRecord(config.env, "env"));
  }
  throw new Error("The config needs a `command` or a `url`.");
}

/**
 * The server `/mcp add …` or `/mcp add-json …` describes, from the words after
 * `/mcp`. Throws with a message for the terminal.
 * @returns {McpServerConfig}
 */
export function parseMcpAdd(words) {
  const [sub, ...rest] = words;
  if (sub === "add-json") {
    const [name, json] = rest.filter((word) => !word.startsWith("-"));
    if (!name || !json) throw new Error("Usage: /mcp add-json <name> '<json>'");
    return fromJson(name, json);
  }
  const dashes = rest.indexOf("--");
  const head = dashes === -1 ? rest : rest.slice(0, dashes);
  const command = dashes === -1 ? [] : rest.slice(dashes + 1);
  let transport = "stdio";
  const env = {};
  const headers = {};
  const positional = [];
  for (let i = 0; i < head.length; i++) {
    // After `<name> <command>`, the words are the command's own, as fx reads them.
    if (positional.length === 2 && !/^https?:\/\//.test(positional[1])) {
      positional.push(...head.slice(i));
      break;
    }
    const equals = head[i].startsWith("--") ? head[i].indexOf("=") : -1;
    const [flag, inline] = equals > 0 ? [head[i].slice(0, equals), head[i].slice(equals + 1)] : [head[i], undefined];
    const value = () => inline ?? head[++i] ?? "";
    if (flag === "-t" || flag === "--transport") transport = value();
    else if (flag === "-e" || flag === "--env") {
      const [key, val] = keyValue(value(), "=", "KEY=value pair");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`\`${key}\` is not an environment variable name.`);
      env[key] = val;
    } else if (flag === "-H" || flag === "--header") {
      const [key, val] = keyValue(value(), ":", "`Name: value` header");
      headers[key] = val;
    } else if (flag === "-s" || flag === "--scope") value();
    else if (flag.startsWith("-")) throw new Error(`\`${flag}\` is not an option of /mcp add.`);
    else positional.push(head[i]);
  }
  const [name, target, ...extra] = positional;
  if (!name || (!target && command.length === 0)) {
    throw new Error("Usage: /mcp add <name> <command> [args…] or /mcp add --transport http <name> <url>");
  }
  if (command.length > 0) return npmServer(name, command[0], command.slice(1), env);
  if (/^https?:\/\//.test(target)) return remote(name, target, transport === "sse" ? "sse" : "http", headers);
  return npmServer(name, target, extra, env);
}
