import { readFile, writeFile } from "node:fs/promises";
import { stringify } from "smol-toml";
import type { WildcardSkillDependency, TrustConfig, McpConfig } from "./schema.js";
import { sourcesMatch } from "../skills/resolver.js";

export interface DefaultConfigOptions {
  agents?: string[];
  gitignore?: boolean;
  trust?: TrustConfig;
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
  if (dep.ref) entry["ref"] = dep.ref;
  if (dep.path) entry["path"] = dep.path;

  const section = stringify({ skills: [entry] });

  const newContent = content.trimEnd() + "\n\n" + section.trimEnd() + "\n";
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
  if (opts?.ref) entry["ref"] = opts.ref;
  if (opts?.exclude && opts.exclude.length > 0) entry["exclude"] = opts.exclude;

  const section = stringify({ skills: [entry] });

  const newContent = content.trimEnd() + "\n\n" + section.trimEnd() + "\n";
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
    if (entry.args && entry.args.length > 0) obj["args"] = entry.args;
  }
  if (entry.url) {
    obj["url"] = entry.url;
    if (entry.headers && Object.keys(entry.headers).length > 0) obj["headers"] = entry.headers;
  }
  if (entry.env.length > 0) obj["env"] = entry.env;

  const section = stringify({ mcp: [obj] });

  const newContent = content.trimEnd() + "\n\n" + section.trimEnd() + "\n";
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
        while (result.length > 0 && result[result.length - 1]?.trim() === "") {
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
 * Generate a minimal agents.toml scaffold.
 */
export function generateDefaultConfig(opts?: DefaultConfigOptions | string[]): string {
  // Backwards compat: bare string[] treated as agents list
  const options: DefaultConfigOptions = Array.isArray(opts) ? { agents: opts } : (opts ?? {});
  const gitignore = options.gitignore ?? false;

  let config = `version = 1\n`;
  if (gitignore) {
    config += `# Managed skills are gitignored; collaborators must run 'dotagents install'.\ngitignore = true\n`;
  } else {
    config += `# Check skills into git so collaborators get them without running 'dotagents install'.\n# Set to true (or remove) to gitignore managed skills instead.\ngitignore = false\n`;
  }

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

  return config;
}
