import { join } from "node:path";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { stripTrailingSlashes } from "../utils/fs.js";

/** Names must be safe for use in file paths: alphanumeric, dots, hyphens, underscores. */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const DEFAULT_STATE_DIR = join(homedir(), ".local", "dotagents");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 10_000;
const MARKER_FILE = ".well-known-fetched";

export interface WellKnownIndex {
  skills: WellKnownSkillEntry[];
}

export interface WellKnownSkillEntry {
  name: string;
  description?: string;
  files: string[];
}

/**
 * Fetch the well-known skills index from a base URL.
 * Returns the parsed index or null on failure (404, network error, invalid JSON).
 */
export async function fetchWellKnownIndex(
  baseUrl: string,
): Promise<WellKnownIndex | null> {
  const indexUrl = `${stripTrailingSlashes(baseUrl)}/.well-known/skills/index.json`;
  try {
    const response = await fetch(indexUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {return null;}

    const data = (await response.json()) as unknown;
    if (!isValidIndex(data)) {return null;}
    return data;
  } catch {
    return null;
  }
}

function isValidIndex(data: unknown): data is WellKnownIndex {
  if (!data || typeof data !== "object") {return false;}
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj["skills"])) {return false;}
  return (obj["skills"] as unknown[]).every(
    (s: unknown) => {
      if (!s || typeof s !== "object") {return false;}
      const entry = s as Record<string, unknown>;
      return typeof entry["name"] === "string" && Array.isArray(entry["files"]);
    },
  );
}

export interface WellKnownCacheResult {
  /** Path to the cached skills directory (contains one subdirectory per skill) */
  cacheDir: string;
}

/**
 * Ensure skills from a well-known HTTP source are cached locally.
 *
 * Cache layout:
 *   ~/.local/dotagents/wellknown/<hostname>/<skillName>/SKILL.md
 *
 * Uses a TTL-based marker file for freshness. On fetch failure with
 * existing cache, returns stale cache (same offline behavior as git).
 */
export async function ensureWellKnownCached(opts: {
  url: string;
  cacheKey: string;
  ttlMs?: number;
}): Promise<WellKnownCacheResult | null> {
  const stateDir = process.env["DOTAGENTS_STATE_DIR"] || DEFAULT_STATE_DIR;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cacheDir = join(stateDir, opts.cacheKey);

  if (existsSync(cacheDir) && !(await isStale(cacheDir, ttl))) {
    return { cacheDir };
  }

  const baseUrl = stripTrailingSlashes(opts.url);
  const index = await fetchWellKnownIndex(baseUrl);

  if (!index) {
    // Fetch failed — use stale cache if available
    if (existsSync(cacheDir)) {
      return { cacheDir };
    }
    return null;
  }

  // Download all skill files into cache
  await mkdir(cacheDir, { recursive: true });

  // Remove old skill directories that are no longer in the index
  const currentSkills = new Set(index.skills.map((s) => s.name));
  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !currentSkills.has(entry.name)) {
        await rm(join(cacheDir, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore readdir failures
  }

  for (const skill of index.skills) {
    // Validate skill name to prevent path traversal from untrusted index
    if (!SAFE_PATH_SEGMENT.test(skill.name)) {continue;}

    const skillDir = join(cacheDir, skill.name);
    await mkdir(skillDir, { recursive: true });

    for (const file of skill.files) {
      // Validate file name to prevent path traversal
      if (!SAFE_PATH_SEGMENT.test(file)) {continue;}

      const fileUrl = `${baseUrl}/.well-known/skills/${skill.name}/${file}`;
      try {
        const response = await fetch(fileUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {continue;}
        const content = await response.text();
        await writeFile(join(skillDir, file), content, "utf-8");
      } catch {
        // Skip files that fail to download
      }
    }
  }

  // Write marker file with current timestamp
  await writeFile(join(cacheDir, MARKER_FILE), Date.now().toString(), "utf-8");

  return { cacheDir };
}

async function isStale(cacheDir: string, ttlMs: number): Promise<boolean> {
  try {
    const markerPath = join(cacheDir, MARKER_FILE);
    const s = await stat(markerPath);
    return Date.now() - s.mtimeMs > ttlMs;
  } catch {
    return true;
  }
}
