import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { loadSkillMd } from "@sentry/dotagents-lib";
import { AGENT_PLUGIN_SCHEMA, isStandardPluginManifest, parsePluginMcp, type LegacyPluginManifest } from "../schema.js";
import type { PluginDeclaration } from "../types.js";
import { selectedAgentIds, selectPlugins, targetWarnings, usesLegacyPluginComponents } from "../targets.js";
import { marketplaceOutputPaths, marketplaceOutputs } from "./marketplace.js";
import {
  type PluginVerifyIssue,
  type PluginWriteResult,
  type PluginWriteWarning,
  type RuntimeOutput,
} from "./types.js";
import {
  isManagedJsonFile,
  isNotFoundError,
  removeManagedJsonFile,
  stableJson,
  writeManagedJsonIfChanged,
} from "../managed-files.js";
import { NATIVE_PLUGIN_MANIFEST_TARGETS, writePluginManifests } from "./manifests.js";
import { isSafeComponentPath } from "./component-paths.js";

// Owns deterministic runtime plugin projections. Existing runtime artifacts are
// overwritten only when they carry dotagents managed metadata or a managed marker.
export type { PluginVerifyIssue, PluginWriteResult, PluginWriteWarning } from "./types.js";

type ComponentProjectionAgent = "opencode" | "pi";

interface ComponentLink {
  agent: ComponentProjectionAgent;
  kind: "skill" | "agent";
  name: string;
  sourcePath: string;
  destPath: string;
}

const OPENCODE_SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Returns plugin skill names projected into `.agents/skills/` for Pi. */
export async function projectedPiSkillNames(
  agentIds: string[],
  plugins: PluginDeclaration[],
): Promise<string[]> {
  const names = new Set<string>();
  const selected = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes("pi"));
  for (const plugin of selected) {
    for (const skillsDir of componentDirs(plugin, "skills", "skills", "pi")) {
      for (const name of await skillNamesInDir(plugin, skillsDir)) {
        if (SKILL_NAME_PATTERN.test(name)) {names.add(name);}
      }
    }
  }
  return [...names];
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
    written += await writePluginManifests(plugin, agents, warnings);
    if (agents.includes("grok") && await writeGrokProjection(projectRoot, plugin, warnings)) {
      written++;
    }
  }

  written += await writeComponentProjections("opencode", agentIds, selected, projectRoot, warnings);
  written += await writeComponentProjections("pi", agentIds, selected, projectRoot, warnings);

  return { warnings, written };
}

/** Reconciles stale managed outputs before writing current projections. */
export async function reconcilePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
  extraManagedPluginRoots: string[] = [],
): Promise<{ result: PluginWriteResult; pruned: string[] }> {
  const pruned = await prunePluginOutputs(agentIds, plugins, projectRoot, extraManagedPluginRoots);
  const result = await writePluginOutputs(agentIds, plugins, projectRoot);
  return { result, pruned };
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

  for (const link of await desiredComponentLinks("opencode", agentIds, selected, projectRoot, [])) {
    if (!await symlinkPointsTo(link.destPath, link.sourcePath)) {
      issues.push({ agent: link.agent, name: link.name, issue: `OpenCode plugin ${link.kind} projection missing: ${link.destPath}` });
    }
  }
  for (const link of await desiredComponentLinks("pi", agentIds, selected, projectRoot, [])) {
    if (!await symlinkPointsTo(link.destPath, link.sourcePath)) {
      issues.push({ agent: link.agent, name: link.name, issue: `Pi plugin ${link.kind} projection missing: ${link.destPath}` });
    }
  }

  return issues;
}

/** Removes stale dotagents-managed plugin runtime artifacts.
 *
 * `extraManagedPluginRoots` lets callers prune component symlinks for plugin
 * bundles that were just removed from the canonical install tree.
 */
export async function prunePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
  extraManagedPluginRoots: string[] = [],
): Promise<string[]> {
  const pruned: string[] = [];
  const managedPluginRoots = [
    ...plugins.map((plugin) => plugin.pluginDir),
    ...extraManagedPluginRoots,
  ];
  const desiredMarketplacePaths = new Set(
    marketplaceOutputs(agentIds, projectRoot, plugins).map((output) => output.filePath),
  );
  for (const filePath of marketplaceOutputPaths(projectRoot)) {
    if (desiredMarketplacePaths.has(filePath)) {continue;}
    if (!await isManagedJsonFile(filePath)) {continue;}
    await removeManagedJsonFile(filePath);
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

  const desiredOpenCodeLinks = new Set(
    (await desiredComponentLinks("opencode", agentIds, plugins, projectRoot, [])).map((link) => link.destPath),
  );
  pruned.push(...await pruneManagedComponentLinks(join(projectRoot, ".opencode", "skills"), desiredOpenCodeLinks, managedPluginRoots));
  pruned.push(...await pruneManagedComponentLinks(join(projectRoot, ".opencode", "agents"), desiredOpenCodeLinks, managedPluginRoots));

  const desiredPiLinks = new Set(
    (await desiredComponentLinks("pi", agentIds, plugins, projectRoot, [])).map((link) => link.destPath),
  );
  pruned.push(...await pruneManagedComponentLinks(join(projectRoot, ".agents", "skills"), desiredPiLinks, managedPluginRoots));

  const canonicalPluginDir = join(projectRoot, ".agents", "plugins");
  if (existsSync(canonicalPluginDir)) {
    const entries = await readdir(canonicalPluginDir, { withFileTypes: true });
    for (const target of NATIVE_PLUGIN_MANIFEST_TARGETS) {
      const desired = new Set(
        plugins
          .filter((plugin) => selectedAgentIds(agentIds, plugin).includes(target.agent))
          .map((plugin) => plugin.name),
      );
      for (const entry of entries) {
        if (!entry.isDirectory() || desired.has(entry.name)) {continue;}
        for (const fileName of ["plugin.json", "mcp.json"]) {
          const path = join(canonicalPluginDir, entry.name, target.dir, fileName);
          if (!await isManagedJsonFile(path)) {continue;}
          await removeManagedJsonFile(path);
          await rmdirIfEmpty(dirname(path));
          pruned.push(path);
        }
      }
    }
  }

  return pruned;
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

  const excluded = new Set([
    ".claude-plugin",
    ".cursor-plugin",
    ".codex-plugin",
    ".dotagents-managed",
    ".dotagents-native-source",
  ]);
  if (plugin.nativeSource) {
    for (const path of ["agents", "commands", "rules", "hooks", "monitors", ".mcp.json", ".lsp.json", ".app.json"]) {
      excluded.add(path);
    }
    for (const root of nativeComponentRoots(plugin)) {excluded.add(root);}
    if (await hasPortableMcp(plugin)) {excluded.delete("mcp.json");}
    else {excluded.add("mcp.json");}
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(plugin.pluginDir, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const relPath = relative(plugin.pluginDir, source).split("\\").join("/");
      const rootEntry = relPath.split("/")[0];
      return !rootEntry || !excluded.has(rootEntry);
    },
  });
  if (plugin.nativeSource) {
    await writeFile(join(dest, "plugin.json"), stableJson(portableCoreManifest(plugin)));
  }
  await writeFile(join(dest, ".dotagents-managed"), "Generated by dotagents. Do not edit.\n", "utf-8");
  return true;
}

function portableCoreManifest(plugin: PluginDeclaration): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    $schema: AGENT_PLUGIN_SCHEMA,
    name: plugin.name,
  };
  for (const key of ["description", "version", "homepage", "license"] as const) {
    const value = plugin.manifest[key];
    if (typeof value === "string" && value.length > 0) {manifest[key] = value;}
  }
  if (typeof plugin.manifest.repository === "string") {
    manifest["repository"] = plugin.manifest.repository;
  }
  if (plugin.manifest.author?.name) {
    manifest["author"] = {
      name: plugin.manifest.author.name,
      ...(plugin.manifest.author.email ? { email: plugin.manifest.author.email } : {}),
      ...(plugin.manifest.author.url ? { url: plugin.manifest.author.url } : {}),
    };
  }
  if (plugin.manifest.keywords?.every((keyword) => typeof keyword === "string")) {
    manifest["keywords"] = plugin.manifest.keywords;
  }
  return manifest;
}

function nativeComponentRoots(plugin: PluginDeclaration): string[] {
  if (!plugin.nativeSource || isStandardPluginManifest(plugin.manifest)) {return [];}
  const roots = new Set<string>();
  const manifest = plugin.manifest as LegacyPluginManifest;
  for (const key of ["skills", "agents", "commands", "rules", "hooks", "mcpServers", "lspServers", "apps", "monitors", "bin"] as const) {
    const value = manifest[key];
    const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const path of paths) {
      if (!isSafeComponentPath(path)) {continue;}
      const root = path.replace(/^\.\//, "").split("/")[0];
      if (key === "skills" && root === "skills") {continue;}
      if (root) {roots.add(root);}
    }
  }
  return [...roots];
}

async function hasPortableMcp(plugin: PluginDeclaration): Promise<boolean> {
  const filePath = join(plugin.pluginDir, "mcp.json");
  if (!existsSync(filePath)) {return false;}
  try {
    parsePluginMcp(JSON.parse(await readFile(filePath, "utf-8")), filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeComponentProjections(
  agent: ComponentProjectionAgent,
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
  warnings: PluginWriteWarning[],
): Promise<number> {
  let written = 0;
  for (const link of await desiredComponentLinks(agent, agentIds, plugins, projectRoot, warnings)) {
    if (await writeManagedComponentLink(link, projectRoot, warnings)) {written++;}
  }
  return written;
}

async function desiredComponentLinks(
  agent: ComponentProjectionAgent,
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  const links = new Map<string, ComponentLink>();
  const selected = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes(agent));
  for (const plugin of selected) {
    for (const link of await componentLinks(agent, projectRoot, plugin, warnings)) {
      const existing = links.get(link.destPath);
      if (existing && existing.sourcePath !== link.sourcePath) {
        warnings.push({
          agent,
          name: plugin.name,
          message: `${displayName(agent)} plugin ${link.kind} projection conflicts with ${existing.sourcePath}: ${link.destPath}`,
        });
        continue;
      }
      links.set(link.destPath, link);
    }
  }
  return [...links.values()];
}

async function componentLinks(
  agent: ComponentProjectionAgent,
  projectRoot: string,
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  const links: ComponentLink[] = [];
  for (const skillsDir of componentDirs(plugin, "skills", "skills", agent, warnings)) {
    const skillDestRoot = agent === "opencode"
      ? join(projectRoot, ".opencode", "skills")
      : join(projectRoot, ".agents", "skills");
    links.push(...await skillComponentLinks(agent, plugin, skillsDir, skillDestRoot, warnings));
  }

  if (agent === "opencode" && usesLegacyPluginComponents(plugin, "opencode")) {
    for (const agentsDir of componentDirs(plugin, "agents", "agents", agent, warnings)) {
      links.push(...await markdownComponentLinks(
        agent,
        plugin,
        agentsDir,
        join(projectRoot, ".opencode", "agents"),
        warnings,
      ));
    }
  }

  return links;
}

async function skillComponentLinks(
  agent: ComponentProjectionAgent,
  plugin: PluginDeclaration,
  skillsDir: string,
  destRoot: string,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  if (!existsSync(skillsDir)) {return [];}
  if (!await isDirectoryPath(skillsDir)) {
    warnings.push({
      agent,
      name: plugin.name,
      message: `Plugin skills path is not a directory and was skipped: ${skillsDir}`,
    });
    return [];
  }
  if (!await isContainedPluginPath(plugin.pluginDir, skillsDir)) {
    warnings.push({
      agent,
      name: plugin.name,
      message: `Plugin skills directory resolves outside the plugin bundle and was skipped: ${skillsDir}`,
    });
    return [];
  }

  const links: ComponentLink[] = [];
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {continue;}
    const sourcePath = join(skillsDir, entry.name);
    const skillMd = join(sourcePath, "SKILL.md");
    if (!existsSync(skillMd)) {continue;}
    if (
      !await isContainedPluginPath(plugin.pluginDir, sourcePath) ||
      !await isContainedPluginPath(plugin.pluginDir, skillMd)
    ) {
      warnings.push({
        agent,
        name: plugin.name,
        message: `Plugin skill resolves outside the plugin bundle and was skipped: ${sourcePath}`,
      });
      continue;
    }

    let skillName: string;
    try {
      skillName = (await loadSkillMd(skillMd)).name;
    } catch (err) {
      warnings.push({
        agent,
        name: plugin.name,
        message: `Plugin skill is invalid for ${displayName(agent)} projection: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (agent === "opencode" && !OPENCODE_SKILL_NAME_PATTERN.test(skillName)) {
      warnings.push({
        agent,
        name: plugin.name,
        message: `Plugin skill "${skillName}" cannot be projected to OpenCode because OpenCode skill names must be lowercase alphanumeric with single hyphen separators.`,
      });
      continue;
    }
    if (agent === "pi" && !SKILL_NAME_PATTERN.test(skillName)) {
      warnings.push({
        agent,
        name: plugin.name,
        message: `Plugin skill "${skillName}" cannot be projected to Pi because skill names must start with alphanumeric and contain only [a-zA-Z0-9._-].`,
      });
      continue;
    }

    links.push({
      agent,
      kind: "skill",
      name: plugin.name,
      sourcePath,
      destPath: join(destRoot, skillName),
    });
  }
  return links;
}

async function skillNamesInDir(
  plugin: PluginDeclaration,
  skillsDir: string,
): Promise<string[]> {
  if (!existsSync(skillsDir)) {return [];}
  if (!await isDirectoryPath(skillsDir)) {return [];}
  if (!await isContainedPluginPath(plugin.pluginDir, skillsDir)) {return [];}

  const names: string[] = [];
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {continue;}
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) {continue;}
    if (!await isContainedPluginPath(plugin.pluginDir, skillMd)) {continue;}
    try {
      names.push((await loadSkillMd(skillMd)).name);
    } catch {
      // Invalid skills are skipped by the projection writer too.
    }
  }
  return names;
}

async function markdownComponentLinks(
  agent: ComponentProjectionAgent,
  plugin: PluginDeclaration,
  agentsDir: string,
  destRoot: string,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  if (!existsSync(agentsDir)) {return [];}
  if (!await isContainedPluginPath(plugin.pluginDir, agentsDir)) {
    warnings.push({
      agent,
      name: plugin.name,
      message: `Plugin agents directory resolves outside the plugin bundle and was skipped: ${agentsDir}`,
    });
    return [];
  }

  const links: ComponentLink[] = [];
  for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || extname(entry.name) !== ".md") {continue;}
    const sourcePath = join(agentsDir, entry.name);
    if (!await isContainedPluginPath(plugin.pluginDir, sourcePath)) {
      warnings.push({
        agent,
        name: plugin.name,
        message: `Plugin agent resolves outside the plugin bundle and was skipped: ${sourcePath}`,
      });
      continue;
    }
    links.push({
      agent,
      kind: "agent",
      name: plugin.name,
      sourcePath,
      destPath: join(destRoot, entry.name),
    });
  }

  return links;
}

async function isContainedPluginPath(pluginDir: string, filePath: string): Promise<boolean> {
  try {
    const [pluginRealPath, fileRealPath] = await Promise.all([
      realpath(pluginDir),
      realpath(filePath),
    ]);
    const relativePath = relative(pluginRealPath, fileRealPath);
    return !relativePath.startsWith("..") && !isAbsolute(relativePath);
  } catch {
    return false;
  }
}

async function writeManagedComponentLink(
  link: ComponentLink,
  projectRoot: string,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  if (await pathExists(link.destPath)) {
    if (await symlinkPointsTo(link.destPath, link.sourcePath)) {return false;}
    if (!await isManagedComponentLink(link.destPath, projectRoot)) {
      warnings.push({
        agent: link.agent,
        name: link.name,
        message: `${displayName(link.agent)} plugin ${link.kind} projection exists and is not managed by dotagents: ${link.destPath}`,
      });
      return false;
    }
    await rm(link.destPath, { force: true });
  }

  await mkdir(dirname(link.destPath), { recursive: true });
  await symlink(relative(dirname(link.destPath), link.sourcePath), link.destPath);
  return true;
}

function componentDirs(
  plugin: PluginDeclaration,
  manifestKey: keyof Pick<LegacyPluginManifest, "skills" | "agents">,
  defaultDir: string,
  agent?: ComponentProjectionAgent,
  warnings: PluginWriteWarning[] = [],
): string[] {
  const explicit = isStandardPluginManifest(plugin.manifest) || plugin.nativeSource !== undefined
    ? { present: false, paths: [] }
    : manifestPaths(plugin.manifest[manifestKey], plugin, manifestKey, agent, warnings);
  const paths = explicit.present ? explicit.paths : [defaultDir];
  return paths.map((path) => join(plugin.pluginDir, path));
}

function manifestPaths(
  value: unknown,
  plugin: PluginDeclaration,
  manifestKey: keyof Pick<LegacyPluginManifest, "skills" | "agents">,
  agent?: ComponentProjectionAgent,
  warnings: PluginWriteWarning[] = [],
): { present: boolean; paths: string[] } {
  const collect = (values: string[]): string[] => {
    const paths: string[] = [];
    for (const item of values) {
      if (isSafeComponentPath(item)) {
        paths.push(item);
        continue;
      }
      if (agent) {
        warnings.push({
          agent,
          name: plugin.name,
          message: `Plugin component path "${item}" for "${String(manifestKey)}" is not a safe relative path and was skipped.`,
        });
      }
    }
    return paths;
  };

  if (typeof value === "string") {
    return {
      present: true,
      paths: collect([value]),
    };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return {
      present: true,
      paths: collect(value),
    };
  }
  return { present: false, paths: [] };
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
  return writeManagedJsonIfChanged(output.filePath, output.content);
}

/** Checks Grok directory projections using the non-JSON marker file. */
async function isManagedProjection(path: string): Promise<boolean> {
  return existsSync(join(path, ".dotagents-managed"));
}

/** Prunes stale component symlinks whose targets resolve under managed plugin roots. */
async function pruneManagedComponentLinks(
  dir: string,
  desiredPaths: Set<string>,
  managedPluginRoots: string[],
): Promise<string[]> {
  if (!existsSync(dir)) {return [];}

  const pruned: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (desiredPaths.has(path)) {continue;}
    if (!await isManagedComponentLink(path, managedPluginRoots)) {continue;}
    await rm(path, { force: true });
    pruned.push(path);
  }
  return pruned;
}

async function symlinkPointsTo(filePath: string, expectedTarget: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isSymbolicLink()) {return false;}
    const target = await readlink(filePath);
    return resolve(dirname(filePath), target) === resolve(expectedTarget);
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) {return false;}
    throw err;
  }
}

async function isDirectoryPath(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (err) {
    if (isNotFoundError(err)) {return false;}
    throw err;
  }
}

async function isManagedComponentLink(filePath: string, managedRoot: string | string[]): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isSymbolicLink()) {return false;}
    const lexicalTarget = resolve(dirname(filePath), await readlink(filePath));
    const roots = Array.isArray(managedRoot)
      ? managedRoot
      : [join(managedRoot, ".agents", "plugins")];
    try {
      const target = await realpath(filePath);
      const canonicalRoots = await Promise.all(roots.map(async (root) => {
        try {
          return await realpath(root);
        } catch (err) {
          if (isNotFoundError(err)) {return resolve(root);}
          throw err;
        }
      }));
      return canonicalRoots.some((root) => isInside(target, root));
    } catch (err) {
      if (!isNotFoundError(err)) {return false;}
      return roots.some((root) => isInside(lexicalTarget, root));
    }
  } catch {
    return false;
  }
}

function isInside(path: string, root: string): boolean {
  const relPath = relative(resolve(root), resolve(path));
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

function displayName(agent: ComponentProjectionAgent): string {
  return agent === "opencode" ? "OpenCode" : "Pi";
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
