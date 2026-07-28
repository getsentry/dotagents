import { posix, sep } from "node:path";
import { sourcesMatch, stripTrailingSlashes } from "@sentry/dotagents-lib";
import type { WildcardSkillDependency } from "../config/schema.js";
import type { LockedSkill } from "./schema.js";

/**
 * Whether a locked skill is still selected by a wildcard dependency.
 * Legacy entries without path metadata remain selected until install refreshes them.
 */
export function wildcardContainsLockedSkill(
  wildcard: WildcardSkillDependency,
  name: string,
  locked: LockedSkill,
): boolean {
  if (!sourcesMatch(wildcard.source, locked.source)) {return false;}
  if (wildcard.exclude.includes(name)) {return false;}
  if (!wildcard.path) {return true;}

  const resolvedPath = "resolved_path" in locked ? locked.resolved_path : undefined;
  if (!resolvedPath) {return true;}

  const path = stripTrailingSlashes(posix.normalize(wildcard.path.split(sep).join("/")));
  if (path === ".") {return true;}
  return path !== "" && (resolvedPath === path || resolvedPath.startsWith(`${path}/`));
}
