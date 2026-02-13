import { readFile, writeFile } from "node:fs/promises";
import { stringify } from "smol-toml";
import type { SkillDependency } from "./schema.js";

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

/**
 * Generate a minimal agents.toml scaffold.
 */
export function generateDefaultConfig(agents?: string[]): string {
  let config = `version = 1
# Check skills into git so collaborators get them without running 'dotagents install'.
# Set to true (or remove) to gitignore managed skills instead.
gitignore = false
`;
  if (agents && agents.length > 0) {
    const list = agents.map((a) => `"${a}"`).join(", ");
    config += `agents = [${list}]\n`;
  }
  return config;
}
