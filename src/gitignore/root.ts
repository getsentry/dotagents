import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ENTRY = ".agents/.gitignore";

/**
 * Ensure the project root .gitignore contains an entry for .agents/.gitignore.
 * Creates the file if it doesn't exist. Returns true if the file was modified.
 */
export async function ensureRootGitignoreEntry(projectRoot: string): Promise<boolean> {
  const gitignorePath = join(projectRoot, ".gitignore");

  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, ENTRY + "\n", "utf-8");
    return true;
  }

  const content = await readFile(gitignorePath, "utf-8");
  const lines = content.split("\n").map((l) => l.trim());

  if (lines.includes(ENTRY)) {
    return false;
  }

  const suffix = content.endsWith("\n") ? "" : "\n";
  await writeFile(gitignorePath, content + suffix + ENTRY + "\n", "utf-8");
  return true;
}
