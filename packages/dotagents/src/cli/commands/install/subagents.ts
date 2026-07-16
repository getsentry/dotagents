import { join } from "node:path";
import type { AgentsConfig } from "../../../config/schema.js";
import type { Lockfile } from "../../../lockfile/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import type { SubagentDeclaration } from "../../../subagents/types.js";
import {
  InstalledSubagentWriteError,
  lockEntryForSubagent,
  pruneInstalledSubagents,
  resolveSubagent,
  writeInstalledSubagents,
} from "../../../subagents/store.js";
import { GitError, TrustError } from "@sentry/dotagents-lib";
import { getCacheStateDir } from "../../cache.js";
import { InstallError } from "./errors.js";

export interface InstallSubagentsResult {
  subagents: SubagentDeclaration[];
  lockEntries: Lockfile["subagents"];
}

/** Resolves subagent declarations and lock entries without writing runtime files. */
export async function installSubagents(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<InstallSubagentsResult> {
  const subagents: SubagentDeclaration[] = [];
  const lockEntries: Lockfile["subagents"] = {};

  for (const subagentConfig of config.subagents) {
    let resolved: Awaited<ReturnType<typeof resolveSubagent>>;
    try {
      resolved = await resolveSubagent(subagentConfig, {
        stateDir: getCacheStateDir(),
        projectRoot: scope.root,
        defaultRepositorySource: config.defaultRepositorySource,
        minimumReleaseAge: config.minimum_release_age,
        minimumReleaseAgeExclude: config.minimum_release_age_exclude,
        trust: config.trust,
      });
    } catch (err) {
      if (err instanceof GitError || err instanceof TrustError) {throw err;}
      const msg = err instanceof Error ? err.message : String(err);
      throw new InstallError(`Failed to resolve subagent "${subagentConfig.name}": ${msg}`);
    }

    subagents.push(resolved.subagent);
    lockEntries[resolved.subagent.name] = lockEntryForSubagent(resolved);
  }

  return { subagents, lockEntries };
}

/** Writes canonical `.agents/agents` markdown files before the lockfile commit. */
export async function writeCanonicalSubagents(
  config: AgentsConfig,
  scope: ScopeRoot,
  subagents: SubagentDeclaration[],
): Promise<void> {
  const subagentsDir = join(scope.agentsDir, "agents");
  try {
    await writeInstalledSubagents(subagentsDir, subagents);
    await pruneInstalledSubagents(subagentsDir, config.subagents);
  } catch (err) {
    if (err instanceof InstalledSubagentWriteError) {
      throw new InstallError(err.message);
    }
    throw err;
  }
}
