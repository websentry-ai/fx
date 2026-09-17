#!/usr/bin/env node
// Unbound fork: the arguments of `/mcp add`, as a browser host reads them.
import { strict as assert } from "node:assert";
import { parseMcpAdd, shellWords } from "../mcp-install.js";

const add = (args) => parseMcpAdd(shellWords(args));
const failure = (args) => {
  try {
    add(args);
  } catch (error) {
    return error.message;
  }
  throw new Error(`expected /mcp ${args} to be rejected`);
};

assert.deepEqual(add("add memory npx -y @modelcontextprotocol/server-memory"), {
  name: "memory",
  kind: "npm",
  pkg: "@modelcontextprotocol/server-memory",
  version: "latest",
  args: [],
  env: {},
});

// The version and the server's own arguments survive; npx's flags do not.
assert.deepEqual(
  add("add fs npx -y @modelcontextprotocol/server-filesystem@2025.8.21 /tmp '/my docs' --verbose"),
  {
    name: "fs",
    kind: "npm",
    pkg: "@modelcontextprotocol/server-filesystem",
    version: "2025.8.21",
    args: ["/tmp", "/my docs", "--verbose"],
    env: {},
  },
);

assert.deepEqual(add("add --transport http linear https://mcp.linear.app/mcp"), {
  name: "linear",
  kind: "remote",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: {},
});

// `claude mcp add` options, so a README's command pastes as it is.
assert.deepEqual(
  add('add -t sse -s user asana https://mcp.asana.com/sse -H "Authorization: Bearer t0k"'),
  { name: "asana", kind: "remote", transport: "sse", url: "https://mcp.asana.com/sse", headers: { Authorization: "Bearer t0k" } },
);
assert.deepEqual(
  add("add github -e TOKEN=ghp_x --env=LOG=1 -- npx -y @modelcontextprotocol/server-github").env,
  { TOKEN: "ghp_x", LOG: "1" },
);
assert.deepEqual(add("add github env TOKEN=abc npx -y github-mcp").env, { TOKEN: "abc" });
assert.equal(add(`add-json weather '{"type":"http","url":"https://weather.example.com/mcp"}'`).url, "https://weather.example.com/mcp");

// What a browser cannot run says so, rather than failing later.
assert.match(failure("add git uvx mcp-server-git"), /Python/);
assert.match(failure("add pg -- docker run -i mcp/postgres"), /Docker/);
assert.match(failure(`add-json local '{"command":"node","args":["server.js"]}'`), /a file on your machine/);

assert.match(failure("add"), /Usage/);
assert.match(failure("add memory"), /Usage/);
assert.match(failure("add bad/name npx -y x"), /not a server name/);
assert.match(failure("add --transport http plain http://insecure.example.com/mcp"), /https:\/\//);
assert.match(failure("add-json broken '{\"url\": '"), /JSON/);

assert.deepEqual(shellWords('add \\\n  -e \'A=b c\' "x\\"y"'), ["add", "-e", "A=b c", 'x"y']);
assert.throws(() => shellWords("add x 'unclosed"), /quote/);

console.error("mcp install parsing passed");
