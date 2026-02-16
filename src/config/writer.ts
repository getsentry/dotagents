import { readFile, writeFile } from "node:fs/promises";
import { stringify } from "smol-toml";
import type { SkillDependency, TrustConfig } from "./schema.js";

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
  dep: Omit<SkillDependency, "name">,
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
  await writeFile(filePath, removeBlockByName(content, name), "utf-8");
}

function removeBlockByName(content: string, name: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trim() === "[[skills]]") {
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
