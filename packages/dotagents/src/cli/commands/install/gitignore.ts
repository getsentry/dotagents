import chalk from "chalk";
import { isWildcardDep, type AgentsConfig } from "../../../config/schema.js";
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

function managedPluginNames(
  plugins: PluginDeclaration[],
): string[] {
  return plugins
    .filter((plugin) => !isInPlacePluginSource(plugin.source))
    .map((plugin) => plugin.name);
}

/** Regenerates project `.agents/.gitignore` from installed canonical artifacts. */
export async function writeInstallGitignore(
  config: AgentsConfig,
  scope: ScopeRoot,
  artifacts: InstallGitignoreArtifacts,
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
    artifacts.subagents.map((subagent) => subagent.name),
    managedPluginNames(artifacts.plugins),
  );

  const missing = await checkRootGitignoreEntries(scope.root);
  if (missing.length > 0) {
    console.log(chalk.yellow(`Warning: ${missing.join(", ")} should be in .gitignore. Run 'npx @sentry/dotagents doctor --fix' to fix.`));
  }
}
