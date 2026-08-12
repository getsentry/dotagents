import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkillMd, type SerializedObject } from "@sentry/dotagents-lib";
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
import { loadStandardMcp, NATIVE_PLUGIN_MANIFEST_TARGETS, writePluginManifests, type LoadedStandardMcp } from "./manifests.js";
import { isSafeComponentPath } from "./component-paths.js";
import { reconcileOpenCodePluginMcp } from "./opencode-mcp.js";
import {
  normalizePluginRuntimeLayout,
  type PluginRuntimeLayout,
  type PluginRuntimeRoot,
} from "./layout.js";

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

interface PluginSkillComponent {
  name: string;
  sourcePath: string;
}

const OPENCODE_SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface PluginRuntimeOptions {
  reservedMcpNames?: Iterable<string>;
}

/** Returns plugin skill names projected into `.agents/skills/` for Pi. */
export async function projectedPiSkillNames(
  agentIds: string[],
  plugins: PluginDeclaration[],
): Promise<string[]> {
  const names = new Set<string>();
  const selected = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes("pi"));
  for (const plugin of selected) {
    for (const skillsDir of componentDirs(plugin, "skills", "skills", "pi")) {
      for (const skill of await discoverSkillComponents("pi", plugin, skillsDir)) {
        names.add(skill.name);
      }
    }
  }
  return [...names];
}

/** Writes deterministic project-scope plugin runtime artifacts for selected agents. */
export async function writePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  root: PluginRuntimeRoot,
  options: PluginRuntimeOptions = {},
): Promise<PluginWriteResult> {
  const layout = normalizePluginRuntimeLayout(root);
  const warnings: PluginWriteWarning[] = [];
  let written = 0;
  const selected = selectPlugins(agentIds, plugins);
  const loadedMcp = new Map<string, LoadedStandardMcp>();

  for (const warning of targetWarnings(agentIds, plugins)) {
    warnings.push(warning);
  }

  for (const output of marketplaceOutputs(agentIds, layout, selected)) {
    if (await writeManagedJsonOutput(output, warnings)) {written++;}
  }

  for (const plugin of selected) {
    const agents = selectedAgentIds(agentIds, plugin);
    const standardMcp = await loadStandardMcp(plugin, warnings);
    loadedMcp.set(plugin.name, standardMcp);
    written += await writePluginManifests(plugin, agents, warnings, standardMcp);
    if (agents.includes("grok") && await writeGrokProjection(layout, plugin, warnings)) {
      written++;
    }
  }

  written += await writeComponentProjections("opencode", agentIds, selected, layout, warnings);
  written += await writeComponentProjections("pi", agentIds, selected, layout, warnings);
  const opencodeMcp = await reconcileOpenCodePluginMcp(
    agentIds,
    plugins,
    loadedMcp,
    layout,
    options.reservedMcpNames ?? [],
    "apply",
    warnings,
  );
  written += opencodeMcp.written + opencodeMcp.pruned.length;

  return { warnings, written };
}

/** Reconciles stale managed outputs before writing current projections. */
export async function reconcilePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  root: PluginRuntimeRoot,
  options: PluginRuntimeOptions = {},
): Promise<{ result: PluginWriteResult; pruned: string[] }> {
  const pruned = await prunePluginOutputs(agentIds, plugins, root);
  const result = await writePluginOutputs(agentIds, plugins, root, options);
  return { result, pruned };
}

/** Verifies that generated plugin runtime artifacts match the current declarations. */
export async function verifyPluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  root: PluginRuntimeRoot,
  options: PluginRuntimeOptions = {},
): Promise<PluginVerifyIssue[]> {
  const layout = normalizePluginRuntimeLayout(root);
  const issues: PluginVerifyIssue[] = [];
  const selected = selectPlugins(agentIds, plugins);
  const mcpWarnings: PluginWriteWarning[] = [];
  const loadedMcp = new Map<string, LoadedStandardMcp>();
  for (const plugin of selected) {
    loadedMcp.set(plugin.name, await loadStandardMcp(plugin, mcpWarnings));
  }

  for (const output of marketplaceOutputs(agentIds, layout, selected)) {
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
    for (const spec of NATIVE_PLUGIN_MANIFEST_TARGETS) {
      if (!agents.includes(spec.agent)) {continue;}
      const filePath = join(plugin.pluginDir, spec.dir, "plugin.json");
      if (!existsSync(filePath)) {
        issues.push({ agent: spec.agent, name: plugin.name, issue: `${spec.label} plugin manifest missing: ${filePath}` });
      }
    }
    if (agents.includes("grok")) {
      const filePath = join(layout.grokPluginsDir, plugin.name);
      if (!existsSync(filePath)) {
        issues.push({ agent: "grok", name: plugin.name, issue: `Grok plugin projection missing: ${filePath}` });
      }
    }
  }

  for (const link of await desiredComponentLinks("opencode", agentIds, selected, layout, [])) {
    if (!await symlinkPointsTo(link.destPath, link.sourcePath) || !await isManagedComponentLink(link.destPath)) {
      issues.push({ agent: link.agent, name: link.name, issue: `OpenCode plugin ${link.kind} projection missing: ${link.destPath}` });
    }
  }
  for (const link of await desiredComponentLinks("pi", agentIds, selected, layout, [])) {
    if (!await symlinkPointsTo(link.destPath, link.sourcePath) || !await isManagedComponentLink(link.destPath)) {
      issues.push({ agent: link.agent, name: link.name, issue: `Pi plugin ${link.kind} projection missing: ${link.destPath}` });
    }
  }

  issues.push(...mcpWarnings.map(({ agent, name, message }) => ({ agent, name, issue: message })));
  const opencodeMcp = await reconcileOpenCodePluginMcp(
    agentIds,
    plugins,
    loadedMcp,
    layout,
    options.reservedMcpNames ?? [],
    "inspect",
    [],
  );
  issues.push(...opencodeMcp.issues);

  return issues;
}

/** Removes stale dotagents-managed plugin runtime artifacts. */
export async function prunePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  root: PluginRuntimeRoot,
): Promise<string[]> {
  const layout = normalizePluginRuntimeLayout(root);
  const pruned: string[] = [];
  const desiredMarketplacePaths = new Set(
    marketplaceOutputs(agentIds, layout, plugins).map((output) => output.filePath),
  );
  for (const filePath of marketplaceOutputPaths(layout)) {
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
  const grokDir = layout.grokPluginsDir;
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
    (await desiredComponentLinks("opencode", agentIds, plugins, layout, [])).map((link) => link.destPath),
  );
  pruned.push(...await pruneManagedComponentLinks(layout.opencodeSkillsDir, desiredOpenCodeLinks));
  pruned.push(...await pruneManagedComponentLinks(layout.opencodeAgentsDir, desiredOpenCodeLinks));

  const desiredPiLinks = new Set(
    (await desiredComponentLinks("pi", agentIds, plugins, layout, [])).map((link) => link.destPath),
  );
  pruned.push(...await pruneManagedComponentLinks(layout.piSkillsDir, desiredPiLinks));

  const canonicalPluginDir = layout.canonicalPluginsDir;
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
  layout: PluginRuntimeLayout,
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  const dest = join(layout.grokPluginsDir, plugin.name);
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
  let portableSkillsSource: string | undefined;
  if (plugin.nativeSource) {
    for (const path of ["agents", "commands", "rules", "hooks", "monitors", ".mcp.json", ".lsp.json", ".app.json"]) {
      excluded.add(path);
    }
    for (const root of nativeComponentRoots(plugin)) {excluded.add(root);}
    portableSkillsSource = await containedSymlinkTarget(plugin.pluginDir, "skills");
    if (portableSkillsSource) {excluded.add("skills");}
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
  if (portableSkillsSource) {
    await cp(portableSkillsSource, join(dest, "skills"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  if (plugin.nativeSource) {
    await writeFile(join(dest, "plugin.json"), stableJson(portableCoreManifest(plugin)));
  }
  await writeFile(join(dest, ".dotagents-managed"), "Generated by dotagents. Do not edit.\n", "utf-8");
  return true;
}

function portableCoreManifest(plugin: PluginDeclaration): SerializedObject {
  const manifest: SerializedObject = {
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

async function containedSymlinkTarget(pluginDir: string, entryName: string): Promise<string | undefined> {
  const filePath = join(pluginDir, entryName);
  try {
    if (!(await lstat(filePath)).isSymbolicLink()) {return undefined;}
    const [root, target] = await Promise.all([realpath(pluginDir), realpath(filePath)]);
    const relPath = relative(root, target);
    if (!relPath || isOutsideRelativePath(relPath)) {return undefined;}
    return target;
  } catch {
    return undefined;
  }
}

async function writeComponentProjections(
  agent: ComponentProjectionAgent,
  agentIds: string[],
  plugins: PluginDeclaration[],
  layout: PluginRuntimeLayout,
  warnings: PluginWriteWarning[],
): Promise<number> {
  let written = 0;
  for (const link of await desiredComponentLinks(agent, agentIds, plugins, layout, warnings)) {
    if (await writeManagedComponentLink(link, warnings)) {written++;}
  }
  return written;
}

async function desiredComponentLinks(
  agent: ComponentProjectionAgent,
  agentIds: string[],
  plugins: PluginDeclaration[],
  layout: PluginRuntimeLayout,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  const links = new Map<string, ComponentLink>();
  const selected = plugins.filter((plugin) => selectedAgentIds(agentIds, plugin).includes(agent));
  for (const plugin of selected) {
    for (const link of await componentLinks(agent, layout, plugin, warnings)) {
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
  layout: PluginRuntimeLayout,
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  const links: ComponentLink[] = [];
  for (const skillsDir of componentDirs(plugin, "skills", "skills", agent, warnings)) {
    const skillDestRoot = agent === "opencode"
      ? layout.opencodeSkillsDir
      : layout.piSkillsDir;
    links.push(...await skillComponentLinks(agent, plugin, skillsDir, skillDestRoot, warnings));
  }

  if (agent === "opencode" && usesLegacyPluginComponents(plugin, "opencode")) {
    for (const agentsDir of componentDirs(plugin, "agents", "agents", agent, warnings)) {
      links.push(...await markdownComponentLinks(
        agent,
        plugin,
        agentsDir,
        layout.opencodeAgentsDir,
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
  return (await discoverSkillComponents(agent, plugin, skillsDir, warnings)).map((skill) => ({
    agent,
    kind: "skill",
    name: plugin.name,
    sourcePath: skill.sourcePath,
    destPath: join(destRoot, skill.name),
  }));
}

async function discoverSkillComponents(
  agent: ComponentProjectionAgent,
  plugin: PluginDeclaration,
  skillsDir: string,
  warnings: PluginWriteWarning[] = [],
): Promise<PluginSkillComponent[]> {
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

  const skills: PluginSkillComponent[] = [];
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

    skills.push({
      name: skillName,
      sourcePath,
    });
  }
  return skills;
}

async function markdownComponentLinks(
  agent: ComponentProjectionAgent,
  plugin: PluginDeclaration,
  agentsDir: string,
  destRoot: string,
  warnings: PluginWriteWarning[],
): Promise<ComponentLink[]> {
  if (!existsSync(agentsDir)) {return [];}
  if (!await isDirectoryPath(agentsDir)) {
    warnings.push({
      agent,
      name: plugin.name,
      message: `Plugin agents path is not a directory and was skipped: ${agentsDir}`,
    });
    return [];
  }
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
    return !isOutsideRelativePath(relativePath);
  } catch {
    return false;
  }
}

async function writeManagedComponentLink(
  link: ComponentLink,
  warnings: PluginWriteWarning[],
): Promise<boolean> {
  if (await pathExists(link.destPath)) {
    if (await symlinkPointsTo(link.destPath, link.sourcePath) && await isManagedComponentLink(link.destPath)) {
      return false;
    }
    if (!await isManagedComponentLink(link.destPath)) {
      warnings.push({
        agent: link.agent,
        name: link.name,
        message: `${displayName(link.agent)} plugin ${link.kind} projection exists and is not managed by dotagents: ${link.destPath}`,
      });
      return false;
    }
    await rm(link.destPath, { force: true });
    await removeComponentLinkMarker(link.destPath);
  }

  await mkdir(dirname(link.destPath), { recursive: true });
  const symlinkTarget = relative(dirname(link.destPath), link.sourcePath);
  const markerCreated = await claimComponentLinkMarker(link.destPath, symlinkTarget);
  if (markerCreated === null) {
    warnings.push({
      agent: link.agent,
      name: link.name,
      message: `${displayName(link.agent)} plugin ${link.kind} ownership marker exists and is not managed by dotagents: ${componentLinkMarkerPath(link.destPath)}`,
    });
    return false;
  }
  try {
    await symlink(symlinkTarget, link.destPath);
  } catch (err) {
    if (markerCreated) {await removeComponentLinkMarker(link.destPath);}
    throw err;
  }
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
  const markerPath = join(path, ".dotagents-managed");
  try {
    const markerStat = await lstat(markerPath);
    return markerStat.isFile() && await readFile(markerPath, "utf-8") === "Generated by dotagents. Do not edit.\n";
  } catch (err) {
    if (isNotFoundError(err) || isNotDirectoryError(err)) {return false;}
    throw err;
  }
}

function isOutsideRelativePath(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function isNotDirectoryError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOTDIR";
}

/** Prunes stale component symlinks carrying a marker in the reserved ownership directory. */
async function pruneManagedComponentLinks(
  dir: string,
  desiredPaths: Set<string>,
): Promise<string[]> {
  if (!await isDirectoryPath(dir)) {return [];}

  const pruned: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (desiredPaths.has(path)) {continue;}
    if (!await isManagedComponentLink(path)) {continue;}
    await rm(path, { force: true });
    await removeComponentLinkMarker(path);
    pruned.push(path);
  }
  await pruneOrphanComponentMarkers(dir);
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

async function isManagedComponentLink(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isSymbolicLink()) {return false;}
    const markerPath = await safeComponentLinkMarkerPath(filePath, false);
    if (!markerPath || !(await lstat(markerPath)).isFile()) {return false;}
    const target = await readlink(filePath);
    return await readFile(markerPath, "utf-8") === componentLinkMarkerContent(target);
  } catch {
    return false;
  }
}

function componentLinkMarkerPath(filePath: string): string {
  return join(dirname(filePath), ".dotagents-managed", basename(filePath));
}

async function claimComponentLinkMarker(filePath: string, target: string): Promise<boolean | null> {
  const markerPath = await safeComponentLinkMarkerPath(filePath, true);
  if (!markerPath) {return null;}
  const content = componentLinkMarkerContent(target);
  try {
    await writeFile(markerPath, content, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch (err) {
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST")) {
      throw err;
    }
  }
  try {
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile()) {return null;}
    return await readFile(markerPath, "utf-8") === content ? false : null;
  } catch {
    return null;
  }
}

function componentLinkMarkerContent(target: string): string {
  return `managedBy=dotagents\ntarget=${JSON.stringify(target)}\n`;
}

function isComponentLinkMarkerContent(content: string): boolean {
  const prefix = "managedBy=dotagents\ntarget=";
  if (!content.startsWith(prefix) || !content.endsWith("\n")) {return false;}
  try {
    const target = JSON.parse(content.slice(prefix.length, -1));
    return typeof target === "string" && content === componentLinkMarkerContent(target);
  } catch {
    return false;
  }
}

async function safeComponentLinkMarkerPath(filePath: string, createDir: boolean): Promise<string | null> {
  const componentDir = dirname(filePath);
  const markerDir = join(componentDir, ".dotagents-managed");
  try {
    const markerDirStat = await lstat(markerDir);
    if (!markerDirStat.isDirectory()) {return null;}
  } catch (err) {
    if (!isNotFoundError(err) || !createDir) {return null;}
    try {
      await mkdir(markerDir);
    } catch (mkdirErr) {
      if (!(mkdirErr instanceof Error && "code" in mkdirErr && (mkdirErr as NodeJS.ErrnoException).code === "EEXIST")) {
        throw mkdirErr;
      }
    }
    if (!(await lstat(markerDir)).isDirectory()) {return null;}
  }

  try {
    const [componentRealPath, markerRealPath] = await Promise.all([
      realpath(componentDir),
      realpath(markerDir),
    ]);
    if (relative(componentRealPath, markerRealPath) !== ".dotagents-managed") {return null;}
  } catch {
    return null;
  }
  return join(markerDir, basename(filePath));
}

async function removeComponentLinkMarker(filePath: string): Promise<void> {
  const markerPath = await safeComponentLinkMarkerPath(filePath, false);
  if (!markerPath) {return;}
  await rm(markerPath, { force: true });
  await rmdirIfEmpty(dirname(markerPath));
}

async function pruneOrphanComponentMarkers(componentDir: string): Promise<void> {
  const probePath = join(componentDir, ".marker-probe");
  const probeMarkerPath = await safeComponentLinkMarkerPath(probePath, false);
  if (!probeMarkerPath) {return;}
  const markerDir = dirname(probeMarkerPath);
  for (const entry of await readdir(markerDir, { withFileTypes: true })) {
    if (!entry.isFile()) {continue;}
    const markerPath = join(markerDir, entry.name);
    const content = await readFile(markerPath, "utf-8");
    if (!isComponentLinkMarkerContent(content)) {continue;}
    const componentPath = join(componentDir, entry.name);
    if (await pathExists(componentPath)) {
      try {
        const componentStat = await lstat(componentPath);
        if (componentStat.isSymbolicLink() && content === componentLinkMarkerContent(await readlink(componentPath))) {
          continue;
        }
      } catch (err) {
        if (!isNotFoundError(err)) {throw err;}
      }
    }
    await rm(markerPath, { force: true });
  }
  await rmdirIfEmpty(markerDir);
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
