import { join } from "node:path";
import type { AgentsConfig, SubagentConfig } from "../../../config/schema.js";
import type { Lockfile } from "../../../lockfile/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import type { SubagentDeclaration } from "../../../agents/types.js";
import {
  InstalledSubagentWriteError,
  lockEntryForSubagent,
  loadInstalledSubagents,
  pruneInstalledSubagents,
  resolveSubagent,
  writeInstalledSubagents,
} from "../../../agents/subagent-store.js";
import { GitError, TrustError } from "@sentry/dotagents-lib";
import { getCacheStateDir } from "../../cache.js";
import { InstallError } from "./errors.js";

export interface InstallSubagentsResult {
  subagents: SubagentDeclaration[];
  lockEntries: Lockfile["subagents"];
}

function validateFrozenSubagents(
  subagents: SubagentConfig[],
  lockfile: Lockfile | null,
): void {
  if (subagents.length === 0) {return;}
  if (!lockfile) {
    throw new InstallError("--frozen requires agents.lock to exist.");
  }

  for (const subagent of subagents) {
    if (!lockfile.subagents[subagent.name]) {
      throw new InstallError(
        `--frozen: subagent "${subagent.name}" is in agents.toml but missing from agents.lock.`,
      );
    }
  }
}

/** Resolves subagent declarations and lock entries without writing runtime files. */
export async function installSubagents(
  config: AgentsConfig,
  lockfile: Lockfile | null,
  scope: ScopeRoot,
  frozen?: boolean,
): Promise<InstallSubagentsResult> {
  const subagentsDir = join(scope.agentsDir, "agents");
  const subagents: SubagentDeclaration[] = [];
  const lockEntries: Lockfile["subagents"] = {};

  if (frozen) {
    validateFrozenSubagents(config.subagents, lockfile);
    if (config.subagents.length > 0) {
      const loaded = await loadInstalledSubagents(subagentsDir, config.subagents);
      if (loaded.issues.length > 0) {
        throw new InstallError(loaded.issues.map((issue) => issue.issue).join("\n"));
      }
      subagents.push(...loaded.subagents);
    }
    return { subagents, lockEntries };
  }

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
  frozen?: boolean,
): Promise<void> {
  if (frozen) {return;}
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
