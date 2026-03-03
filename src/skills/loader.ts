import { readFile } from "node:fs/promises";

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export interface SkillMeta {
  name: string;
  description: string;
  [key: string]: unknown;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse a SKILL.md file and extract YAML frontmatter.
 * Returns the parsed metadata (name, description, plus any extra fields).
 */
export async function loadSkillMd(filePath: string): Promise<SkillMeta> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    throw new SkillLoadError(`SKILL.md not found: ${filePath}`);
  }

  const match = FRONTMATTER_RE.exec(content);
  if (!match?.[1]) {
    throw new SkillLoadError(`No YAML frontmatter in ${filePath}`);
  }

  const meta = parseSimpleYaml(match[1]);

  if (typeof meta["name"] !== "string" || !meta["name"]) {
    throw new SkillLoadError(`Missing 'name' in SKILL.md frontmatter: ${filePath}`);
  }
  if (typeof meta["description"] !== "string" || !meta["description"]) {
    throw new SkillLoadError(`Missing 'description' in SKILL.md frontmatter: ${filePath}`);
  }

  return meta as SkillMeta;
}

/**
 * Minimal YAML parser for flat key: value frontmatter.
 * We avoid a full YAML dependency — SKILL.md frontmatter is simple key-value pairs.
 */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {continue;}
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {continue;}
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
