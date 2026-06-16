import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
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
  writeTextIfChanged,
} from "./files.js";
import { relativePath } from "./manifest-values.js";
import { writeClaudeManifest, writeCodexManifest, writeCursorManifest } from "./manifests.js";

// Owns deterministic runtime plugin projections. Existing runtime artifacts are
// overwritten only when they carry dotagents managed metadata or a managed marker.
export type { PluginVerifyIssue, PluginWriteResult, PluginWriteWarning } from "./types.js";

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

  const desiredOpenCode = new Set(
    plugins
      .filter((plugin) => selectedAgentIds(agentIds, plugin).includes("opencode"))
      .flatMap((plugin) => desiredOpenCodeModules(plugin).map((modulePath) => `${plugin.name}${extname(modulePath)}`)),
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

function opencodeModules(
  plugin: PluginDeclaration,
  warnings: PluginWriteWarning[] = [],
): string[] {
  return desiredOpenCodeModules(plugin).filter((path) => {
    if (existsSync(join(plugin.pluginDir, path))) {return true;}
    warnings.push({
      agent: "opencode",
      name: plugin.name,
      message: `OpenCode plugin module missing: ${join(plugin.pluginDir, path)}`,
    });
    return false;
  });
}

/** Returns declared OpenCode modules without existence checks so prune keeps desired managed outputs. */
function desiredOpenCodeModules(plugin: PluginDeclaration): string[] {
  const opencode = plugin.manifest.opencode;
  if (opencode?.plugins) {
    return opencode.plugins;
  }
  const candidates = ["opencode/plugin.ts", "opencode/plugin.js"];
  const candidate = candidates.find((path) => existsSync(join(plugin.pluginDir, path)));
  return candidate ? [candidate] : [];
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
