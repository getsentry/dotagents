import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isStandardPluginManifest, parsePluginMcp, type PluginManifest } from "../schema.js";
import type { PluginDeclaration } from "../store.js";
import { DOTAGENTS_METADATA, isManagedJsonFile, stableJson, writeJsonIfChanged } from "./files.js";
import {
  manifestString,
  runtimePath,
  titleCase,
} from "./manifest-values.js";
import type { PluginWriteWarning } from "./types.js";
import { isSafeComponentPath } from "./component-paths.js";

type ComponentManifestKey =
  | "skills"
  | "agents"
  | "commands"
  | "rules"
  | "hooks"
  | "mcpServers"
  | "lspServers"
  | "apps"
  | "monitors"
  | "bin";

const COMPONENT_KEYS: ComponentManifestKey[] = [
  "skills",
  "agents",
  "commands",
  "rules",
  "hooks",
  "mcpServers",
  "lspServers",
  "apps",
  "monitors",
  "bin",
];

/** Writes the managed Claude plugin manifest projection when safe to overwrite. */
export async function writeClaudeManifest(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  const filePath = join(plugin.pluginDir, ".claude-plugin", "plugin.json");
  if (existsSync(filePath) && !await isManagedJsonFile(filePath)) {
    warnings.push({
      agent: "claude",
      name: plugin.name,
      message: `Claude plugin manifest exists and is not managed by dotagents: ${filePath}`,
    });
    return false;
  }
  const manifest = claudeRuntimeManifest(plugin, warnings, await validStandardMcp(plugin, warnings, "claude"));
  return writeJsonIfChanged(filePath, stableJson(manifest));
}

/** Writes the managed Cursor plugin manifest projection when safe to overwrite. */
export async function writeCursorManifest(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  const filePath = join(plugin.pluginDir, ".cursor-plugin", "plugin.json");
  if (existsSync(filePath) && !await isManagedJsonFile(filePath)) {
    warnings.push({
      agent: "cursor",
      name: plugin.name,
      message: `Cursor plugin manifest exists and is not managed by dotagents: ${filePath}`,
    });
    return false;
  }
  const manifest = cursorRuntimeManifest(plugin, warnings, await validStandardMcp(plugin, warnings, "cursor"));
  return writeJsonIfChanged(filePath, stableJson(manifest));
}

/** Writes the managed Codex plugin manifest projection when safe to overwrite. */
export async function writeCodexManifest(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  const filePath = join(plugin.pluginDir, ".codex-plugin", "plugin.json");
  if (existsSync(filePath) && !await isManagedJsonFile(filePath)) {
    warnings.push({
      agent: "codex",
      name: plugin.name,
      message: `Codex plugin manifest exists and is not managed by dotagents: ${filePath}`,
    });
    return false;
  }
  const manifest = codexRuntimeManifest(plugin, warnings, await validStandardMcp(plugin, warnings, "codex"));
  return writeJsonIfChanged(filePath, stableJson(manifest));
}

/** Builds the managed Claude manifest projection using Claude-native paths. */
function claudeRuntimeManifest(plugin: PluginDeclaration, warnings: PluginWriteWarning[], standardMcp: boolean): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: plugin.name,
  };
  copyManifestField(plugin.manifest, manifest, "version");
  copyManifestField(plugin.manifest, manifest, "description");
  copyManifestField(plugin.manifest, manifest, "author");
  copyManifestField(plugin.manifest, manifest, "homepage");
  copyManifestField(plugin.manifest, manifest, "repository");
  copyManifestField(plugin.manifest, manifest, "license");
  copyManifestField(plugin.manifest, manifest, "keywords");

  const standard = isStandardPluginManifest(plugin.manifest);

  if ((standard || !copyRuntimeComponentField(plugin, manifest, "skills", warnings)) && existsSync(join(plugin.pluginDir, "skills"))) {
    manifest["skills"] = "./skills";
  }
  if (!standard && !copyRuntimeComponentField(plugin, manifest, "commands", warnings) && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (!standard && !copyRuntimeComponentField(plugin, manifest, "hooks", warnings) && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (standardMcp) {
    manifest["mcpServers"] = "./mcp.json";
  } else if (!standard && !copyRuntimeComponentField(plugin, manifest, "mcpServers", warnings) && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  }
  if (!standard) {
    copyRuntimeComponentField(plugin, manifest, "lspServers", warnings);
    copyRuntimeComponentField(plugin, manifest, "monitors", warnings);
    copyRuntimeComponentField(plugin, manifest, "bin", warnings);
  }
  const metadata = plugin.manifest["metadata"];
  manifest["metadata"] = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
    ...DOTAGENTS_METADATA,
  };
  return manifest;
}

/** Builds the managed Cursor manifest projection using Cursor-native paths. */
function cursorRuntimeManifest(plugin: PluginDeclaration, warnings: PluginWriteWarning[], standardMcp: boolean): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: plugin.name,
  };
  copyManifestField(plugin.manifest, manifest, "version");
  copyManifestField(plugin.manifest, manifest, "description");
  copyManifestField(plugin.manifest, manifest, "author");
  copyManifestField(plugin.manifest, manifest, "homepage");
  copyManifestField(plugin.manifest, manifest, "repository");
  copyManifestField(plugin.manifest, manifest, "license");
  copyManifestField(plugin.manifest, manifest, "keywords");

  const standard = isStandardPluginManifest(plugin.manifest);

  if ((standard || !copyRuntimeComponentField(plugin, manifest, "skills", warnings)) && existsSync(join(plugin.pluginDir, "skills"))) {
    manifest["skills"] = "./skills";
  }
  if (!standard && !copyRuntimeComponentField(plugin, manifest, "agents", warnings) && existsSync(join(plugin.pluginDir, "agents"))) {
    manifest["agents"] = "./agents";
  }
  if (!standard && !copyRuntimeComponentField(plugin, manifest, "commands", warnings) && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (!standard && !copyRuntimeComponentField(plugin, manifest, "rules", warnings) && existsSync(join(plugin.pluginDir, "rules"))) {
    manifest["rules"] = "./rules";
  }
  if (!standard && !copyRuntimeComponentField(plugin, manifest, "hooks", warnings) && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  const hasExplicitMcpServers = !standard && copyRuntimeComponentField(plugin, manifest, "mcpServers", warnings);
  if (standardMcp) {
    manifest["mcpServers"] = "./mcp.json";
  } else if (!hasExplicitMcpServers && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  } else if (!hasExplicitMcpServers && existsSync(join(plugin.pluginDir, "mcp.json"))) {
    manifest["mcpServers"] = "./mcp.json";
  }
  if (!standard) {copyRuntimeComponentField(plugin, manifest, "bin", warnings);}
  const metadata = plugin.manifest["metadata"];
  manifest["metadata"] = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
    ...DOTAGENTS_METADATA,
  };
  return manifest;
}

/** Builds the managed Codex manifest projection and stamps dotagents ownership metadata. */
function codexRuntimeManifest(plugin: PluginDeclaration, warnings: PluginWriteWarning[], standardMcp: boolean): Record<string, unknown> {
  const standard = isStandardPluginManifest(plugin.manifest);
  const manifest: Record<string, unknown> = standard ? { name: plugin.name } : { ...plugin.manifest, name: plugin.name };
  if (standard) {
    copyManifestField(plugin.manifest, manifest, "version");
    copyManifestField(plugin.manifest, manifest, "description");
    copyManifestField(plugin.manifest, manifest, "author");
    copyManifestField(plugin.manifest, manifest, "homepage");
    copyManifestField(plugin.manifest, manifest, "repository");
    copyManifestField(plugin.manifest, manifest, "license");
    copyManifestField(plugin.manifest, manifest, "keywords");
  }
  for (const key of COMPONENT_KEYS) {
    delete manifest[key];
    if (!standard) {copyRuntimeComponentField(plugin, manifest, key, warnings);}
  }

  if ((standard || plugin.manifest["skills"] === undefined) && !manifest["skills"] && existsSync(join(plugin.pluginDir, "skills"))) {
    manifest["skills"] = "./skills";
  }
  if (!standard && plugin.manifest["agents"] === undefined && !manifest["agents"] && existsSync(join(plugin.pluginDir, "agents"))) {
    manifest["agents"] = "./agents";
  }
  if (!standard && plugin.manifest["commands"] === undefined && !manifest["commands"] && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (!standard && plugin.manifest["hooks"] === undefined && !manifest["hooks"] && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (standardMcp) {
    manifest["mcpServers"] = "./mcp.json";
  } else if (plugin.manifest["mcpServers"] === undefined && !manifest["mcpServers"] && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  }
  if (!standard && plugin.manifest["lspServers"] === undefined && !manifest["lspServers"] && existsSync(join(plugin.pluginDir, ".lsp.json"))) {
    manifest["lspServers"] = "./.lsp.json";
  }
  if (!standard && plugin.manifest["apps"] === undefined && !manifest["apps"] && existsSync(join(plugin.pluginDir, ".app.json"))) {
    manifest["apps"] = "./.app.json";
  }
  if (!manifest["interface"]) {
    manifest["interface"] = codexInterface(plugin);
  }
  const metadata = manifest["metadata"];
  manifest["metadata"] = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
    ...DOTAGENTS_METADATA,
  };
  return manifest;
}

async function validStandardMcp(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
  agent: string,
): Promise<boolean> {
  if (!isStandardPluginManifest(plugin.manifest)) {return false;}
  const filePath = join(plugin.pluginDir, "mcp.json");
  if (!existsSync(filePath)) {return false;}
  try {
    parsePluginMcp(JSON.parse(await readFile(filePath, "utf-8")), filePath);
    return true;
  } catch (err) {
    warnings.push({
      agent,
      name: plugin.name,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function codexInterface(plugin: PluginDeclaration): Record<string, unknown> {
  return {
    displayName: titleCase(plugin.name),
    shortDescription: manifestString(plugin.manifest, "description") ?? "",
    developerName: developerName(plugin.manifest),
    category: manifestString(plugin.manifest, "category") ?? "Coding",
    capabilities: ["Interactive", "Write"],
  };
}

function developerName(manifest: PluginManifest): string {
  const author = manifest.author;
  if (author && typeof author.name === "string") {return author.name;}
  return "Unknown";
}

function copyManifestField(source: PluginManifest, dest: Record<string, unknown>, key: keyof PluginManifest): void {
  if (source[key] !== undefined) {
    dest[key] = source[key];
  }
}

function copyRuntimeComponentField(
  plugin: PluginDeclaration,
  dest: Record<string, unknown>,
  key: ComponentManifestKey,
  warnings: PluginWriteWarning[],
): boolean {
  const value = plugin.manifest[key];
  if (typeof value === "string") {
    if (isSafeComponentPath(value)) {
      dest[key] = runtimePath(value);
    } else {
      warnUnsafeComponentPath(plugin, key, value, warnings);
    }
    return true;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const paths = value.flatMap((item) => {
      if (isSafeComponentPath(item)) {return [runtimePath(item)];}
      warnUnsafeComponentPath(plugin, key, item, warnings);
      return [];
    });
    if (paths.length > 0) {dest[key] = paths;}
    return true;
  }
  return false;
}

function warnUnsafeComponentPath(
  plugin: PluginDeclaration,
  key: ComponentManifestKey,
  value: string,
  warnings: PluginWriteWarning[],
): void {
  warnings.push({
    agent: "plugin",
    name: plugin.name,
    message: `Plugin component path "${value}" for "${String(key)}" is not a safe relative path and was skipped.`,
  });
}
