import { join, resolve } from "node:path";
import type { ScopeRoot } from "../scope.js";
import { getAgent } from "./registry.js";

/** Owns the shared projection of configured agents and legacy entries to absolute symlink targets. */
export function skillSymlinkTargets(
  scope: ScopeRoot,
  agentIds: readonly string[],
  legacyTargets: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];

  if (scope.scope === "project") {
    for (const target of legacyTargets) {
      if (seen.has(target)) {continue;}
      seen.add(target);
      targets.push(target);
    }
    for (const agentId of agentIds) {
      const target = getAgent(agentId)?.skillsParentDir;
      if (!target || seen.has(target)) {continue;}
      seen.add(target);
      targets.push(target);
    }
    return targets.map((target) => resolve(join(scope.root, target)));
  }

  for (const agentId of agentIds) {
    for (const target of getAgent(agentId)?.userSkillsParentDirs ?? []) {
      if (seen.has(target)) {continue;}
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}
