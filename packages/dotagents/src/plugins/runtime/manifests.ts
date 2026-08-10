import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isStandardPluginManifest, parsePluginMcpBestEffort, type LegacyPluginManifest, type PluginManifest, type PluginMcpConfig } from "../schema.js";
import type { PluginDeclaration } from "../types.js";
import { usesLegacyPluginComponents } from "../targets.js";
import { isManagedJsonFile, removeManagedJsonFile, stableJson, writeManagedJsonIfChanged } from "../managed-files.js";
import {
  manifestString,
  legacyManifestString,
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

type ManifestAgent = "claude" | "cursor" | "codex";

export const NATIVE_PLUGIN_MANIFEST_TARGETS: ReadonlyArray<{
  agent: ManifestAgent;
  label: string;
  dir: string;
}> = [
  { agent: "claude", label: "Claude", dir: ".claude-plugin" },
  { agent: "cursor", label: "Cursor", dir: ".cursor-plugin" },
  { agent: "codex", label: "Codex", dir: ".codex-plugin" },
];

export async function writePluginManifests(
  plugin: PluginDeclaration,
  agents: string[],
  warnings: PluginWriteWarning[],
  standardMcp: LoadedStandardMcp,
): Promise<number> {
  const portableSkills = (isStandardPluginManifest(plugin.manifest) || plugin.nativeSource !== undefined) &&
    await isDirectory(join(plugin.pluginDir, "skills"));
  let written = 0;
  for (const spec of NATIVE_PLUGIN_MANIFEST_TARGETS) {
    if (!agents.includes(spec.agent)) {continue;}
    const filePath = join(plugin.pluginDir, spec.dir, "plugin.json");
    if (existsSync(filePath) && plugin.nativeSource === spec.agent) {continue;}
    if (existsSync(filePath) && !await isManagedJsonFile(filePath)) {
      warnings.push({
        agent: spec.agent,
        name: plugin.name,
        message: `${spec.label} plugin manifest exists and is not managed by dotagents: ${filePath}`,
      });
      continue;
    }
    let mcpPath: string | undefined;
    const adapterMcpPath = join(plugin.pluginDir, spec.dir, "mcp.json");
    if (standardMcp.config) {
      if (standardMcp.issues.length === 0) {
        mcpPath = "./mcp.json";
        if (await isManagedJsonFile(adapterMcpPath)) {await removeManagedJsonFile(adapterMcpPath);}
      } else if (Object.keys(standardMcp.config.mcpServers).length > 0) {
        if (existsSync(adapterMcpPath) && !await isManagedJsonFile(adapterMcpPath)) {
          warnings.push({
            agent: spec.agent,
            name: plugin.name,
            message: `${spec.label} plugin MCP adapter exists and is not managed by dotagents: ${adapterMcpPath}`,
          });
        } else {
          if (await writeManagedJsonIfChanged(adapterMcpPath, stableJson(standardMcp.config))) {written++;}
          mcpPath = `./${spec.dir}/mcp.json`;
        }
      }
    } else if (await isManagedJsonFile(adapterMcpPath)) {
      await removeManagedJsonFile(adapterMcpPath);
    }
    if (!mcpPath && await isManagedJsonFile(adapterMcpPath)) {
      await removeManagedJsonFile(adapterMcpPath);
    }
    const manifest = spec.agent === "claude"
      ? claudeRuntimeManifest(plugin, warnings, mcpPath, portableSkills)
      : spec.agent === "cursor"
        ? cursorRuntimeManifest(plugin, warnings, mcpPath, portableSkills)
        : codexRuntimeManifest(plugin, warnings, mcpPath, portableSkills);
    if (await writeManagedJsonIfChanged(filePath, stableJson(manifest))) {written++;}
  }
  return written;
}

function claudeRuntimeManifest(plugin: PluginDeclaration, warnings: PluginWriteWarning[], standardMcpPath: string | undefined, portableSkills: boolean): Record<string, unknown> {
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

  const legacyComponents = usesLegacyPluginComponents(plugin, "claude");

  const hasExplicitSkills = legacyComponents && copyRuntimeComponentField(plugin, manifest, "skills", warnings);
  if (!hasExplicitSkills && (portableSkills || legacyComponents && existsSync(join(plugin.pluginDir, "skills")))) {
    manifest["skills"] = "./skills";
  }
  if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "commands", warnings) && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "hooks", warnings) && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (standardMcpPath) {
    manifest["mcpServers"] = standardMcpPath;
  } else if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "mcpServers", warnings) && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  }
  if (legacyComponents) {
    copyRuntimeComponentField(plugin, manifest, "lspServers", warnings);
    copyRuntimeComponentField(plugin, manifest, "monitors", warnings);
    copyRuntimeComponentField(plugin, manifest, "bin", warnings);
  }
  return manifest;
}

function cursorRuntimeManifest(plugin: PluginDeclaration, warnings: PluginWriteWarning[], standardMcpPath: string | undefined, portableSkills: boolean): Record<string, unknown> {
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

  const legacyComponents = usesLegacyPluginComponents(plugin, "cursor");

  const hasExplicitSkills = legacyComponents && copyRuntimeComponentField(plugin, manifest, "skills", warnings);
  if (!hasExplicitSkills && (portableSkills || legacyComponents && existsSync(join(plugin.pluginDir, "skills")))) {
    manifest["skills"] = "./skills";
  }
  if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "agents", warnings) && existsSync(join(plugin.pluginDir, "agents"))) {
    manifest["agents"] = "./agents";
  }
  if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "commands", warnings) && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "rules", warnings) && existsSync(join(plugin.pluginDir, "rules"))) {
    manifest["rules"] = "./rules";
  }
  if (legacyComponents && !copyRuntimeComponentField(plugin, manifest, "hooks", warnings) && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  const hasExplicitMcpServers = legacyComponents && copyRuntimeComponentField(plugin, manifest, "mcpServers", warnings);
  if (standardMcpPath) {
    manifest["mcpServers"] = standardMcpPath;
  } else if (legacyComponents && !hasExplicitMcpServers && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  } else if (legacyComponents && !hasExplicitMcpServers && existsSync(join(plugin.pluginDir, "mcp.json"))) {
    manifest["mcpServers"] = "./mcp.json";
  }
  if (legacyComponents) {copyRuntimeComponentField(plugin, manifest, "bin", warnings);}
  return manifest;
}

function codexRuntimeManifest(plugin: PluginDeclaration, warnings: PluginWriteWarning[], standardMcpPath: string | undefined, portableSkills: boolean): Record<string, unknown> {
  const standard = isStandardPluginManifest(plugin.manifest);
  const legacyComponents = usesLegacyPluginComponents(plugin, "codex");
  const legacy = legacyComponents ? plugin.manifest as LegacyPluginManifest : undefined;
  const manifest: Record<string, unknown> = standard || !legacyComponents ? { name: plugin.name } : { ...plugin.manifest, name: plugin.name };
  if (standard || !legacyComponents) {
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
    if (legacyComponents) {copyRuntimeComponentField(plugin, manifest, key, warnings);}
  }

  if ((portableSkills || legacy !== undefined && legacy.skills === undefined && existsSync(join(plugin.pluginDir, "skills"))) && !manifest["skills"]) {
    manifest["skills"] = "./skills";
  }
  if (legacy && legacy.agents === undefined && !manifest["agents"] && existsSync(join(plugin.pluginDir, "agents"))) {
    manifest["agents"] = "./agents";
  }
  if (legacy && legacy.commands === undefined && !manifest["commands"] && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (legacy && legacy.hooks === undefined && !manifest["hooks"] && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (standardMcpPath) {
    manifest["mcpServers"] = standardMcpPath;
  } else if (legacy && legacy.mcpServers === undefined && !manifest["mcpServers"] && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  }
  if (legacy && legacy.lspServers === undefined && !manifest["lspServers"] && existsSync(join(plugin.pluginDir, ".lsp.json"))) {
    manifest["lspServers"] = "./.lsp.json";
  }
  if (legacy && legacy.apps === undefined && !manifest["apps"] && existsSync(join(plugin.pluginDir, ".app.json"))) {
    manifest["apps"] = "./.app.json";
  }
  if (!manifest["interface"]) {
    manifest["interface"] = codexInterface(plugin);
  }
  return manifest;
}

export interface LoadedStandardMcp {
  config?: PluginMcpConfig;
  issues: string[];
}

export async function loadStandardMcp(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<LoadedStandardMcp> {
  if (!isStandardPluginManifest(plugin.manifest)) {return { issues: [] };}
  const filePath = join(plugin.pluginDir, "mcp.json");
  if (!existsSync(filePath)) {return { issues: [] };}
  try {
    const parsed = parsePluginMcpBestEffort(JSON.parse(await readFile(filePath, "utf-8")), filePath);
    for (const issue of parsed.issues) {
      warnings.push({ agent: "plugin", name: plugin.name, message: issue });
    }
    return parsed;
  } catch (err) {
    warnings.push({
      agent: "plugin",
      name: plugin.name,
      message: err instanceof Error ? err.message : String(err),
    });
    return { issues: [] };
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function codexInterface(plugin: PluginDeclaration): Record<string, unknown> {
  return {
    displayName: titleCase(plugin.name),
    shortDescription: manifestString(plugin.manifest, "description") ?? "",
    developerName: developerName(plugin.manifest),
    category: legacyManifestString(plugin.manifest, "category") ?? "Coding",
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
  const value = (plugin.manifest as LegacyPluginManifest)[key];
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
