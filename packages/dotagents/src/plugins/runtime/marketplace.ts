import { dirname, join } from "node:path";
import type { PluginDeclaration } from "../store.js";
import { selectedAgentIds } from "../targets.js";
import { DOTAGENTS_METADATA, stableJson } from "./files.js";
import { manifestString, relativePath } from "./manifest-values.js";
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
      content: stableJson(pathMarketplace(filePath, "dotagents", claudePlugins)),
    });
  }
  if (cursorPlugins.length > 0) {
    const filePath = join(projectRoot, ".cursor-plugin", "marketplace.json");
    outputs.push({
      agent: "cursor",
      filePath,
      content: stableJson(pathMarketplace(filePath, "dotagents", cursorPlugins)),
    });
  }
  if (codexPlugins.length > 0) {
    const filePath = join(projectRoot, ".agents", "plugins", "marketplace.json");
    outputs.push({
      agent: "codex",
      filePath,
      content: stableJson(codexMarketplace(filePath, "dotagents-local", codexPlugins)),
    });
  }

  return outputs;
}

function pathMarketplace(
  marketplaceFile: string,
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
      .map((plugin) => pathMarketplaceEntry(marketplaceFile, plugin)),
  };
}

/**
 * Claude and Cursor marketplace projections use path strings instead of Codex's
 * structured local source objects, so keep this projection format separate.
 */
function pathMarketplaceEntry(
  marketplaceFile: string,
  plugin: PluginDeclaration,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: plugin.name,
    source: relativePath(dirname(marketplaceFile), plugin.pluginDir),
  };
  const description = manifestString(plugin.manifest, "description");
  if (description) {entry["description"] = description;}
  const version = manifestString(plugin.manifest, "version");
  if (version) {entry["version"] = version;}
  return entry;
}

function codexMarketplace(
  marketplaceFile: string,
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
      .map((plugin) => codexMarketplaceEntry(marketplaceFile, plugin)),
  };
}

function codexMarketplaceEntry(
  marketplaceFile: string,
  plugin: PluginDeclaration,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    category: manifestString(plugin.manifest, "category") ?? "Productivity",
    name: plugin.name,
    source: {
      path: relativePath(dirname(marketplaceFile), plugin.pluginDir),
      source: "local",
    },
  };
  const description = manifestString(plugin.manifest, "description");
  if (description) {entry["description"] = description;}
  const version = manifestString(plugin.manifest, "version");
  if (version) {entry["version"] = version;}
  return entry;
}
