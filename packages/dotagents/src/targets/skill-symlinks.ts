import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProjectPath, type ScopeRoot } from "../scope.js";
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
    return targets.map((target) => resolve(resolveProjectPath(scope.root, target)));
  }

  const perSkill = new Set(perSkillLinkTargets(scope, agentIds).map((target) => resolve(target)));
  for (const agentId of agentIds) {
    for (const target of getAgent(agentId)?.userSkillsParentDirs ?? []) {
      if (pathsReferToSameEntry(target, scope.agentsDir)) {continue;}
      if (seen.has(target) || perSkill.has(resolve(target))) {continue;}
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

/**
 * User-scope parent directories whose skills/ gets one link per shared skill instead of a
 * directory link. A directory shared by several agents uses per-skill links if any of them asks.
 */
export function perSkillLinkTargets(scope: ScopeRoot, agentIds: readonly string[]): string[] {
  if (scope.scope !== "user") {return [];}
  const targets: string[] = [];
  for (const agentId of agentIds) {
    const agent = getAgent(agentId);
    if (agent?.userSkillsLinkMode !== "per-skill") {continue;}
    for (const target of agent.userSkillsParentDirs ?? []) {
      if (pathsReferToSameEntry(target, scope.agentsDir) || targets.some((known) => resolve(known) === resolve(target))) {continue;}
      targets.push(target);
    }
  }
  return targets;
}

function pathsReferToSameEntry(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) {return true;}
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
