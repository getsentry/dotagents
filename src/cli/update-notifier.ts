import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CACHE_DIR = join(homedir(), ".dotagents");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/@sentry/dotagents/latest";
const FETCH_TIMEOUT_MS = 3000;

interface CacheData {
  lastCheck: number;
  latestVersion: string;
}

/**
 * Compare two semver strings (x.y.z only).
 * Returns positive if b > a, negative if a > b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readCache(cacheFile: string): Promise<CacheData | null> {
  try {
    const data = JSON.parse(await readFile(cacheFile, "utf-8"));
    if (typeof data?.lastCheck === "number" && typeof data?.latestVersion === "string") {
      return { lastCheck: data.lastCheck, latestVersion: data.latestVersion };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cacheDir: string, data: CacheData): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "update-check.json"), JSON.stringify(data), "utf-8");
  } catch {
    // Silently ignore write failures
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export function formatUpdateMessage(
  currentVersion: string,
  latestVersion: string,
): string {
  return `Update available: ${currentVersion} \u2192 ${latestVersion}\nRun \`npm install -g @sentry/dotagents\` to upgrade`;
}

/**
 * Check if a newer version of the package is available.
 * Returns a formatted message string if an update exists, or null otherwise.
 * Never throws — all failures silently return null.
 */
export async function checkForUpdate(
  currentVersion: string,
  options?: { cacheDir?: string },
): Promise<string | null> {
  try {
    const cacheDir = options?.cacheDir ?? DEFAULT_CACHE_DIR;
    const cache = await readCache(join(cacheDir, "update-check.json"));
    const now = Date.now();

    let latestVersion: string | null = null;

    if (cache && now - cache.lastCheck < ONE_DAY_MS) {
      latestVersion = cache.latestVersion;
    } else {
      latestVersion = await fetchLatestVersion();
      if (latestVersion) {
        await writeCache(cacheDir, { lastCheck: now, latestVersion });
      }
    }

    if (!latestVersion) return null;
    if (compareSemver(currentVersion, latestVersion) <= 0) return null;

    return formatUpdateMessage(currentVersion, latestVersion);
  } catch {
    return null;
  }
}
