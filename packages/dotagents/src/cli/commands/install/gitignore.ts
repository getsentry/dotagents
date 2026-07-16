import chalk from "chalk";
import { isWildcardDep, type AgentsConfig } from "../../../config/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import { checkRootGitignoreEntries, writeAgentsGitignore } from "../../../gitignore/writer.js";
import { isInPlaceSkill } from "../../../utils/fs.js";
import type { SubagentDeclaration } from "../../../subagents/types.js";

export interface InstallGitignoreArtifacts {
  installedSkillNames: string[];
  subagents: SubagentDeclaration[];
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

/** Regenerates project `.agents/.gitignore` from installed canonical artifacts. */
export async function writeInstallGitignore(
  config: AgentsConfig,
  scope: ScopeRoot,
  artifacts: InstallGitignoreArtifacts,
): Promise<void> {
  if (scope.scope !== "project") {return;}

  await writeAgentsGitignore(
    scope.agentsDir,
    managedSkillNames(config, artifacts.installedSkillNames),
    artifacts.subagents.map((subagent) => subagent.name),
  );

  const missing = await checkRootGitignoreEntries(scope.root);
  if (missing.length > 0) {
    console.log(chalk.yellow(`Warning: ${missing.join(", ")} should be in .gitignore. Run 'npx @sentry/dotagents doctor --fix' to fix.`));
  }
}
