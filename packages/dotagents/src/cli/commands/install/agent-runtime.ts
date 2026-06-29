import { join } from "node:path";
import type { AgentsConfig } from "../../../config/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import { getAgent } from "../../../agents/registry.js";
import { ensureSkillsSymlink } from "../../../symlinks/manager.js";
import { projectMcpResolver, toMcpDeclarations, writeMcpConfigs } from "../../../agents/mcp-writer.js";
import { projectHookResolver, toHookDeclarations, writeHookConfigs } from "../../../agents/hook-writer.js";
import { userMcpResolver } from "../../../agents/paths.js";
import {
  pruneSubagentConfigs,
  projectSubagentResolver,
  userSubagentResolver,
  writeSubagentConfigs,
} from "../../../agents/subagent-writer.js";
import type { SubagentDeclaration } from "../../../agents/types.js";

/** Writes agent skill symlinks after canonical install artifacts are ready. */
export async function writeSkillSymlinks(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<void> {
  if (scope.scope === "user") {
    const seen = new Set<string>();
    for (const agentId of config.agents) {
      const agent = getAgent(agentId);
      if (!agent?.userSkillsParentDirs) {continue;}
      for (const dir of agent.userSkillsParentDirs) {
        if (seen.has(dir)) {continue;}
        seen.add(dir);
        await ensureSkillsSymlink(scope.agentsDir, dir);
      }
    }
    return;
  }

  const targets = config.symlinks?.targets ?? [];
  for (const target of targets) {
    await ensureSkillsSymlink(scope.agentsDir, join(scope.root, target));
  }

  const seenParentDirs = new Set(targets);
  for (const agentId of config.agents) {
    const agent = getAgent(agentId);
    if (!agent?.skillsParentDir) {continue;}
    if (seenParentDirs.has(agent.skillsParentDir)) {continue;}
    seenParentDirs.add(agent.skillsParentDir);
    await ensureSkillsSymlink(scope.agentsDir, join(scope.root, agent.skillsParentDir));
  }
}

/** Writes MCP runtime config for configured agents. */
export async function writeMcpRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<void> {
  const resolver = scope.scope === "user"
    ? userMcpResolver()
    : projectMcpResolver(scope.root);
  await writeMcpConfigs(config.agents, toMcpDeclarations(config.mcp), resolver);
}

/** Writes project-scoped hook runtime config for configured agents. */
export async function writeHookRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<{ agent: string; message: string }[]> {
  if (scope.scope !== "project") {return [];}
  return writeHookConfigs(
    config.agents,
    toHookDeclarations(config.hooks),
    projectHookResolver(scope.root),
  );
}

/** Writes agent-specific subagent runtime projections. */
export async function writeSubagentRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
  subagents: SubagentDeclaration[],
  frozen?: boolean,
): Promise<{ agent: string; name: string; message: string }[]> {
  const resolver = scope.scope === "user"
    ? userSubagentResolver()
    : projectSubagentResolver(scope.root);
  const result = await writeSubagentConfigs(config.agents, subagents, resolver);
  if (!frozen) {
    await pruneSubagentConfigs(config.agents, subagents, resolver);
  }
  return result.warnings;
}
