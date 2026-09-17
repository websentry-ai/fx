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
assert.throws(() => createBrowserSkillTools([{ content }, { content }]), /duplicate skill name/);
assert.deepEqual(createBrowserSkillTools([]), []);

console.error("browser skills passed");
