import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { isToolName, type ToolName } from "./tool-name.js";

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export interface SkillMeta {
  name: string;
  description: string;
  /** Parsed `allowed-tools` frontmatter, when present and well-formed. */
  allowedTools?: ToolName[];
  [key: string]: unknown;
}

export interface LoadSkillMdOptions {
  /** Called for parser warnings (unknown allowed-tools tokens, etc.) */
  onWarning?: (message: string) => void;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse a SKILL.md file and extract YAML frontmatter.
 * Returns the parsed metadata (name, description, plus any extra fields).
 */
export async function loadSkillMd(
  filePath: string,
  opts?: LoadSkillMdOptions,
): Promise<SkillMeta> {
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

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillLoadError(`Invalid YAML frontmatter in ${filePath}: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new SkillLoadError(`Frontmatter must be a YAML object: ${filePath}`);
  }

  const meta = parsed as Record<string, unknown>;

  if (typeof meta["name"] !== "string" || !meta["name"]) {
    throw new SkillLoadError(`Missing 'name' in SKILL.md frontmatter: ${filePath}`);
  }
  if (typeof meta["description"] !== "string" || !meta["description"]) {
    throw new SkillLoadError(`Missing 'description' in SKILL.md frontmatter: ${filePath}`);
  }

  const allowedTools = parseAllowedTools(meta["allowed-tools"], opts?.onWarning);
  if (allowedTools !== undefined) {
    meta["allowedTools"] = allowedTools;
  }

  return meta as SkillMeta;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the `allowed-tools` frontmatter field into `ToolName[]`. The agentskills.io
 * spec defines this as a space-delimited string. Unknown tokens are reported via
 * `onWarning` and dropped — graceful degradation matches host behavior and avoids
 * forcing lib bumps for every new tool name added upstream.
 *
 * Returns `undefined` when the field is absent or has an unrecognized shape.
 */
function parseAllowedTools(
  raw: unknown,
  onWarning?: (message: string) => void,
): ToolName[] | undefined {
  if (raw === undefined || raw === null) {return undefined;}
  if (typeof raw !== "string") {
    onWarning?.(`allowed-tools must be a string, got ${typeof raw}; ignoring`);
    return undefined;
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {return undefined;}

  const accepted: ToolName[] = [];
  for (const token of tokens) {
    if (isToolName(token)) {
      accepted.push(token);
    } else {
      onWarning?.(`allowed-tools: unknown tool '${token}' (ignored)`);
    }
  }
  return accepted.length > 0 ? accepted : undefined;
}
