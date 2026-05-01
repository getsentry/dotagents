import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the cache root for the dotagents host.
 *
 * Resolution order: `DOTAGENTS_STATE_DIR` env var → `~/.local/dotagents/`.
 *
 * The lib does not impose a default; this is the host's choice. Pass the
 * returned path as `stateDir` to `ensureCached`/`ensureWellKnownCached` and
 * to `resolveSkill`/`resolveWildcardSkills` opts.
 */
export function getCacheStateDir(): string {
  return process.env["DOTAGENTS_STATE_DIR"] || join(homedir(), ".local", "dotagents");
}

/**
 * Recursive scan dirs the dotagents host wants the lib to look in for SKILL.md
 * inside a fetched source repo, on top of the canonical `skills/`. Covers
 * dotagents-managed checkouts and Claude-Code conventions.
 */
export const HOST_SCAN_DIRS: readonly string[] = ["skills", ".agents/skills", ".claude/skills"];
