import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { isToolName, type ToolName } from "./tool-name.js";
import { isSerializedObject, type SerializedObject } from "../utils/serialized.js";

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export interface SkillMeta extends SerializedObject {
  name: string;
  description: string;
  /** Parsed `allowed-tools` frontmatter, when present and well-formed. */
  allowedTools?: ToolName[];
}

export interface MarkdownFrontmatter {
  meta: SerializedObject;
  body: string;
  raw: string;
}

export interface LoadMarkdownFrontmatterOptions {
  fileDescription?: string;
}

export interface LoadSkillMdOptions {
  /** Called for parser warnings (unknown allowed-tools tokens, etc.) */
  onWarning?: (message: string) => void;
}

const FRONTMATTER_OPEN_RE = /^\uFEFF?---[ \t]*\r?\n/;
const FRONTMATTER_CLOSE_RE = /^---[ \t]*$/;

/**
 * Parse a SKILL.md file and extract YAML frontmatter.
 * Returns the parsed metadata (name, description, plus any extra fields).
 */
export async function loadSkillMd(
  filePath: string,
  opts?: LoadSkillMdOptions,
): Promise<SkillMeta> {
  const { meta } = await loadMarkdownFrontmatter(filePath, {
    fileDescription: "SKILL.md",
  });

  if (!isNonEmptyString(meta["name"])) {
    throw new SkillLoadError(`Missing 'name' in SKILL.md frontmatter: ${filePath}`);
  }
  if (!isNonEmptyString(meta["description"])) {
    throw new SkillLoadError(`Missing 'description' in SKILL.md frontmatter: ${filePath}`);
  }

  const allowedTools = parseAllowedTools(meta["allowed-tools"], opts?.onWarning);
  if (allowedTools !== undefined) {
    meta["allowedTools"] = allowedTools;
  }

  // SAFETY: name and description were validated above; the remaining fields
  // retain the SerializedObject contract established by the frontmatter parser.
  return meta as SkillMeta;
}

/**
 * Parse a Markdown file and extract YAML frontmatter plus body content.
 */
export async function loadMarkdownFrontmatter(
  filePath: string,
  opts?: LoadMarkdownFrontmatterOptions,
): Promise<MarkdownFrontmatter> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    throw new SkillLoadError(`${opts?.fileDescription ?? "Markdown file"} not found: ${filePath}`);
  }

  return parseMarkdownFrontmatterContent(content, filePath);
}

export function parseMarkdownFrontmatterContent(
  content: string,
  filePath: string,
): MarkdownFrontmatter {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    throw new SkillLoadError(`No YAML frontmatter in ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter.yaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillLoadError(`Invalid YAML frontmatter in ${filePath}: ${message}`);
  }

  if (!isSerializedObject(parsed)) {
    throw new SkillLoadError(`Frontmatter must be a serializable YAML object: ${filePath}`);
  }

  return {
    meta: parsed,
    body: content.slice(frontmatter.end).trim(),
    raw: content,
  };
}

function extractFrontmatter(content: string): { yaml: string; end: number } | null {
  const opener = FRONTMATTER_OPEN_RE.exec(content);
  if (!opener) {return null;}

  const yamlStart = opener[0].length;
  let lineStart = yamlStart;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf("\n", lineStart);
    const hasNewline = lineEnd !== -1;
    const line = content
      .slice(lineStart, hasNewline ? lineEnd : content.length)
      .replace(/\r$/, "");

    if (FRONTMATTER_CLOSE_RE.test(line)) {
      return {
        yaml: content.slice(yamlStart, lineStart).replace(/\r?\n$/, ""),
        end: hasNewline ? lineEnd : content.length,
      };
    }

    if (!hasNewline) {break;}
    lineStart = lineEnd + 1;
  }

  return null;
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
  raw: SerializedObject[string],
  onWarning?: (message: string) => void,
): ToolName[] | undefined {
  if (raw === undefined || raw === null) {return undefined;}

  // Track whether the field was declared as an array specifically. An empty
  // array is "deny all" (explicit signal); an empty/whitespace string is more
  // likely a typo and we treat it as absent.
  let tokens: string[];
  let isArrayForm = false;
  if (isString(raw)) {
    tokens = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    isArrayForm = true;
    tokens = [];
    for (const entry of raw) {
      if (isNonEmptyString(entry)) {
        tokens.push(entry.trim());
      } else {
        onWarning?.(`allowed-tools: skipping non-string entry ${JSON.stringify(entry)}`);
      }
    }
  } else {
    onWarning?.(`allowed-tools must be a string or array; ignoring ${JSON.stringify(raw)}`);
    return undefined;
  }

  // Empty/whitespace string: treat as absent (likely a typo).
  // Empty array: deliberate "deny all" — preserve the empty signal.
  if (tokens.length === 0) {
    return isArrayForm ? [] : undefined;
  }

  const accepted: ToolName[] = [];
  for (const token of tokens) {
    if (isToolName(token)) {
      accepted.push(token);
    } else {
      onWarning?.(`allowed-tools: unknown tool '${token}' (ignored)`);
    }
  }
  // Declared-but-no-recognized-tokens stays distinct from field-absent.
  return accepted;
}

function isString<Value>(value: Value): value is Value & string {
  return typeof value === "string";
}

function isNonEmptyString<Value>(value: Value): value is Value & string {
  return typeof value === "string" && value.length > 0;
}
