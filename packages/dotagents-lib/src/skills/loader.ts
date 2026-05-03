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
 * Parse the `allowed-tools` frontmatter field into `ToolName[]`.
 *
 * The agentskills.io spec defines this as a space-delimited string, but with
 * a real YAML parser, frontmatter authors can also use YAML's native list
 * syntax (`- Read\n  - Grep` or `[Read, Grep]`) which parses to a JS array.
 * Both shapes are accepted.
 *
 * Unknown tokens are reported via `onWarning` and dropped. When the field is
 * present but every token is unrecognized, returns an empty array (rather
 * than `undefined`) so authorization gates can distinguish "field declared
 * but values not understood" from "no restriction declared at all" — the
 * latter is treated as unrestricted by most hosts.
 *
 * Returns `undefined` only when the field is genuinely absent or shaped in
 * a way the lib can't interpret (e.g. an object).
 */
function parseAllowedTools(
  raw: unknown,
  onWarning?: (message: string) => void,
): ToolName[] | undefined {
  if (raw === undefined || raw === null) {return undefined;}

  let tokens: string[];
  if (typeof raw === "string") {
    tokens = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    tokens = [];
    for (const entry of raw) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        tokens.push(entry.trim());
      } else {
        onWarning?.(`allowed-tools: skipping non-string entry ${JSON.stringify(entry)}`);
      }
    }
  } else {
    onWarning?.(`allowed-tools must be a string or array, got ${typeof raw}; ignoring`);
    return undefined;
  }

  if (tokens.length === 0) {return undefined;}

  const accepted: ToolName[] = [];
  for (const token of tokens) {
    if (isToolName(token)) {
      accepted.push(token);
    } else {
      onWarning?.(`allowed-tools: unknown tool '${token}' (ignored)`);
    }
  }
  // Keep the empty-array signal: declared-but-no-recognized-tokens is
  // semantically distinct from field-absent (the latter returns undefined).
  return accepted;
}
