import type { PluginDeclaration } from "./store.js";
import type { PluginWriteWarning } from "./runtime/types.js";
import { isStandardPluginManifest } from "./schema.js";

const PLUGIN_ONLY_AGENT_IDS = ["grok", "pi"];
const PLUGIN_AGENT_IDS = ["claude", "cursor", "codex", "grok", "opencode", "pi"];
const SUPPORTED_PLUGIN_AGENT_IDS = new Set(allPluginAgentIds());

/** Returns agent IDs accepted in agents.toml only for plugin runtime output. */
export function allPluginOnlyAgentIds(): string[] {
  return PLUGIN_ONLY_AGENT_IDS;
}

function allPluginAgentIds(): string[] {
  return PLUGIN_AGENT_IDS;
}

export function selectPlugins(agentIds: string[], plugins: PluginDeclaration[]): PluginDeclaration[] {
  return plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).length > 0);
}

/** Resolves configured agent ids that should receive outputs for a plugin. */
export function selectedAgentIds(
  agentIds: string[],
  plugin: Pick<PluginDeclaration, "targets">,
): string[] {
  const targets = plugin.targets && plugin.targets.length > 0
    ? plugin.targets
    : agentIds;
  const configured = new Set(agentIds);
  return [...new Set(targets)]
    .filter((target) => configured.has(target))
    .filter((target) => SUPPORTED_PLUGIN_AGENT_IDS.has(target));
}

export function usesLegacyPluginComponents(
  plugin: Pick<PluginDeclaration, "manifest" | "nativeSource">,
  target: string,
): boolean {
  if (isStandardPluginManifest(plugin.manifest)) {return false;}
  return plugin.nativeSource === undefined || plugin.nativeSource === target;
}

/** Reports plugin target declarations that cannot produce runtime outputs. */
export function targetWarnings(
  agentIds: string[],
  plugins: PluginDeclaration[],
): PluginWriteWarning[] {
  const configured = new Set(agentIds);
  const warnings: PluginWriteWarning[] = [];
  for (const plugin of plugins) {
    const targets = plugin.targets && plugin.targets.length > 0
      ? plugin.targets
      : agentIds;
    for (const target of new Set(targets)) {
      if (!configured.has(target)) {
        warnings.push({
          agent: target,
          name: plugin.name,
          message: `Plugin "${plugin.name}" targets "${target}", but "${target}" is not listed in agents.`,
        });
        continue;
      }
      if (!SUPPORTED_PLUGIN_AGENT_IDS.has(target)) {
        warnings.push({
          agent: target,
          name: plugin.name,
          message: `Plugin "${plugin.name}" targets "${target}", but "${target}" does not support plugin outputs.`,
        });
      }
    }
  }
  return warnings;
}
