import { resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { isWildcardDep, type AgentsConfig, type RepositorySource, type SkillDependency } from "../../../config/schema.js";
import type { Lockfile, LockedSkill } from "../../../lockfile/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import { isInPlaceSkill, managedSkillPath } from "../../../utils/fs.js";
import {
  applyDefaultRepositorySource,
  copyDir,
  GitError,
  resolveSkill,
  resolveWildcardSkills,
  sourcesMatch,
  TrustError,
  type ResolvedSkill,
  type CacheReuse,
  validateTrustedSource,
} from "@sentry/dotagents-lib";
import { getCacheStateDir, HOST_SCAN_DIRS } from "../../cache.js";
import { InstallError } from "./errors.js";

/** Expanded skill ready for install: either an explicit entry or wildcard result. */
interface ExpandedSkill {
  name: string;
  dep: SkillDependency;
  resolved?: ResolvedSkill;
}

export interface InstallSkillsResult {
  installed: string[];
  pruned: string[];
  lockEntries: Lockfile["skills"];
}

/**
 * Expand config skills into a flat list, resolving wildcards.
 * Explicit entries always win over wildcard-discovered skills.
 */
async function expandSkills(
  config: {
    skills: SkillDependency[];
    trust?: Parameters<typeof validateTrustedSource>[1];
    defaultRepositorySource: RepositorySource;
  },
  opts: {
    projectRoot: string;
    minimumReleaseAge?: number;
    minimumReleaseAgeExclude?: string[];
    reuse?: CacheReuse;
  },
): Promise<ExpandedSkill[]> {
  const regularDeps = config.skills.filter((d) => !isWildcardDep(d));
  const wildcardDeps = config.skills.filter(isWildcardDep);
  const explicitNames = new Set(regularDeps.map((d) => d.name));

  const expanded: ExpandedSkill[] = [];
  for (const dep of regularDeps) {
    expanded.push({ name: dep.name, dep });
  }

  const wildcardNames = new Map<string, string>();
  for (const wDep of wildcardDeps) {
    const wildcardSourceForTrust = applyDefaultRepositorySource(
      wDep.source,
      config.defaultRepositorySource,
    );
    validateTrustedSource(wildcardSourceForTrust, config.trust);

    let named;
    try {
      named = await resolveWildcardSkills(wDep, {
        stateDir: getCacheStateDir(),
        scanDirs: HOST_SCAN_DIRS,
        projectRoot: opts.projectRoot,
        defaultRepositorySource: config.defaultRepositorySource,
        minimumReleaseAge: opts.minimumReleaseAge,
        minimumReleaseAgeExclude: opts.minimumReleaseAgeExclude,
        reuse: opts.reuse,
      });
    } catch (err) {
      if (err instanceof GitError || err instanceof TrustError) {throw err;}
      const msg = err instanceof Error ? err.message : String(err);
      throw new InstallError(`Failed to resolve wildcard source "${wDep.source}": ${msg}`);
    }

    for (const { name, resolved } of named) {
      if (explicitNames.has(name)) {continue;}
      const existingSource = wildcardNames.get(name);
      if (existingSource && !sourcesMatch(existingSource, wDep.source)) {
        throw new InstallError(
          `Skill "${name}" found in both wildcard sources: "${existingSource}" and "${wDep.source}". ` +
            "Use an explicit [[skills]] entry or add it to one source's exclude list.",
        );
      }
      wildcardNames.set(name, wDep.source);
      expanded.push({ name, dep: wDep, resolved });
    }
  }

  return expanded;
}

function lockEntryForSkill(dep: SkillDependency, resolved: ResolvedSkill): LockedSkill {
  if (resolved.type === "git") {
    return {
      source: dep.source,
      resolved_url: resolved.resolvedUrl,
      resolved_path: resolved.resolvedPath,
      ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
      resolved_commit: resolved.commit,
    };
  }
  if (resolved.type === "well-known") {
    return {
      source: dep.source,
      resolved_url: resolved.resolvedUrl,
    };
  }
  return {
    source: dep.source,
    ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath } : {}),
  };
}

/** Resolves, copies, and prunes canonical skill directories for install. */
export async function installSkills(
  config: AgentsConfig,
  lockfile: Lockfile | null,
  scope: ScopeRoot,
  reuse?: CacheReuse,
): Promise<InstallSkillsResult> {
  const lockEntries: Lockfile["skills"] = {};
  const installed: string[] = [];
  const pruned: string[] = [];

  await mkdir(scope.skillsDir, { recursive: true });

  if (config.skills.length > 0) {
    const expanded = await expandSkills(
      {
        skills: config.skills,
        trust: config.trust,
        defaultRepositorySource: config.defaultRepositorySource,
      },
      {
        projectRoot: scope.root,
        minimumReleaseAge: config.minimum_release_age,
        minimumReleaseAgeExclude: config.minimum_release_age_exclude,
        reuse,
      },
    );

    for (const item of expanded) {
      const { name, dep } = item;
      const sourceForTrust = applyDefaultRepositorySource(
        dep.source,
        config.defaultRepositorySource,
      );
      validateTrustedSource(sourceForTrust, config.trust);

      const destDir = managedSkillPath(scope.skillsDir, name);
      if (!destDir) {
        throw new InstallError(`Invalid skill name "${name}" in install plan.`);
      }

      let resolved: ResolvedSkill;
      if (item.resolved) {
        resolved = item.resolved;
      } else {
        try {
          resolved = await resolveSkill(name, dep, {
            stateDir: getCacheStateDir(),
            scanDirs: HOST_SCAN_DIRS,
            projectRoot: scope.root,
            defaultRepositorySource: config.defaultRepositorySource,
            minimumReleaseAge: config.minimum_release_age,
            minimumReleaseAgeExclude: config.minimum_release_age_exclude,
            reuse,
          });
        } catch (err) {
          if (err instanceof GitError || err instanceof TrustError) {throw err;}
          const msg = err instanceof Error ? err.message : String(err);
          throw new InstallError(`Failed to resolve skill "${name}": ${msg}`);
        }
      }

      if (resolve(resolved.skillDir) !== resolve(destDir)) {
        await copyDir(resolved.skillDir, destDir);
      }

      lockEntries[name] = lockEntryForSkill(dep, resolved);
      installed.push(name);
    }
  }

  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.skills)) {
      if (lockEntries[name]) {continue;}
      if (isInPlaceSkill(locked.source)) {continue;}
      const skillPath = managedSkillPath(scope.skillsDir, name);
      if (!skillPath) {continue;}
      await rm(skillPath, { recursive: true, force: true });
      pruned.push(name);
    }
  }

  return { installed, pruned, lockEntries };
}
