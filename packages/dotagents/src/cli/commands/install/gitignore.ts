import chalk from "chalk";
import { isWildcardDep, type AgentsConfig } from "../../../config/schema.js";
import type { Lockfile } from "../../../lockfile/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import { filterManagedPluginSkillNames } from "../../../gitignore/skills.js";
import { checkRootGitignoreEntries, writeAgentsGitignore } from "../../../gitignore/writer.js";
import { isInPlaceSkill } from "../../../utils/fs.js";
import { isInPlacePluginSource, type PluginDeclaration } from "../../../plugins/store.js";
import { projectedPiSkillNames } from "../../../plugins/runtime/writer.js";
import type { SubagentDeclaration } from "../../../subagents/types.js";

export interface InstallGitignoreArtifacts {
  installedSkillNames: string[];
  subagents: SubagentDeclaration[];
  plugins: PluginDeclaration[];
}

function managedSkillNames(
  config: AgentsConfig,
  installed: string[],
): string[] {
  return installed.filter((name) => {
    const dep = config.skills.find((s) => s.name === name);
    if (!dep || isWildcardDep(dep)) {return true;}
    return !isInPlaceSkill(dep.source);
  });
}

function managedSubagentNames(
  lockfile: Lockfile | null,
  subagents: SubagentDeclaration[],
  frozen?: boolean,
): string[] {
  return frozen
    ? Object.keys(lockfile?.subagents ?? {})
    : subagents.map((subagent) => subagent.name);
}

function managedPluginNames(
  lockfile: Lockfile | null,
  plugins: PluginDeclaration[],
  frozen?: boolean,
): string[] {
  return frozen
    ? Object.entries(lockfile?.plugins ?? {})
      .filter(([, locked]) => !isInPlacePluginSource(locked.source))
      .map(([name]) => name)
    : plugins
      .filter((plugin) => !isInPlacePluginSource(plugin.source))
      .map((plugin) => plugin.name);
}

/** Regenerates project `.agents/.gitignore` from install results and lockfile state. */
export async function writeInstallGitignore(
  config: AgentsConfig,
  lockfile: Lockfile | null,
  scope: ScopeRoot,
  artifacts: InstallGitignoreArtifacts,
  frozen?: boolean,
): Promise<void> {
  if (scope.scope !== "project") {return;}

  const managedSkills = [
    ...managedSkillNames(config, artifacts.installedSkillNames),
    ...await filterManagedPluginSkillNames(
      await projectedPiSkillNames(config.agents, artifacts.plugins),
      config,
      scope.skillsDir,
      scope.pluginsDir,
    ),
  ];

  await writeAgentsGitignore(
    scope.agentsDir,
    managedSkills,
    managedSubagentNames(lockfile, artifacts.subagents, frozen),
    managedPluginNames(lockfile, artifacts.plugins, frozen),
  );

  const missing = await checkRootGitignoreEntries(scope.root);
  if (missing.length > 0) {
    console.log(chalk.yellow(`Warning: ${missing.join(", ")} should be in .gitignore. Run 'npx @sentry/dotagents doctor --fix' to fix.`));
  }
}
