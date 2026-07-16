import type { AgentsConfig } from "../../../config/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import { ensureSkillsSymlink } from "../../../symlinks/manager.js";
import { skillSymlinkTargets } from "../../../targets/skill-symlinks.js";
import { projectMcpResolver, reconcileMcpConfigs, toMcpDeclarations } from "../../../targets/mcp-writer.js";
import { projectHookResolver, reconcileHookConfigs, toHookDeclarations } from "../../../targets/hook-writer.js";
import { userMcpResolver } from "../../../targets/paths.js";
import {
  projectSubagentResolver,
  reconcileSubagentConfigs,
  userSubagentResolver,
} from "../../../subagents/writer.js";
import type { SubagentDeclaration } from "../../../subagents/types.js";

/** Writes agent skill symlinks after canonical install artifacts are ready. */
export async function writeSkillSymlinks(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<void> {
  const targets = skillSymlinkTargets(
    scope,
    config.agents,
    config.symlinks?.targets,
  );
  for (const target of targets) {
    await ensureSkillsSymlink(scope.agentsDir, target);
  }
}

/** Writes MCP runtime config for configured agents. */
export async function writeMcpRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<{ agent: string; message: string }[]> {
  const resolver = scope.scope === "user"
    ? userMcpResolver()
    : projectMcpResolver(scope.root);
  const result = await reconcileMcpConfigs(
    config.agents,
    toMcpDeclarations(config.mcp),
    resolver,
    "apply",
  );
  return result.unresolved.map(({ agent, issue }) => ({ agent, message: issue }));
}

/** Writes project-scoped hook runtime config for configured agents. */
export async function writeHookRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<{ agent: string; message: string }[]> {
  if (scope.scope !== "project") {return [];}
  const result = await reconcileHookConfigs(
    config.agents,
    toHookDeclarations(config.hooks),
    projectHookResolver(scope.root),
    "apply",
  );
  return result.warnings;
}

/** Writes agent-specific subagent runtime projections. */
export async function writeSubagentRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
  subagents: SubagentDeclaration[],
): Promise<{ agent: string; name: string; message: string }[]> {
  const resolver = scope.scope === "user"
    ? userSubagentResolver()
    : projectSubagentResolver(scope.root);
  const result = await reconcileSubagentConfigs(config.agents, subagents, resolver, {
    mode: "apply",
  });
  return result.warnings;
}
