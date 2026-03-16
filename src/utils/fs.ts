import { cp, rm } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Copy a directory recursively, excluding .git/.
 * Removes destination first if it exists.
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, {
    recursive: true,
    filter: (source) => basename(source) !== ".git",
  });
}
