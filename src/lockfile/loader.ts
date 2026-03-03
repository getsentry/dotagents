import { readFile } from "node:fs/promises";
import { parse as parseTOML } from "smol-toml";
import { lockfileSchema, type Lockfile } from "./schema.js";

export class LockfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileError";
  }
}

/**
 * Load and validate agents.lock.
 * Returns null if the file doesn't exist (first install).
 */
export async function loadLockfile(filePath: string): Promise<Lockfile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseTOML(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LockfileError(`Invalid TOML in lockfile: ${message}`);
  }

  const result = lockfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new LockfileError(`Invalid lockfile schema: ${result.error.message}`);
  }

  return result.data;
}
