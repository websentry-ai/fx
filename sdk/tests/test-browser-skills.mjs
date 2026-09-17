#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createBrowserSkillTools, parseSkillFile } from "../skills.js";

const content = `---
name: deploy-check
description: Check a deployment before release.
---

Inspect the release and report blockers.`;

assert.deepEqual(parseSkillFile(content), {
  ok: true,
  name: "deploy-check",
  description: "Check a deployment before release.",
  instructions: "Inspect the release and report blockers.",
});
assert.equal(parseSkillFile("not a skill").ok, false);

const loaded = [];
const tools = createBrowserSkillTools([{ content }], { onLoad: (name) => loaded.push(name) });
assert.equal(tools.length, 1);
assert.equal(tools[0].name, "skill");
assert.deepEqual(tools[0].inputSchema.properties.name.enum, ["deploy-check"]);
assert.equal(await tools[0].execute({ name: "deploy-check" }), "Inspect the release and report blockers.");
assert.deepEqual(loaded, ["deploy-check"]);

const aliasedLoads = [];
const aliasedTools = createBrowserSkillTools(
  [{ content, toolName: "unbound-deploy-check" }],
  { onLoad: (name) => aliasedLoads.push(name) },
);
assert.deepEqual(aliasedTools[0].inputSchema.properties.name.enum, ["unbound-deploy-check"]);
assert.equal(
  await aliasedTools[0].execute({ name: "unbound-deploy-check" }),
  "Inspect the release and report blockers.",
);
assert.deepEqual(aliasedLoads, ["unbound-deploy-check"]);

const longestSkillName = "a".repeat(64);
const longestSkill = content.replace("deploy-check", longestSkillName);
const prefixedLongestName = `unbound-${longestSkillName}`;
const prefixedLongestTools = createBrowserSkillTools([
  { content: longestSkill, toolName: prefixedLongestName },
]);
assert.deepEqual(prefixedLongestTools[0].inputSchema.properties.name.enum, [prefixedLongestName]);
assert.throws(
  () => createBrowserSkillTools([{ content, toolName: "Not Valid" }]),
  /toolName must use lowercase letters/,
);
assert.throws(
  () => createBrowserSkillTools([{ content, toolName: "a".repeat(129) }]),
  /up to 128 characters/,
);
assert.throws(() => createBrowserSkillTools([{ content }, { content }]), /duplicate skill name/);
assert.deepEqual(createBrowserSkillTools([]), []);

console.error("browser skills passed");
