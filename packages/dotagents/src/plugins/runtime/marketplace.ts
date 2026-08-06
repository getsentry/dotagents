import { join, relative } from "node:path";
import type { PluginDeclaration } from "../store.js";
import { selectedAgentIds } from "../targets.js";
import { DOTAGENTS_METADATA, stableJson } from "./files.js";
import { manifestString } from "./manifest-values.js";
import type { RuntimeOutput } from "./types.js";

/** Lists managed plugin marketplace files that may be generated or pruned. */
export function marketplaceOutputPaths(projectRoot: string): string[] {
  return [
    join(projectRoot, ".agents", "plugins", "marketplace.json"),
    join(projectRoot, ".claude-plugin", "marketplace.json"),
    join(projectRoot, ".cursor-plugin", "marketplace.json"),
  ];
}

/** Builds target-specific marketplace JSON outputs for selected plugins. */
export function marketplaceOutputs(
  agentIds: string[],
  projectRoot: string,
  plugins: PluginDeclaration[],
): RuntimeOutput[] {
  if (plugins.length === 0) {return [];}

  const outputs: RuntimeOutput[] = [];
  const claudePlugins = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes("claude"));
  const cursorPlugins = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes("cursor"));
  const codexPlugins = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes("codex"));

  if (claudePlugins.length > 0) {
    const filePath = join(projectRoot, ".claude-plugin", "marketplace.json");
    outputs.push({
      agent: "claude",
      filePath,
      content: stableJson(pathMarketplace(projectRoot, "dotagents", claudePlugins)),
    });
  }
  if (cursorPlugins.length > 0) {
    const filePath = join(projectRoot, ".cursor-plugin", "marketplace.json");
    outputs.push({
      agent: "cursor",
      filePath,
      content: stableJson(pathMarketplace(projectRoot, "dotagents", cursorPlugins)),
    });
  }
  if (codexPlugins.length > 0) {
    const filePath = join(projectRoot, ".agents", "plugins", "marketplace.json");
    outputs.push({
      agent: "codex",
      filePath,
      content: stableJson(codexMarketplace(projectRoot, "dotagents-local", codexPlugins)),
    });
  }

  return outputs;
}

function pathMarketplace(
  projectRoot: string,
  name: string,
  plugins: PluginDeclaration[],
): Record<string, unknown> {
  return {
    name,
    owner: {
      name: "dotagents",
    },
    metadata: DOTAGENTS_METADATA,
    plugins: plugins
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((plugin) => pathMarketplaceEntry(projectRoot, plugin)),
  };
}

/**
 * Claude and Cursor marketplace projections use path strings instead of Codex's
 * structured local source objects, so keep this projection format separate.
 */
function pathMarketplaceEntry(
  projectRoot: string,
  plugin: PluginDeclaration,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: plugin.name,
    source: `./${relative(projectRoot, plugin.pluginDir).split("\\").join("/")}`,
  };
  const description = manifestString(plugin.manifest, "description");
  if (description) {entry["description"] = description;}
  const version = manifestString(plugin.manifest, "version");
  if (version) {entry["version"] = version;}
  return entry;
}

function codexMarketplace(
  projectRoot: string,
  name: string,
  plugins: PluginDeclaration[],
): Record<string, unknown> {
  return {
    interface: {
      displayName: "Dotagents Plugins",
    },
    metadata: DOTAGENTS_METADATA,
    name,
    owner: {
      name: "dotagents",
    },
    plugins: plugins
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((plugin) => codexMarketplaceEntry(projectRoot, plugin)),
  };
}

function codexMarketplaceEntry(
  projectRoot: string,
  plugin: PluginDeclaration,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    category: manifestString(plugin.manifest, "category") ?? "Productivity",
    name: plugin.name,
    policy: {
      authentication: "ON_INSTALL",
      installation: "AVAILABLE",
    },
    source: {
      path: `./${relative(projectRoot, plugin.pluginDir).split("\\").join("/")}`,
      source: "local",
    },
  };
  const description = manifestString(plugin.manifest, "description");
  if (description) {entry["description"] = description;}
  const version = manifestString(plugin.manifest, "version");
  if (version) {entry["version"] = version;}
  return entry;
}
