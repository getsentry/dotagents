import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { isInsideDir } from "../utils/fs.js";

export class LocalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalSourceError";
  }
}

/**
 * Resolve a path: source to an absolute directory.
 * The path is relative to the project root.
 */
export async function resolveLocalSource(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  const absPath = resolve(projectRoot, relativePath);

  // Prevent path traversal outside the project root.
  if (!isInsideDir(projectRoot, absPath)) {
    throw new LocalSourceError(
      `Local source "${relativePath}" resolves outside project root`,
    );
  }

  let s;
  try {
    s = await stat(absPath);
  } catch {
    throw new LocalSourceError(`Local source not found: ${absPath}`);
  }

  if (!s.isDirectory()) {
    throw new LocalSourceError(`Local source is not a directory: ${absPath}`);
  }

  return absPath;
}
