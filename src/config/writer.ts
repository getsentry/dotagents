import { readFile, writeFile } from "node:fs/promises";
import { stringify } from "smol-toml";
import type { WildcardSkillDependency, TrustConfig, McpConfig } from "./schema.js";
import { sourcesMatch } from "../skills/resolver.js";

export interface DefaultConfigOptions {
  agents?: string[];
  trust?: TrustConfig;
  skills?: Array<{ name: string; source: string; ref?: string; path?: string }>;
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
  const entry: Record<string, string> = { name, source: dep.source };
  if (dep.ref) {entry["ref"] = dep.ref;}
  if (dep.path) {entry["path"] = dep.path;}

  const section = stringify({ skills: [entry] });

  const newContent = `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
  await writeFile(filePath, newContent, "utf-8");
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

/**
 * Add a wildcard skill entry (name = "*") to agents.toml.
 */
export async function addWildcardToConfig(
  filePath: string,
  source: string,
  opts?: Pick<WildcardSkillDependency, "ref" | "exclude">,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");

  const entry: Record<string, unknown> = { name: "*", source };
  if (opts?.ref) {entry["ref"] = opts.ref;}
  if (opts?.exclude && opts.exclude.length > 0) {entry["exclude"] = opts.exclude;}

  const section = stringify({ skills: [entry] });

  const newContent = `${content.trimEnd()}\n\n${section.trimEnd()}\n`;
  await writeFile(filePath, newContent, "utf-8");
}

/**
 * Add a skill name to the exclude list of a wildcard entry matching the given source.
 * If the exclude line already exists, appends to it. Otherwise adds a new line.
 */
export async function addExcludeToWildcard(
  filePath: string,
  source: string,
  skillName: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;
  let found = false;

  while (i < lines.length) {
    if (lines[i]!.trim() === "[[skills]]") {
      const blockLines = [lines[i]!];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.trim().startsWith("[")) {
        blockLines.push(lines[i]!);
        i++;
      }

      // Check if this is a wildcard block for the target source
      const nameLine = blockLines.find((l) => l.trim().startsWith("name"));
      const sourceLine = blockLines.find((l) => l.trim().startsWith("source"));
      const isWildcard = nameLine?.trim().match(/^name\s*=\s*"\*"/);
      const sourceMatch = sourceLine?.trim().match(/^source\s*=\s*"([^"]+)"/);

      if (isWildcard && sourceMatch && sourcesMatch(sourceMatch[1]!, source) && !found) {
        found = true;
        // Find or create exclude line
        const excludeIdx = blockLines.findIndex((l) => l.trim().startsWith("exclude"));
        if (excludeIdx >= 0) {
          // Parse existing exclude array and append
          const excludeLine = blockLines[excludeIdx]!;
          const match = excludeLine.trim().match(/^(exclude\s*=\s*)\[([^\]]*)\]/);
          if (match) {
            const existing = match[2]!.trim();
            const newValue = existing
              ? `${match[1]}[${existing}, ${stringify({ v: skillName }).replace("v = ", "")}]`
              : `${match[1]}[${stringify({ v: skillName }).replace("v = ", "")}]`;
            blockLines[excludeIdx] = newValue;
          }
        } else {
          // Add new exclude line after the last key-value line
          const excludeValue = stringify({ v: [skillName] }).replace("v = ", "");
          blockLines.push(`exclude = ${excludeValue}`);
        }
        result.push(...blockLines);
        continue;
      }

      result.push(...blockLines);
      continue;
    }

    result.push(lines[i]!);
    i++;
  }

  await writeFile(filePath, result.join("\n"), "utf-8");
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

  const obj: Record<string, unknown> = { name: entry.name };
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
  await writeFile(filePath, removeBlockByHeader(content, "[[mcp]]", name), "utf-8");
}

function removeBlockByHeader(content: string, header: string, name: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trim() === header) {
      // Collect the entire block (header + key-value lines)
      const blockLines = [lines[i]!];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.trim().startsWith("[")) {
        blockLines.push(lines[i]!);
        i++;
      }

      // Check if this block's name matches
      const nameLine = blockLines.find((l) => l.trim().startsWith("name"));
      const match = nameLine?.match(/^name\s*=\s*"([^"]+)"/);
      if (match && match[1] === name) {
        // Remove blank lines before the block
        while (result.length > 0 && result.at(-1)?.trim() === "") {
          result.pop();
        }
        // Skip this block
        continue;
      }

      // Not the target — keep the block
      result.push(...blockLines);
      continue;
    }

    result.push(lines[i]!);
    i++;
  }

  return result.join("\n");
}

function tomlArray(values: string[]): string {
  return stringify({ v: values }).replace("v = ", "");
}

/**
 * Add a value to a trust field array in agents.toml.
 * Creates the [trust] section and field line if they don't exist.
 */
export async function addTrustSource(
  filePath: string,
  field: "github_orgs" | "github_repos" | "git_domains",
  value: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  let trustSectionIdx = -1;
  let fieldLineIdx = -1;

  // First pass: find [trust] section and target field
  for (let j = 0; j < lines.length; j++) {
    if (lines[j]!.trim() === "[trust]") {
      trustSectionIdx = j;
    } else if (trustSectionIdx >= 0 && fieldLineIdx < 0) {
      const trimmed = lines[j]!.trim();
      if (trimmed.startsWith("[")) {break;}
      if (trimmed.startsWith(`${field} `) || trimmed.startsWith(`${field}=`)) {
        fieldLineIdx = j;
      }
    }
  }

  if (trustSectionIdx >= 0 && fieldLineIdx >= 0) {
    // Field exists — parse and append
    const line = lines[fieldLineIdx]!;
    const indent = line.match(/^(\s*)/)?.[1] ?? "";
    const trimmedLine = line.trim();
    const match = trimmedLine.match(new RegExp(`^(${field}\\s*=\\s*)\\[([^\\]]*)\\]`));
    if (match) {
      const existing = match[2]!.trim();
      const newVal = stringify({ v: value }).replace("v = ", "");
      const updated = existing
        ? `${match[1]}[${existing}, ${newVal}]`
        : `${match[1]}[${newVal}]`;
      lines[fieldLineIdx] = indent + updated;
    }
    await writeFile(filePath, lines.join("\n"), "utf-8");
    return;
  }

  if (trustSectionIdx >= 0) {
    // [trust] exists but field doesn't — insert at end of trust section
    let insertIdx = trustSectionIdx + 1;
    while (insertIdx < lines.length) {
      const trimmed = lines[insertIdx]!.trim();
      if (trimmed.startsWith("[")) {break;}
      if (trimmed === "" && insertIdx + 1 < lines.length && lines[insertIdx + 1]!.trim().startsWith("[")) {break;}
      insertIdx++;
    }
    lines.splice(insertIdx, 0, `${field} = ${tomlArray([value])}`);
    await writeFile(filePath, lines.join("\n"), "utf-8");
    return;
  }

  // No [trust] section — create one before [[skills]]/[[mcp]]/[[hooks]], or at end
  const arrayTableIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t === "[[skills]]" || t === "[[mcp]]" || t === "[[hooks]]";
  });

  if (arrayTableIdx >= 0) {
    lines.splice(arrayTableIdx, 0, `[trust]`, `${field} = ${tomlArray([value])}`, "");
    await writeFile(filePath, lines.join("\n"), "utf-8");
    return;
  }

  const newContent = `${content.trimEnd()}\n\n[trust]\n${field} = ${tomlArray([value])}\n`;
  await writeFile(filePath, newContent, "utf-8");
}

/**
 * Remove a value from a trust field array in agents.toml.
 * If the array becomes empty, removes the field line.
 */
export async function removeTrustSource(
  filePath: string,
  field: "github_orgs" | "github_repos" | "git_domains",
  value: string,
): Promise<void> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  let trustSectionIdx = -1;

  for (let j = 0; j < lines.length; j++) {
    if (lines[j]!.trim() === "[trust]") {
      trustSectionIdx = j;
    } else if (trustSectionIdx >= 0) {
      const trimmed = lines[j]!.trim();
      if (trimmed.startsWith("[")) {break;}

      if (trimmed.startsWith(`${field} `) || trimmed.startsWith(`${field}=`)) {
        const match = trimmed.match(new RegExp(`^${field}\\s*=\\s*\\[([^\\]]*)\\]`));
        if (!match) {break;}

        const items = match[1]!
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const filtered = items.filter(
          (s) => s.replaceAll(/^"|"$/g, "").toLowerCase() !== value.toLowerCase(),
        );

        if (filtered.length === 0) {
          lines.splice(j, 1);
          // If [trust] section is now empty, remove the header too
          if (isTrustSectionEmpty(lines, trustSectionIdx)) {
            removeTrustHeader(lines, trustSectionIdx);
          }
        } else {
          const indent = lines[j]!.match(/^(\s*)/)?.[1] ?? "";
          lines[j] = `${indent}${field} = [${filtered.join(", ")}]`;
        }

        await writeFile(filePath, lines.join("\n"), "utf-8");
        return;
      }
    }
  }
}

/** Check if a [trust] section has no remaining field lines. */
function isTrustSectionEmpty(lines: string[], headerIdx: number): boolean {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("[")) {return true;}
    if (trimmed !== "") {return false;}
  }
  return true;
}

/** Remove the [trust] header and any trailing blank lines. */
function removeTrustHeader(lines: string[], headerIdx: number): void {
  let removeCount = 1;
  // Also remove trailing blank lines after the header
  while (headerIdx + removeCount < lines.length && lines[headerIdx + removeCount]!.trim() === "") {
    removeCount++;
  }
  // Also remove leading blank line before the header if present
  if (headerIdx > 0 && lines[headerIdx - 1]!.trim() === "") {
    lines.splice(headerIdx - 1, removeCount + 1);
  } else {
    lines.splice(headerIdx, removeCount);
  }
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
          config += `${key} = ${tomlArray(t[key])}\n`;
        }
      }
    }
  }

  if (options.skills && options.skills.length > 0) {
    for (const skill of options.skills) {
      const entry: Record<string, string> = { name: skill.name, source: skill.source };
      if (skill.ref) {entry["ref"] = skill.ref;}
      if (skill.path) {entry["path"] = skill.path;}
      config += `\n${stringify({ skills: [entry] }).trimEnd()}\n`;
    }
  }

  return config;
}
