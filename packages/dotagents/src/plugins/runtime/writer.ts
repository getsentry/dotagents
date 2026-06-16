import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { loadSkillMd } from "@sentry/dotagents-lib";
import type { PluginManifest } from "../schema.js";
import type { PluginDeclaration } from "../store.js";
import { selectedAgentIds, selectPlugins, targetWarnings } from "../targets.js";
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
  writeJsonIfChanged,
} from "./files.js";
import { writeClaudeManifest, writeCodexManifest, writeCursorManifest } from "./manifests.js";
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
    for (const skillsDir of componentDirs(plugin, "skills", "skills")) {
      for (const name of await skillNamesInDir(skillsDir)) {
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
  }

  written += await writeComponentProjections("opencode", agentIds, selected, projectRoot, warnings);
  written += await writeComponentProjections("pi", agentIds, selected, projectRoot, warnings);

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

/** Removes stale dotagents-managed plugin runtime artifacts. */
export async function prunePluginOutputs(
  agentIds: string[],
  plugins: PluginDeclaration[],
  projectRoot: string,
): Promise<string[]> {
  const pruned: string[] = [];
  const desiredMarketplacePaths = new Set(
    marketplaceOutputs(agentIds, projectRoot, plugins).map((output) => output.filePath),
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

  pruned.push(...await pruneLegacyOpenCodeModules(projectRoot));

  const desiredOpenCodeLinks = new Set(
    (await desiredComponentLinks("opencode", agentIds, plugins, projectRoot, [])).map((link) => link.destPath),
  );
  pruned.push(...await pruneManagedComponentLinks(join(projectRoot, ".opencode", "skills"), desiredOpenCodeLinks, projectRoot));
  pruned.push(...await pruneManagedComponentLinks(join(projectRoot, ".opencode", "agents"), desiredOpenCodeLinks, projectRoot));

  const desiredPiLinks = new Set(
    (await desiredComponentLinks("pi", agentIds, plugins, projectRoot, [])).map((link) => link.destPath),
  );
  pruned.push(...await pruneManagedComponentLinks(join(projectRoot, ".agents", "skills"), desiredPiLinks, projectRoot));

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

  if (agent === "opencode") {
    for (const agentsDir of componentDirs(plugin, "agents", "agents", agent, warnings)) {
      links.push(...await markdownComponentLinks(agent, plugin, agentsDir, join(projectRoot, ".opencode", "agents")));
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

  const links: ComponentLink[] = [];
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {continue;}
    const sourcePath = join(skillsDir, entry.name);
    const skillMd = join(sourcePath, "SKILL.md");
    if (!existsSync(skillMd)) {continue;}

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

async function skillNamesInDir(skillsDir: string): Promise<string[]> {
  if (!existsSync(skillsDir)) {return [];}

  const names: string[] = [];
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {continue;}
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) {continue;}
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
): Promise<ComponentLink[]> {
  if (!existsSync(agentsDir)) {return [];}

  const links: ComponentLink[] = [];
  for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || extname(entry.name) !== ".md") {continue;}
    links.push({
      agent,
      kind: "agent",
      name: plugin.name,
      sourcePath: join(agentsDir, entry.name),
      destPath: join(destRoot, entry.name),
    });
  }

  return links;
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
  manifestKey: keyof Pick<PluginManifest, "skills" | "agents">,
  defaultDir: string,
  agent?: ComponentProjectionAgent,
  warnings: PluginWriteWarning[] = [],
): string[] {
  const explicit = manifestPaths(plugin.manifest[manifestKey], plugin, manifestKey, agent, warnings);
  const paths = explicit.present ? explicit.paths : [defaultDir];
  return paths.map((path) => join(plugin.pluginDir, path));
}

function manifestPaths(
  value: unknown,
  plugin: PluginDeclaration,
  manifestKey: keyof Pick<PluginManifest, "skills" | "agents">,
  agent?: ComponentProjectionAgent,
  warnings: PluginWriteWarning[] = [],
): { present: boolean; paths: string[] } {
  if (typeof value === "string") {
    return {
      present: true,
      paths: safeComponentPaths([value], plugin, manifestKey, agent, warnings),
    };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return {
      present: true,
      paths: safeComponentPaths(value, plugin, manifestKey, agent, warnings),
    };
  }
  return { present: false, paths: [] };
}

function safeComponentPaths(
  values: string[],
  plugin: PluginDeclaration,
  manifestKey: keyof Pick<PluginManifest, "skills" | "agents">,
  agent?: ComponentProjectionAgent,
  warnings: PluginWriteWarning[] = [],
): string[] {
  const paths: string[] = [];
  for (const value of values) {
    if (isSafeComponentPath(value)) {
      paths.push(value);
      continue;
    }
    if (agent) {
      warnings.push({
        agent,
        name: plugin.name,
        message: `Plugin component path "${value}" for "${String(manifestKey)}" is not a safe relative path and was skipped.`,
      });
    }
  }
  return paths;
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

/** Checks Grok directory projections using the non-JSON marker file. */
async function isManagedProjection(path: string): Promise<boolean> {
  return existsSync(join(path, ".dotagents-managed"));
}

/** Checks legacy OpenCode JS projections from earlier dotagents plugin support. */
async function isManagedOpenCodeModule(filePath: string): Promise<boolean> {
  try {
    return (await readFile(filePath, "utf-8")).startsWith("// Generated by dotagents.");
  } catch {
    return false;
  }
}

async function pruneLegacyOpenCodeModules(projectRoot: string): Promise<string[]> {
  const opencodeDir = join(projectRoot, ".opencode", "plugins");
  if (!existsSync(opencodeDir)) {return [];}

  const pruned: string[] = [];
  const entries = await readdir(opencodeDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {continue;}
    const path = join(opencodeDir, entry.name);
    if (!await isManagedOpenCodeModule(path)) {continue;}
    await rm(path, { force: true });
    pruned.push(path);
  }
  return pruned;
}

async function pruneManagedComponentLinks(
  dir: string,
  desiredPaths: Set<string>,
  projectRoot: string,
): Promise<string[]> {
  if (!existsSync(dir)) {return [];}

  const pruned: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (desiredPaths.has(path)) {continue;}
    if (!await isManagedComponentLink(path, projectRoot)) {continue;}
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

async function isManagedComponentLink(filePath: string, projectRoot: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isSymbolicLink()) {return false;}
    const target = await readlink(filePath);
    return isInside(resolve(dirname(filePath), target), join(projectRoot, ".agents", "plugins"));
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
    if (!(await readFile(sourcePath)).equals(await readFile(destPath))) {
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
