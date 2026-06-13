import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import type { PluginDeclaration } from "./plugin-store.js";
import type { PluginManifest } from "./plugin-schema.js";
import { allPluginAgentIds } from "./registry.js";

// Owns deterministic runtime plugin projections. Existing runtime artifacts are
// overwritten only when they carry dotagents managed metadata or a managed marker.
const DOTAGENTS_METADATA = { managedBy: "dotagents" };
const SUPPORTED_PLUGIN_AGENT_IDS = new Set(allPluginAgentIds());

export interface PluginWriteWarning {
  agent: string;
  name: string;
  message: string;
}

export interface PluginWriteResult {
  warnings: PluginWriteWarning[];
  written: number;
}

export interface PluginVerifyIssue {
  agent: string;
  name: string;
  issue: string;
}

interface RuntimeOutput {
  agent: string;
  filePath: string;
  content: string;
}

/** Writes deterministic project-scope plugin runtime artifacts for selected agents. */
export async function writePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
): Promise<PluginWriteResult> {
  const warnings: PluginWriteWarning[] = [];
  let written = 0;
  const selected = selectPlugins(agentIds, plugins);

  for (const warning of targetWarnings(agentIds, plugins)) {
    warnings.push(warning);
  }

  for (const output of marketplaceOutputs(agentIds, projectRoot, selected)) {
    if (await writeManagedJsonOutput(output, warnings)) {written++;}
  }

  for (const plugin of selected) {
    const agents = selectedAgentIds(agentIds, plugin);
    if (agents.includes("claude") && await writeClaudeManifest(plugin, warnings)) {
      written++;
    }
    if (agents.includes("cursor") && await writeCursorManifest(plugin, warnings)) {
      written++;
    }
    if (agents.includes("codex") && await writeCodexManifest(plugin, warnings)) {
      written++;
    }
    if (agents.includes("grok") && await writeGrokProjection(projectRoot, plugin, warnings)) {
      written++;
    }
    if (agents.includes("opencode")) {
      written += await writeOpenCodeProjection(projectRoot, plugin, warnings);
    }
  }

  return { warnings, written };
}

/** Verifies that generated plugin runtime artifacts match the current declarations. */
export async function verifyPluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
): Promise<PluginVerifyIssue[]> {
  const issues: PluginVerifyIssue[] = [];
  const selected = selectPlugins(agentIds, plugins);

  for (const output of marketplaceOutputs(agentIds, projectRoot, selected)) {
    if (!existsSync(output.filePath)) {
      issues.push({ agent: output.agent, name: "marketplace", issue: `Plugin marketplace missing: ${output.filePath}` });
      continue;
    }
    try {
      const existing = await readFile(output.filePath, "utf-8");
      if (existing !== output.content) {
        issues.push({ agent: output.agent, name: "marketplace", issue: `Plugin marketplace out of date: ${output.filePath}` });
      }
    } catch {
      issues.push({ agent: output.agent, name: "marketplace", issue: `Failed to read plugin marketplace: ${output.filePath}` });
    }
  }

  for (const plugin of selected) {
    const agents = selectedAgentIds(agentIds, plugin);
    if (agents.includes("claude")) {
      const filePath = join(plugin.pluginDir, ".claude-plugin", "plugin.json");
      if (!existsSync(filePath)) {
        issues.push({ agent: "claude", name: plugin.name, issue: `Claude plugin manifest missing: ${filePath}` });
      }
    }
    if (agents.includes("cursor")) {
      const filePath = join(plugin.pluginDir, ".cursor-plugin", "plugin.json");
      if (!existsSync(filePath)) {
        issues.push({ agent: "cursor", name: plugin.name, issue: `Cursor plugin manifest missing: ${filePath}` });
      }
    }
    if (agents.includes("codex")) {
      const filePath = join(plugin.pluginDir, ".codex-plugin", "plugin.json");
      if (!existsSync(filePath)) {
        issues.push({ agent: "codex", name: plugin.name, issue: `Codex plugin manifest missing: ${filePath}` });
      }
    }
    if (agents.includes("grok")) {
      const filePath = join(projectRoot, ".grok", "plugins", plugin.name);
      if (!existsSync(filePath)) {
        issues.push({ agent: "grok", name: plugin.name, issue: `Grok plugin projection missing: ${filePath}` });
      }
    }
  }

  return issues;
}

/** Removes stale dotagents-managed plugin runtime artifacts. */
export async function prunePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
): Promise<string[]> {
  const pruned: string[] = [];
  const desiredMarketplacePaths = new Set(
    marketplaceOutputsForTargets(agentIds, projectRoot, plugins).map((output) => output.filePath),
  );
  for (const filePath of marketplaceOutputPaths(projectRoot)) {
    if (desiredMarketplacePaths.has(filePath)) {continue;}
    if (!existsSync(filePath)) {continue;}
    if (!await isManagedJsonFile(filePath)) {continue;}
    await rm(filePath, { force: true });
    pruned.push(filePath);
  }

  const desiredGrok = new Set(
    plugins
      .filter((plugin) => selectedAgentIds(agentIds, plugin).includes("grok"))
      .map((plugin) => plugin.name),
  );
  const grokDir = join(projectRoot, ".grok", "plugins");
  if (existsSync(grokDir)) {
    const entries = await readdir(grokDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {continue;}
      if (desiredGrok.has(entry.name)) {continue;}
      const path = join(grokDir, entry.name);
      if (!await isManagedProjection(path)) {continue;}
      await rm(path, { recursive: true, force: true });
      pruned.push(path);
    }
  }

  const desiredOpenCode = new Set(
    plugins
      .filter((plugin) => selectedAgentIds(agentIds, plugin).includes("opencode"))
      .flatMap((plugin) => opencodeModules(plugin).map((modulePath) => `${plugin.name}${extname(modulePath)}`)),
  );
  const opencodeDir = join(projectRoot, ".opencode", "plugins");
  if (existsSync(opencodeDir)) {
    const entries = await readdir(opencodeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {continue;}
      if (desiredOpenCode.has(entry.name)) {continue;}
      const path = join(opencodeDir, entry.name);
      if (!await isManagedOpenCodeModule(path)) {continue;}
      await rm(path, { force: true });
      pruned.push(path);
    }
  }

  const canonicalPluginDir = join(projectRoot, ".agents", "plugins");
  const desiredClaude = new Set(
    plugins
      .filter((plugin) => selectedAgentIds(agentIds, plugin).includes("claude"))
      .map((plugin) => plugin.name),
  );
  if (existsSync(canonicalPluginDir)) {
    const entries = await readdir(canonicalPluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      if (desiredClaude.has(entry.name)) {continue;}
      const path = join(canonicalPluginDir, entry.name, ".claude-plugin", "plugin.json");
      if (!existsSync(path) || !await isManagedJsonFile(path)) {continue;}
      await rm(path, { force: true });
      await rmdirIfEmpty(dirname(path));
      pruned.push(path);
    }
  }

  const desiredCursor = new Set(
    plugins
      .filter((plugin) => selectedAgentIds(agentIds, plugin).includes("cursor"))
      .map((plugin) => plugin.name),
  );
  if (existsSync(canonicalPluginDir)) {
    const entries = await readdir(canonicalPluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      if (desiredCursor.has(entry.name)) {continue;}
      const path = join(canonicalPluginDir, entry.name, ".cursor-plugin", "plugin.json");
      if (!existsSync(path) || !await isManagedJsonFile(path)) {continue;}
      await rm(path, { force: true });
      await rmdirIfEmpty(dirname(path));
      pruned.push(path);
    }
  }

  const desiredCodex = new Set(
    plugins
      .filter((plugin) => selectedAgentIds(agentIds, plugin).includes("codex"))
      .map((plugin) => plugin.name),
  );
  if (existsSync(canonicalPluginDir)) {
    const entries = await readdir(canonicalPluginDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      if (desiredCodex.has(entry.name)) {continue;}
      const path = join(canonicalPluginDir, entry.name, ".codex-plugin", "plugin.json");
      if (!existsSync(path) || !await isManagedJsonFile(path)) {continue;}
      await rm(path, { force: true });
      await rmdirIfEmpty(dirname(path));
      pruned.push(path);
    }
  }

  return pruned;
}

function marketplaceOutputPaths(projectRoot: string): string[] {
  return [
    join(projectRoot, ".agents", "plugins", "marketplace.json"),
    join(projectRoot, ".claude-plugin", "marketplace.json"),
    join(projectRoot, ".cursor-plugin", "marketplace.json"),
  ];
}

function marketplaceOutputs(
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
    outputs.push({
      agent: "claude",
      filePath: join(projectRoot, ".claude-plugin", "marketplace.json"),
      content: stableJson(pathMarketplace(projectRoot, "dotagents", claudePlugins)),
    });
  }
  if (cursorPlugins.length > 0) {
    outputs.push({
      agent: "cursor",
      filePath: join(projectRoot, ".cursor-plugin", "marketplace.json"),
      content: stableJson(pathMarketplace(projectRoot, "dotagents", cursorPlugins)),
    });
  }
  if (codexPlugins.length > 0) {
    outputs.push({
      agent: "codex",
      filePath: join(projectRoot, ".agents", "plugins", "marketplace.json"),
      content: stableJson(codexMarketplace(projectRoot, "dotagents-local", codexPlugins)),
    });
  }

  return outputs;
}

function marketplaceOutputsForTargets(
  agentIds: string[],
  projectRoot: string,
  plugins: Array<Pick<PluginDeclaration, "name" | "targets">>,
): RuntimeOutput[] {
  if (plugins.length === 0) {return [];}

  const outputs: RuntimeOutput[] = [];
  const hasClaude = plugins.some((plugin) => selectedAgentIds(agentIds, plugin).includes("claude"));
  const hasCursor = plugins.some((plugin) => selectedAgentIds(agentIds, plugin).includes("cursor"));
  const hasCodex = plugins.some((plugin) => selectedAgentIds(agentIds, plugin).includes("codex"));

  if (hasClaude) {
    outputs.push({ agent: "claude", filePath: join(projectRoot, ".claude-plugin", "marketplace.json"), content: "" });
  }
  if (hasCursor) {
    outputs.push({ agent: "cursor", filePath: join(projectRoot, ".cursor-plugin", "marketplace.json"), content: "" });
  }
  if (hasCodex) {
    outputs.push({ agent: "codex", filePath: join(projectRoot, ".agents", "plugins", "marketplace.json"), content: "" });
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
    source: `./${relativePath(projectRoot, plugin.pluginDir)}`,
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
    source: {
      path: `./${relativePath(projectRoot, plugin.pluginDir)}`,
      source: "local",
    },
  };
  const description = manifestString(plugin.manifest, "description");
  if (description) {entry["description"] = description;}
  const version = manifestString(plugin.manifest, "version");
  if (version) {entry["version"] = version;}
  return entry;
}

async function writeClaudeManifest(
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
  const manifest = claudeRuntimeManifest(plugin);
  return writeJsonIfChanged(filePath, stableJson(manifest));
}

async function writeCursorManifest(
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
  const manifest = cursorRuntimeManifest(plugin);
  return writeJsonIfChanged(filePath, stableJson(manifest));
}

async function writeCodexManifest(
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
  const manifest = codexRuntimeManifest(plugin);
  return writeJsonIfChanged(filePath, stableJson(manifest));
}

/** Builds the managed Claude manifest projection using Claude-native paths. */
function claudeRuntimeManifest(plugin: PluginDeclaration): Record<string, unknown> {
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

  if (existsSync(join(plugin.pluginDir, "skills"))) {
    manifest["skills"] = "./skills";
  }
  if (existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  }
  const metadata = plugin.manifest["metadata"];
  manifest["metadata"] = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
    ...DOTAGENTS_METADATA,
  };
  return manifest;
}

/** Builds the managed Cursor manifest projection using Cursor-native paths. */
function cursorRuntimeManifest(plugin: PluginDeclaration): Record<string, unknown> {
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

  if (existsSync(join(plugin.pluginDir, "skills"))) {
    manifest["skills"] = "./skills";
  }
  if (existsSync(join(plugin.pluginDir, "agents"))) {
    manifest["agents"] = "./agents";
  }
  if (existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (existsSync(join(plugin.pluginDir, "rules"))) {
    manifest["rules"] = "./rules";
  }
  if (existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  } else if (existsSync(join(plugin.pluginDir, "mcp.json"))) {
    manifest["mcpServers"] = "./mcp.json";
  }
  const metadata = plugin.manifest["metadata"];
  manifest["metadata"] = {
    ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
    ...DOTAGENTS_METADATA,
  };
  return manifest;
}

/** Mirrors a plugin bundle into Grok's plugin directory with a managed marker. */
async function writeGrokProjection(
  projectRoot: string,
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  const dest = join(projectRoot, ".grok", "plugins", plugin.name);
  if (existsSync(dest)) {
    if (await isManagedProjection(dest)) {
      if (await directoriesMatch(plugin.pluginDir, dest, new Set([".dotagents-managed"]))) {
        return false;
      }
      await rm(dest, { recursive: true, force: true });
    } else {
      warnings.push({
        agent: "grok",
        name: plugin.name,
        message: `Grok plugin projection exists and is not managed by dotagents: ${dest}`,
      });
      return false;
    }
  }

  await mkdir(dirname(dest), { recursive: true });
  await cp(plugin.pluginDir, dest, { recursive: true });
  await writeFile(join(dest, ".dotagents-managed"), "Generated by dotagents. Do not edit.\n", "utf-8");
  return true;
}

/** Writes OpenCode re-export modules for explicit or conventional plugin modules. */
async function writeOpenCodeProjection(
  projectRoot: string,
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<number> {
  const modules = opencodeModules(plugin, warnings);
  let written = 0;
  for (const modulePath of modules) {
    const ext = extname(modulePath);
    const dest = join(projectRoot, ".opencode", "plugins", `${plugin.name}${ext}`);
    if (existsSync(dest) && !await isManagedOpenCodeModule(dest)) {
      warnings.push({
        agent: "opencode",
        name: plugin.name,
        message: `OpenCode plugin module exists and is not managed by dotagents: ${dest}`,
      });
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    const moduleSpecifier = JSON.stringify(relativePath(dirname(dest), join(plugin.pluginDir, modulePath)));
    const content = `// Generated by dotagents. Do not edit.\nexport { default } from ${moduleSpecifier};\n`;
    if (await writeTextIfChanged(dest, content)) {written++;}
  }
  return written;
}

/** Builds the managed Codex manifest projection and stamps dotagents ownership metadata. */
function codexRuntimeManifest(plugin: PluginDeclaration): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    ...plugin.manifest,
    name: plugin.name,
  };

  if (!manifest["skills"] && existsSync(join(plugin.pluginDir, "skills"))) {
    manifest["skills"] = "./skills";
  }
  if (!manifest["agents"] && existsSync(join(plugin.pluginDir, "agents"))) {
    manifest["agents"] = "./agents";
  }
  if (!manifest["commands"] && existsSync(join(plugin.pluginDir, "commands"))) {
    manifest["commands"] = "./commands";
  }
  if (!manifest["hooks"] && existsSync(join(plugin.pluginDir, "hooks", "hooks.json"))) {
    manifest["hooks"] = "./hooks/hooks.json";
  }
  if (!manifest["mcpServers"] && existsSync(join(plugin.pluginDir, ".mcp.json"))) {
    manifest["mcpServers"] = "./.mcp.json";
  }
  if (!manifest["lspServers"] && existsSync(join(plugin.pluginDir, ".lsp.json"))) {
    manifest["lspServers"] = "./.lsp.json";
  }
  if (!manifest["apps"] && existsSync(join(plugin.pluginDir, ".app.json"))) {
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

function opencodeModules(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[] = [],
): string[] {
  const opencode = plugin.manifest.opencode;
  if (opencode?.plugins) {
    return opencode.plugins.filter((path) => {
      if (existsSync(join(plugin.pluginDir, path))) {return true;}
      warnings.push({
        agent: "opencode",
        name: plugin.name,
        message: `OpenCode plugin module missing: ${join(plugin.pluginDir, path)}`,
      });
      return false;
    });
  }
  const candidates = ["opencode/plugin.ts", "opencode/plugin.js"];
  const candidate = candidates.find((path) => existsSync(join(plugin.pluginDir, path)));
  return candidate ? [candidate] : [];
}

function selectPlugins(agentIds: string[], plugins: PluginDeclaration[]): PluginDeclaration[] {
  return plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).length > 0);
}

function selectedAgentIds(
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

function targetWarnings(
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

async function writeManagedJsonOutput(
  output: RuntimeOutput,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  if (existsSync(output.filePath) && !await isManagedJsonFile(output.filePath)) {
    warnings.push({
      agent: output.agent,
      name: "marketplace",
      message: `Plugin marketplace exists and is not managed by dotagents: ${output.filePath}`,
    });
    return false;
  }
  return writeJsonIfChanged(output.filePath, output.content);
}

async function writeJsonIfChanged(filePath: string, content: string): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true });
  return writeTextIfChanged(filePath, content);
}

async function writeTextIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    if (await readFile(filePath, "utf-8") === content) {return false;}
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }
  await writeFile(filePath, content, "utf-8");
  return true;
}

/** Checks the JSON ownership marker used for marketplaces and Codex manifests. */
async function isManagedJsonFile(filePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
    const metadata = parsed["metadata"];
    return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)["managedBy"] === "dotagents";
  } catch {
    return false;
  }
}

/** Checks Grok directory projections using the non-JSON marker file. */
async function isManagedProjection(path: string): Promise<boolean> {
  return existsSync(join(path, ".dotagents-managed"));
}

/** Checks OpenCode module projections using the generated-file header marker. */
async function isManagedOpenCodeModule(filePath: string): Promise<boolean> {
  try {
    return (await readFile(filePath, "utf-8")).startsWith("// Generated by dotagents.");
  } catch {
    return false;
  }
}

async function directoriesMatch(source: string, dest: string, ignoredNames = new Set<string>()): Promise<boolean> {
  if (!existsSync(source) || !existsSync(dest)) {return false;}

  const sourceEntries = await comparableEntries(source, ignoredNames);
  const destEntries = await comparableEntries(dest, ignoredNames);
  if (sourceEntries.length !== destEntries.length) {return false;}

  for (const entry of sourceEntries) {
    const destEntry = destEntries.find((item) => item.name === entry.name);
    if (!destEntry) {return false;}

    const sourcePath = join(source, entry.name);
    const destPath = join(dest, destEntry.name);
    if (entry.kind !== destEntry.kind) {return false;}
    if (entry.kind === "directory") {
      if (!await directoriesMatch(sourcePath, destPath, ignoredNames)) {return false;}
      continue;
    }
    if (entry.kind === "symlink") {
      if (await readlink(sourcePath) !== await readlink(destPath)) {return false;}
      continue;
    }
    if (await readFile(sourcePath, "utf-8") !== await readFile(destPath, "utf-8")) {
      return false;
    }
  }
  return true;
}

async function comparableEntries(
  dir: string,
  ignoredNames: Set<string>,
): Promise<Array<{ name: string; kind: "directory" | "file" | "symlink" }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: Array<{ name: string; kind: "directory" | "file" | "symlink" }> = [];
  for (const entry of entries) {
    if (ignoredNames.has(entry.name)) {continue;}
    const path = join(dir, entry.name);
    const stat = await lstat(path);
    const kind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : "file";
    result.push({ name: entry.name, kind });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (err) {
    if (!isNotFoundError(err) && !(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOTEMPTY")) {
      throw err;
    }
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(sortJson);}
  if (!value || typeof value !== "object") {return value;}

  const result: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).toSorted()) {
    result[key] = sortJson(record[key]);
  }
  return result;
}

function manifestString(manifest: PluginManifest, key: string): string | undefined {
  const value = manifest[key];
  return typeof value === "string" ? value : undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-.]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function relativePath(from: string, to: string): string {
  const path = relative(from, to).split("\\").join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
