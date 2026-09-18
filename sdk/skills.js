const maxSkills = 64;
const maxInstructionsBytes = 64 * 1024;
const maxToolNameChars = 64;
const maxToolDescriptionBytes = 64 * 1024;
export const MAX_SKILL_FILE_BYTES = 50_000;
const frontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;
const skillNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const encoder = new TextEncoder();

function escapeAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function createSkillsAdapter(records) {
  if (!Array.isArray(records) || records.length > maxSkills) {
    throw new TypeError("skills must be an array with at most 64 records");
  }
  const names = new Set();
  const sections = [];
  const tools = [];
  for (const [index, record] of records.entries()) {
    if (!record || typeof record.name !== "string" || typeof record.instructions !== "string") {
      throw new TypeError(`skill ${index} requires name and instructions`);
    }
    if (names.has(record.name)) throw new TypeError(`duplicate skill name: ${record.name}`);
    names.add(record.name);
    const resources = (record.resources ?? []).map((resource) => {
      if (typeof resource?.uri !== "string" || typeof resource?.text !== "string") {
        throw new TypeError(`skill ${record.name} has an invalid resource`);
      }
      return `<resource uri="${escapeAttribute(resource.uri)}">\n${resource.text}\n</resource>`;
    }).join("\n");
    sections.push([
      `<skill name="${escapeAttribute(record.name)}">`,
      record.description ? `<description>${record.description}</description>` : "",
      record.instructions,
      resources,
      "</skill>",
    ].filter(Boolean).join("\n"));
    if (record.tools !== undefined) {
      if (!Array.isArray(record.tools)) throw new TypeError(`skill ${record.name} tools must be an array`);
      tools.push(...record.tools);
    }
  }
  const instructions = sections.join("\n\n");
  if (encoder.encode(instructions).length > maxInstructionsBytes) {
    throw new RangeError(`skill instructions exceed the ${maxInstructionsBytes} byte libfx limit`);
  }
  return { instructions, tools };
}

/** Parse the SKILL.md subset supported by browser hosts. */
export function parseSkillFile(content) {
  if (typeof content !== "string") {
    return { ok: false, message: "The skill must be a text file." };
  }
  if (encoder.encode(content).length > MAX_SKILL_FILE_BYTES) {
    return { ok: false, message: `The scanner reads ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes at most.` };
  }
  const matched = frontmatterPattern.exec(content.trim());
  if (!matched) {
    return { ok: false, message: "Start with a --- frontmatter block, and close it with ---." };
  }
  const [, frontmatter, instructions = ""] = matched;
  const fields = new Map();
  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }

  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!name) return { ok: false, message: "The frontmatter needs a name." };
  if (!skillNamePattern.test(name) || name.length > maxToolNameChars) {
    return { ok: false, message: `The name takes lowercase letters, digits and single hyphens, up to ${maxToolNameChars} characters.` };
  }
  if (!description) return { ok: false, message: "The frontmatter needs a description on one line." };
  if (description.length > 1024) return { ok: false, message: "Keep the description to 1024 characters." };
  if (!instructions.trim()) return { ok: false, message: "Write the instructions under the frontmatter." };
  return { ok: true, name, description, instructions: instructions.trim() };
}

/** Create one lazy browser-hosted skill loader from SKILL.md files. */
export function createBrowserSkillTools(records, options = {}) {
  if (!Array.isArray(records) || records.length > maxSkills) {
    throw new TypeError("skills must be an array with at most 64 records");
  }
  const skills = new Map();
  for (const [index, record] of records.entries()) {
    const parsed = parseSkillFile(record?.content);
    if (!parsed.ok) throw new TypeError(`skill ${index}: ${parsed.message}`);
    const toolName = record?.toolName ?? parsed.name;
    if (typeof toolName !== "string" || !skillNamePattern.test(toolName) || toolName.length > maxToolNameChars) {
      throw new TypeError(`skill ${index}: toolName must use lowercase letters, digits and single hyphens, up to ${maxToolNameChars} characters`);
    }
    if (skills.has(toolName)) throw new TypeError(`duplicate skill name: ${toolName}`);
    skills.set(toolName, { ...parsed, name: toolName });
  }
  if (skills.size === 0) return [];

  const catalog = [...skills.values()];
  const description = [
    "Load a skill's instructions before handling a task that matches it.",
    ...catalog.map((skill) => `${skill.name}: ${skill.description}`),
  ].join("\n");
  if (encoder.encode(description).length > maxToolDescriptionBytes) {
    throw new RangeError("skill catalog descriptions exceed the 64 KiB libfx limit");
  }
  return [{
    name: "skill",
    description,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: catalog.map((skill) => skill.name) } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input) {
      const skill = skills.get(input?.name);
      if (!skill) throw new Error(`unknown skill: ${String(input?.name)}`);
      await options.onLoad?.(skill.name);
      return skill.instructions;
    },
  }];
}
