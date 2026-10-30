import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parse as parseTOML, stringify, type TomlTable } from "smol-toml";
import {
  agentsConfigSchema,
  isWildcardDep,
  type WildcardSkillDependency,
  type TrustConfig,
  type McpConfig,
  type PluginConfig,
} from "./schema.js";
import {
  isSerializedObject,
  sourcesMatch,
  type SerializedObject,
} from "@sentry/dotagents-lib";

export interface DefaultConfigOptions {
  agents?: string[];
  trust?: TrustConfig;
  skills?: Array<{ name: string; source: string; ref?: string; path?: string }>;
}

interface TomlDependencyEntry extends Record<string, string> {
  name: string;
  source: string;
}

/**
 * Add a skill entry to agents.toml.
 * Appends a [[skills]] block at the end of the file.
 * Uses smol-toml's stringify for proper TOML escaping.
 */
export async function addSkillToConfig(
  filePath: string,
  name: string,
  dep: { source: string; ref?: string; path?: string },
): Promise<void> {
  const content = await readFile(filePath, "utf-8");

  // Build a partial TOML object and stringify it for proper escaping
  const entry: TomlDependencyEntry = { name, source: dep.source };
  if (dep.ref) {entry["ref"] = dep.ref;}
  if (dep.path) {entry["path"] = dep.path;}

  const section = stringify({ skills: [entry] });

  const newContent = `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
  await writeFile(filePath, newContent, "utf-8");
}

/** Appends preflighted plugin declarations with a single config-file mutation. */
export async function addPluginsToConfig(
  filePath: string,
  plugins: Array<Pick<PluginConfig, "name" | "source" | "ref" | "path">>,
): Promise<void> {
  if (plugins.length === 0) {
    throw new Error("Cannot append an empty plugin batch.");
  }
  const content = await readFile(filePath, "utf-8");
  const entries = plugins.map((plugin) => {
    const entry: TomlDependencyEntry = {
      name: plugin.name,
      source: plugin.source,
    };
    if (plugin.ref) {entry["ref"] = plugin.ref;}
    if (plugin.path) {entry["path"] = plugin.path;}
    return entry;
  });
  const section = stringify({ plugins: entries });
  await writeFile(
    filePath,
    `${content.trimEnd()}\n\n${section.trimEnd()}\n`,
    "utf-8",
  );
}

/**
 * Remove a skill entry from agents.toml.
 * Removes the [[skills]] block whose name field matches.
 */
export async function removeSkillFromConfig(
  filePath: string,
  name: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  await writeFile(filePath, removeBlockByHeader(content, "[[skills]]", name), "utf-8");
}

/** Removes a plugin entry from agents.toml by name. */
export async function removePluginFromConfig(
  filePath: string,
  name: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  await writeFile(filePath, removeBlockByHeader(content, "[[plugins]]", name), "utf-8");
}

/**
 * Remove all [[skills]] blocks whose source matches the given source.
 * Handles both explicit and wildcard entries.
 */
export async function removeSkillBlocksBySource(
  filePath: string,
  source: string,
): Promise<void> {
  await removeBlocksBySource(filePath, "[[skills]]", source);
}

/** Removes all plugin blocks whose source matches the given source. */
export async function removePluginBlocksBySource(
  filePath: string,
  source: string,
): Promise<void> {
  await removeBlocksBySource(filePath, "[[plugins]]", source);
}

/** Removes array-of-table blocks for a header when their `source` matches. */
async function removeBlocksBySource(
  filePath: string,
  header: string,
  source: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const result = removeArrayTables(lines, header, (span) => {
    const value = getStringField(lines, span, "source");
    return value !== undefined && sourcesMatch(value, source);
  });
  await writeFile(filePath, result, "utf-8");
}

/**
 * Add a wildcard skill entry (name = "*") to agents.toml.
 */
export async function addWildcardToConfig(
  filePath: string,
  source: string,
  opts?: Pick<WildcardSkillDependency, "ref" | "exclude">,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");

  const entry: SerializedObject = { name: "*", source };
  if (opts?.ref) {entry["ref"] = opts.ref;}
  if (opts?.exclude && opts.exclude.length > 0) {entry["exclude"] = opts.exclude;}

  const section = stringify({ skills: [entry] });

  const newContent = `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
  await writeFile(filePath, newContent, "utf-8");
}

/**
 * Add a skill name to the exclude list of a wildcard entry matching the given source.
 * Preserves comments and supports inline and multiline exclude arrays.
 */
export async function addExcludeToWildcard(
  filePath: string,
  source: string,
  skillName: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const config = agentsConfigSchema.parse(parseTOML(content));
  const wildcard = config.skills.find(
    (dep): dep is WildcardSkillDependency => isWildcardDep(dep) && sourcesMatch(dep.source, source),
  );
  if (!wildcard) {
    throw new Error(`Wildcard source "${source}" not found in ${filePath}.`);
  }
  if (wildcard.exclude.includes(skillName)) {return;}

  const lines = content.split("\n");
  const span = findArrayTables(lines, "[[skills]]").find((candidate) => {
    const name = getStringField(lines, candidate, "name");
    const candidateSource = getStringField(lines, candidate, "source");
    return name === "*" && candidateSource !== undefined && sourcesMatch(candidateSource, source);
  });

  if (!span) {
    throw new Error(`Cannot locate wildcard source "${source}" in ${filePath}.`);
  }

  const excludeIdx = findFieldLine(lines, span, "exclude");
  if (excludeIdx === undefined) {
    lines.splice(span.end, 0, `exclude = ${tomlValue([skillName])}`);
  } else {
    // Validated skill names cannot contain # or ], so these delimit TOML syntax.
    let end = excludeIdx;
    while (end < span.fieldsEnd && !excludeArrayCode(lines[end]!).includes("]")) {end++;}
    if (end === span.fieldsEnd) {
      throw new Error(`Cannot locate exclude array in ${filePath}.`);
    }

    let closing = excludeArrayCode(lines[end]!).indexOf("]");
    let last = end;
    let lastCode = excludeArrayCode(lines[end]!.slice(0, closing));
    while (!lastCode && last > excludeIdx) {
      lastCode = excludeArrayCode(lines[--last]!);
    }
    if (wildcard.exclude.length > 0 && !lastCode.endsWith(",")) {
      lines[last] = `${lines[last]!.slice(0, lastCode.length)},${lines[last]!.slice(lastCode.length)}`;
      if (last === end) {closing++;}
    }

    if (lines[end]!.slice(0, closing).trim() === "") {
      const indent = lines[excludeIdx]!.match(/^\s*/)?.[0] ?? "";
      lines.splice(end, 0, `${indent}  ${tomlValue(skillName)},`);
    } else {
      const separator = wildcard.exclude.length > 0 ? " " : "";
      lines[end] = `${lines[end]!.slice(0, closing)}${separator}${tomlValue(skillName)}${lines[end]!.slice(closing)}`;
    }
  }

  const updated = lines.join("\n");
  const result = agentsConfigSchema.parse(parseTOML(updated));
  const excluded = result.skills.some(
    (dep) => isWildcardDep(dep) && sourcesMatch(dep.source, source) && dep.exclude.includes(skillName),
  );
  if (!excluded) {
    throw new Error(`Could not exclude skill "${skillName}" from wildcard source "${source}".`);
  }
  await writeFile(filePath, updated, "utf-8");
}

/**
 * Add an MCP server entry to agents.toml.
 * Appends a [[mcp]] block at the end of the file.
 */
export async function addMcpToConfig(
  filePath: string,
  entry: McpConfig,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");

  const obj: SerializedObject = { name: entry.name };
  if (entry.command) {
    obj["command"] = entry.command;
    if (entry.args && entry.args.length > 0) {obj["args"] = entry.args;}
  }
  if (entry.url) {
    obj["url"] = entry.url;
    if (entry.headers && Object.keys(entry.headers).length > 0) {obj["headers"] = entry.headers;}
  }
  if (entry.env.length > 0) {obj["env"] = entry.env;}

  const section = stringify({ mcp: [obj] });

  const newContent = `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
  await writeFile(filePath, newContent, "utf-8");
}

/**
 * Remove an MCP server entry from agents.toml.
 * Removes the [[mcp]] block whose name field matches.
 */
export async function removeMcpFromConfig(
  filePath: string,
  name: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  await writeFile(filePath, removeBlockByHeader(content, "[[mcp]]", name, "mcp"), "utf-8");
}

/** Extract a TOML string value from a line like `key = "value"` or `key = 'value'`. */
function extractTomlStringValue(line: string, key: string): string | undefined {
  const match = line.trim().match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`));
  return match?.[1] ?? match?.[2];
}

/** Half-open table range, with fields ending before the first nested table. */
interface ArrayTableSpan {
  start: number;
  fieldsEnd: number;
  end: number;
}

function classifyTableHeader(
  line: string,
  nestedTableName?: string,
): "nested" | "other" | undefined {
  if (!line.startsWith("[")) {return undefined;}

  try {
    const parsed = parseTOML(line);
    const root = nestedTableName ? parsed[nestedTableName] : undefined;
    const definesNestedTable = isSerializedObject(root) && Object.keys(root).length > 0;
    return definesNestedTable ? "nested" : "other";
  } catch {
    return undefined;
  }
}

function findArrayTables(
  lines: string[],
  header: string,
  nestedTableName?: string,
): ArrayTableSpan[] {
  const spans: ArrayTableSpan[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim() !== header) {
      i++;
      continue;
    }

    const start = i;
    let fieldsEnd: number | undefined;
    i++;
    while (i < lines.length) {
      const line = lines[i]!.trim();
      const tableHeader = classifyTableHeader(line, nestedTableName);
      if (tableHeader === "other") {break;}
      if (tableHeader === "nested") {fieldsEnd ??= i;}
      i++;
    }
    let end = i;
    while (end > start + 1 && lines[end - 1]!.trim() === "") {end--;}
    spans.push({ start, fieldsEnd: fieldsEnd ?? end, end });
  }
  return spans;
}

function findFieldLine(
  lines: string[],
  span: ArrayTableSpan,
  key: string,
): number | undefined {
  const assignment = new RegExp(`^${key}\\s*=`);
  for (let i = span.start + 1; i < span.fieldsEnd; i++) {
    const trimmed = lines[i]!.trim();
    if (assignment.test(trimmed)) {return i;}
  }
  return undefined;
}

function getStringField(
  lines: string[],
  span: ArrayTableSpan,
  key: string,
): string | undefined {
  const fieldLine = findFieldLine(lines, span, key);
  return fieldLine === undefined
    ? undefined
    : extractTomlStringValue(lines[fieldLine]!, key);
}

function removeArrayTables(
  lines: string[],
  header: string,
  shouldRemove: (span: ArrayTableSpan) => boolean,
  nestedTableName?: string,
): string {
  const spans = findArrayTables(lines, header, nestedTableName).filter(shouldRemove);
  for (const span of spans.toReversed()) {
    let start = span.start;
    while (start > 0 && lines[start - 1]!.trim() === "") {start--;}
    lines.splice(start, span.end - start);
  }
  return lines.join("\n");
}

function removeBlockByHeader(
  content: string,
  header: string,
  name: string,
  nestedTableName?: string,
): string {
  const lines = content.split("\n");
  return removeArrayTables(
    lines,
    header,
    (span) => getStringField(lines, span, "name") === name,
    nestedTableName,
  );
}

function tomlValue<Value>(value: Value): string {
  return stringify({ v: value }).replace("v = ", "").trimEnd();
}

function excludeArrayCode(line: string): string {
  return line.split("#", 1)[0]!.trimEnd();
}

type TrustField = "github_orgs" | "github_repos" | "git_domains";

/** Add a trust source, creating the section and field if absent. */
export async function addTrustSource(
  filePath: string,
  field: TrustField,
  value: string,
): Promise<void> {
  await editTrustSource(filePath, field, value, true);
}

/** Remove a trust source without disabling an empty allow-list. */
export async function removeTrustSource(
  filePath: string,
  field: TrustField,
  value: string,
): Promise<void> {
  await editTrustSource(filePath, field, value, false);
}

interface ConfigEdit {
  start: number;
  end: number;
  text: string;
}

async function editTrustSource(
  filePath: string,
  field: TrustField,
  value: string,
  add: boolean,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const parsed = parseTOML(content);
  const existing = agentsConfigSchema.parse(parsed).trust?.[field] ?? [];
  const values = add
    ? [...existing, value]
    : existing.filter((item) => item.toLowerCase() !== value.toLowerCase());
  const lines = content.split("\n");
  const header = lines.findIndex((line) => /^\[\s*(?:trust|"trust"|'trust')\s*\]\s*(?:#.*)?$/.test(line.trim()));
  const assignment = new RegExp(`^([ \\t]*(?:${field}|"${field}"|'${field}')[ \\t]*=[ \\t]*)\\[`);
  let fieldLine = -1;
  if (header >= 0) {
    for (let i = header + 1; i < lines.length; i++) {
      if (classifyTableHeader(lines[i]!.trim())) {break;}
      if (assignment.test(lines[i]!)) {
        fieldLine = i;
        break;
      }
    }
  }

  let updated: string;
  if (fieldLine >= 0) {
    const line = lines[fieldLine]!;
    const open = lines.slice(0, fieldLine).join("\n").length + 1 + line.indexOf("[");
    // Match complete TOML strings so their #, ], escapes, and newlines stay intact.
    const tokenPattern = /#[^\r\n]*|"""(?:[^"\\]|\\[\s\S]|"(?!""))*"{3,5}|'''(?:[^']|'(?!''))*'{3,5}|"(?:[^"\\\r\n]|\\[^\r\n])*"|'[^'\r\n]*'|,|\]/g;
    const tokens = [];
    let closing = -1;
    for (const match of content.slice(open + 1).matchAll(tokenPattern)) {
      if (match[0].startsWith("#")) {continue;}
      const start = open + 1 + match.index;
      if (match[0] === "]") {
        closing = start;
        break;
      }
      tokens.push({ start, end: start + match[0].length, text: match[0] });
    }
    if (closing < 0) {throw new Error(`Cannot locate ${field} array in ${filePath}.`);}

    const edits: ConfigEdit[] = [];
    if (add) {
      const lineStart = content.lastIndexOf("\n", closing - 1) + 1;
      const ownLine = content.slice(lineStart, closing).trim() === "";
      const indent = line.match(/^\s*/)?.[0] ?? "";
      const newline = content.includes("\r\n") ? "\r\n" : "\n";
      const position = ownLine ? lineStart : closing;
      edits.push({
        start: position,
        end: position,
        text: ownLine
          ? `${indent}  ${tomlValue(value)},${newline}`
          : `${existing.length > 0 ? " " : ""}${tomlValue(value)}`,
      });
      const last = tokens.at(-1);
      if (last && last.text !== ",") {
        edits.push({ start: last.end, end: last.end, text: "," });
      }
    } else {
      let itemIndex = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.text === ",") {continue;}
        const item = existing[itemIndex++];
        if (item?.toLowerCase() !== value.toLowerCase()) {continue;}
        edits.push({ start: token.start, end: token.end, text: "" });
        const comma = tokens[i + 1];
        if (comma?.text === ",") {
          edits.push({ start: comma.start, end: comma.end, text: "" });
        }
      }
    }
    updated = edits.toSorted((a, b) => b.start - a.start).reduce(
      (text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end),
      content,
    );
  } else if (add && header >= 0) {
    lines.splice(header + 1, 0, `${field} = ${tomlValue(values)}`);
    updated = lines.join("\n");
  } else if (add && parsed["trust"] === undefined) {
    const firstArrayTable = lines.findIndex((line) => line.trimStart().startsWith("[["));
    if (firstArrayTable >= 0) {
      lines.splice(firstArrayTable, 0, "[trust]", `${field} = ${tomlValue(values)}`, "");
      updated = lines.join("\n");
    } else {
      updated = `${content.trimEnd()}\n\n[trust]\n${field} = ${tomlValue(values)}\n`;
    }
  } else {
    throw new Error(`Cannot locate ${field} in [trust] of ${filePath}.`);
  }

  // Verify the entire parsed document: only the requested trust list may change.
  // SAFETY: the schema validates existing trust tables; the parser creates missing ones.
  const trust = (parsed["trust"] ??= parseTOML("[trust]")["trust"]!) as TomlTable;
  trust[field] = values;
  if (!isDeepStrictEqual(parseTOML(updated), parsed)) {
    throw new Error(`Could not ${add ? "add" : "remove"} "${value}" in ${field} of ${filePath}.`);
  }
  await writeFile(filePath, updated, "utf-8");
}

/**
 * Generate a minimal agents.toml scaffold.
 */
export function generateDefaultConfig(opts?: DefaultConfigOptions | string[]): string {
  // Backwards compat: bare string[] treated as agents list
  const options: DefaultConfigOptions = Array.isArray(opts) ? { agents: opts } : (opts ?? {});
  let config = `version = 1\n`;

  if (options.agents && options.agents.length > 0) {
    const list = options.agents.map((a) => `"${a}"`).join(", ");
    config += `agents = [${list}]\n`;
  }

  if (options.trust) {
    const t = options.trust;
    if (t.allow_all) {
      config += `\n[trust]\nallow_all = true\n`;
    } else {
      const fields = (
        ["github_orgs", "github_repos", "git_domains"] as const
      ).filter((k) => t[k].length > 0);
      if (fields.length > 0) {
        config += `\n[trust]\n`;
        for (const key of fields) {
          config += `${key} = ${tomlValue(t[key])}\n`;
        }
      }
    }
  }

  if (options.skills && options.skills.length > 0) {
    for (const skill of options.skills) {
      const entry: TomlDependencyEntry = { name: skill.name, source: skill.source };
      if (skill.ref) {entry["ref"] = skill.ref;}
      if (skill.path) {entry["path"] = skill.path;}
      config += `\n${stringify({ skills: [entry] }).trimEnd()}\n`;
    }
  }

  return config;
}
