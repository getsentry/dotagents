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

/** Strip trailing `/` characters from a string. */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") {end--;}
  return end === s.length ? s : s.slice(0, end);
}
