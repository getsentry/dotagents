import type { NativePluginSource, PluginDeclaration } from "./types.js";
import type { PluginWriteWarning } from "./runtime/types.js";
import { isStandardPluginManifest } from "./schema.js";
import { isSerializedObject, type SerializedValue } from "@sentry/dotagents-lib";
import { isString } from "../utils/type-guards.js";

const PLUGIN_ONLY_AGENT_IDS = ["grok", "pi"];
const PLUGIN_AGENT_IDS = ["claude", "cursor", "codex", "grok", "opencode", "pi"];
const SUPPORTED_PLUGIN_AGENT_IDS = new Set(allPluginAgentIds());
const GENERATED_NATIVE_FIELDS = {
  claude: new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills"]),
  cursor: new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills"]),
  codex: new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "skills"]),
} satisfies Record<NativePluginSource, ReadonlySet<string>>;

/** Returns agent IDs accepted in agents.toml only for plugin runtime output. */
export function allPluginOnlyAgentIds(): string[] {
  return PLUGIN_ONLY_AGENT_IDS;
}

export function allPluginAgentIds(): string[] {
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

/** Returns whether a native manifest contains behavior the target adapter cannot generate from the portable core. */
export function nativeInterfaceNeedsFallback(
  source: NativePluginSource,
  value: SerializedValue,
): boolean {
  if (!isSerializedObject(value)) {return false;}
  for (const [key, field] of Object.entries(value)) {
    if (!GENERATED_NATIVE_FIELDS[source].has(key)) {return true;}
    if (key === "skills" && !isConventionalSkillsReference(field)) {return true;}
  }
  return false;
}

function isConventionalSkillsReference(value: SerializedValue | undefined): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.length === 1 && isString(values[0]) &&
    values[0].replace(/^\.\//, "").replace(/\/$/, "") === "skills";
}

/** Keeps native legacy components with their owning client while generalized legacy bundles remain portable. */
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
