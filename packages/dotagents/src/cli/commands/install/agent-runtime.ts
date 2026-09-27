import { basename, join } from "node:path";
import type { AgentsConfig } from "../../../config/schema.js";
import type { ScopeRoot } from "../../../scope.js";
import { ensureSkillsSymlink } from "../../../symlinks/manager.js";
import { perSkillLinkTargets, skillSymlinkTargets } from "../../../targets/skill-symlinks.js";
import { declaredSkillNames, ensureSkillLinks, isClientOwnedName, managedSkillNames, type SkillLinksResult } from "../../../symlinks/per-skill.js";
import { commandPrefix } from "../../context.js";
import { projectMcpResolver, reconcileMcpConfigs, toMcpDeclarations } from "../../../targets/mcp-writer.js";
import { projectHookResolver, reconcileHookConfigs, toHookDeclarations } from "../../../targets/hook-writer.js";
import { userMcpResolver } from "../../../targets/paths.js";
import {
  projectSubagentResolver,
  reconcileSubagentConfigs,
  userSubagentResolver,
} from "../../../subagents/writer.js";
import { reconcilePluginOutputs } from "../../../plugins/runtime/writer.js";
import { pluginRuntimeLayout } from "../../../plugins/runtime/layout.js";
import type { PluginDeclaration } from "../../../plugins/types.js";
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

/**
 * Links each shared skill for clients that keep their own entries in skills/. Runs after plugin
 * runtime output, because plugin skills projected into the shared directory need links too.
 */
export async function writeSkillLinks(
  config: AgentsConfig,
  scope: ScopeRoot,
): Promise<{ name: string; message: string }[]> {
  const warnings: { name: string; message: string }[] = [];
  for (const target of perSkillLinkTargets(scope, config.agents)) {
    const links = await ensureSkillLinks(scope.agentsDir, target, {
      managedNames: managedSkillNames(config.skills, null),
      declaredNames: declaredSkillNames(config.skills),
      // install does not edit agents.toml, so sharing a client-created skill is left to sync.
      adopt: false,
    });
    warnings.push(...skillLinkWarnings(links, target, scope));
  }
  return warnings;
}

/** Messages for entries ensureSkillLinks set aside or left alone in `<target>/skills/`. */
export function skillLinkWarnings(
  links: Pick<SkillLinksResult, "setAside" | "conflicts" | "stranded">,
  target: string,
  scope: ScopeRoot,
): { name: string; message: string }[] {
  const warnings: { name: string; message: string }[] = [];
  for (const { name, path } of links.setAside) {
    warnings.push({
      name,
      message: `${join(scope.skillsDir, name)} was also in ${join(target, "skills")}, so the shared copy moved to ${path}. Delete it once you no longer need it.`,
    });
  }
  for (const path of links.stranded) {
    warnings.push({
      name: basename(path),
      message: `${path} was left by an interrupted conversion to per-skill links. Move anything you still need from it into the skills directory next to it, then delete it.`,
    });
  }
  for (const name of links.conflicts) {
    warnings.push({
      name,
      message: isClientOwnedName(name)
        ? `${join(scope.skillsDir, name)} uses the name "${name}", which Claude Code reserves in ${join(target, "skills")}, so it is not linked there. If an earlier dotagents sync declared Claude Code's own folder under this name, run '${commandPrefix(scope)} sync' to remove that declaration; otherwise rename the skill.`
        : `${join(target, "skills", name)} is not a link to ${join(scope.skillsDir, name)}, so that client keeps its own copy. Keep one of them, then run '${commandPrefix(scope)} sync'.`,
    });
  }
  return warnings;
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

/** Writes plugin runtime projections for the active scope. */
export async function writePluginRuntime(
  config: AgentsConfig,
  scope: ScopeRoot,
  plugins: PluginDeclaration[],
): Promise<{ agent: string; name: string; message: string }[]> {
  const { result } = await reconcilePluginOutputs(
    config.agents,
    plugins,
    pluginRuntimeLayout(scope),
    { reservedMcpNames: config.mcp.map((server) => server.name) },
  );
  return result.warnings;
}
