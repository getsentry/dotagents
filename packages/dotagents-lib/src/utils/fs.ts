import { cp, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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

/**
 * Whether `s` starts with a Windows drive root (`C:\repo`, `C:/repo`).
 *
 * Hand-rolled rather than `path.win32.isAbsolute` because that also accepts a
 * bare leading separator and UNC (`\\server\share`), which callers here treat
 * differently. Drive-*relative* forms (`C:repo`, no separator) are not roots
 * and are deliberately excluded.
 */
export function isWindowsDrivePath(s: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(s);
}

/**
 * Whether `s` is an absolute filesystem path in either convention — POSIX
 * (`/repo`) or a Windows drive root (`C:\repo`).
 *
 * `path.isAbsolute` is platform-dependent (it returns false for `C:\repo` when
 * running on POSIX), so anything that must classify a path string identically
 * on every host — config validation, trust, cache keys — uses this instead.
 */
export function isAbsolutePathString(s: string): boolean {
  return s.startsWith("/") || isWindowsDrivePath(s);
}

/**
 * Whether `target` is `root` itself or a path beneath it.
 *
 * Compares with path.relative rather than a string prefix so the check is
 * separator-agnostic (on Windows `root` uses `\`, so a `${root}/` prefix would
 * never match a real child), and matches whole `..` segments so a legitimate
 * child named `..foo` is not mistaken for a traversal.
 *
 * Shared by every "does this resolved path escape its root" guard so the
 * predicate can't drift between call sites.
 */
export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Strip trailing `/` characters from a string. */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") {end--;}
  return end === s.length ? s : s.slice(0, end);
}
