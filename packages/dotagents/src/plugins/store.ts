import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  applyDefaultRepositorySource,
  copyDir,
  ensureCached,
  isSourceExcluded,
  parseSource,
  resolveLocalSource,
  sanitizeCacheKey,
  validateTrustedSource,
  type RepositorySource,
  type TrustPolicy,
} from "@sentry/dotagents-lib";
import type { PluginConfig } from "../config/schema.js";
import type { LockedPlugin } from "../lockfile/schema.js";
import {
  parsePluginManifest,
  parsePluginMarketplace,
  type MarketplacePluginEntry,
  type PluginManifest,
} from "./schema.js";

// Owns plugin source discovery and installation into the project cache.
// Resolved sources are never allowed to live inside the same project's
// `.agents/plugins` tree because installs replace managed destination dirs.
export interface PluginResolveOptions {
  stateDir: string;
  projectRoot: string;
  defaultRepositorySource?: RepositorySource;
  minimumReleaseAge?: number;
  minimumReleaseAgeExclude?: string[];
  trust?: TrustPolicy;
}

export interface PluginDeclaration {
  name: string;
  source: string;
  pluginDir: string;
  manifest: PluginManifest;
  targets?: string[];
}

interface ResolvedLocalPlugin {
  type: "local";
  plugin: PluginDeclaration;
}

interface ResolvedGitPlugin {
  type: "git";
  resolvedUrl: string;
  resolvedPath: string;
  resolvedRef?: string;
  commit: string;
  plugin: PluginDeclaration;
}

export type ResolvedPlugin = ResolvedLocalPlugin | ResolvedGitPlugin;

interface PluginCandidate {
  dir: string;
  path: string;
  manifest: PluginManifest;
}

const MARKETPLACE_PATHS = [
  ".agents/plugins/marketplace.json",
  "marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".codex-plugin/marketplace.json",
  ".plugin/marketplace.json",
] as const;

const NATIVE_MANIFEST_PATHS = [
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".plugin/plugin.json",
] as const;

export const DOTAGENTS_MANAGED_PLUGIN_MARKER = ".dotagents-managed";

let tempInstallCounter = 0;

/** Resolves a plugin declaration to a trusted local or cached git source bundle. */
export async function resolvePlugin(
  config: PluginConfig,
  opts: PluginResolveOptions,
): Promise<ResolvedPlugin> {
  const sourceForResolve = applyDefaultRepositorySource(
    config.source,
    opts.defaultRepositorySource,
  );
  if (opts.trust) {validateTrustedSource(sourceForResolve, opts.trust);}

  const parsed = parseSource(sourceForResolve);

  if (parsed.type === "local") {
    const sourceDir = await resolveLocalSource(opts.projectRoot, parsed.path!);
    const discovered = await discoverPlugin(sourceDir, config);
    if (!discovered) {
      throw new Error(`Plugin "${config.name}" not found in ${config.source}.`);
    }
    return {
      type: "local",
      plugin: toDeclaration(config, discovered),
    };
  }

  if (parsed.type === "well-known") {
    throw new Error(
      `HTTPS well-known sources are not supported for plugins. Use a git: URL, GitHub/GitLab repository, or path: source for "${config.name}".`,
    );
  }

  const url = parsed.url!;
  const cloneUrl = parsed.cloneUrl ?? url;
  const ref = config.ref ?? parsed.ref;
  const cacheKey = parsed.type === "github"
    ? `${parsed.owner}/${parsed.repo}`
    : sanitizeCacheKey(url);
  const excluded = isSourceExcluded(config.source, opts.minimumReleaseAgeExclude);
  const cached = await ensureCached({
    stateDir: opts.stateDir,
    url: cloneUrl,
    cacheKey,
    ref,
    minimumReleaseAge: excluded ? undefined : opts.minimumReleaseAge,
  });

  const discovered = await discoverPlugin(cached.repoDir, config);
  if (!discovered) {
    throw new Error(`Plugin "${config.name}" not found in ${config.source}.`);
  }

  return {
    type: "git",
    resolvedUrl: cloneUrl,
    resolvedPath: discovered.path,
    resolvedRef: ref,
    commit: cached.commit,
    plugin: toDeclaration(config, discovered),
  };
}

/** Copies a resolved plugin bundle into `.agents/plugins/<name>/` safely. */
export async function installPluginBundle(
  pluginsDir: string,
  resolved: ResolvedPlugin,
): Promise<PluginDeclaration> {
  const destDir = join(pluginsDir, resolved.plugin.name);
  if (isProjectPluginSource(resolved.plugin.pluginDir, pluginsDir)) {
    throw new Error(
      `Plugin "${resolved.plugin.name}" source resolves inside this project's .agents/plugins/ tree. Same-project plugins in .agents/plugins/ cannot be installed into the same project.`,
    );
  }
  const installed = { ...resolved.plugin, pluginDir: destDir };
  const tempDir = join(
    pluginsDir,
    `.${resolved.plugin.name}.tmp-${process.pid}-${Date.now()}-${tempInstallCounter++}`,
  );
  const backupDir = join(
    pluginsDir,
    `.${resolved.plugin.name}.backup-${process.pid}-${Date.now()}-${tempInstallCounter++}`,
  );

  try {
    await copyDir(resolved.plugin.pluginDir, tempDir);
    const staged = { ...resolved.plugin, pluginDir: tempDir };
    await ensureCanonicalManifest(staged);
    await writeManagedMarker(tempDir);

    if (existsSync(destDir)) {
      await rename(destDir, backupDir);
      try {
        await rename(tempDir, destDir);
      } catch (err) {
        await rename(backupDir, destDir).catch(() => {});
        throw err;
      }
      await rm(backupDir, { recursive: true, force: true });
    } else {
      await rename(tempDir, destDir);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }

  return installed;
}

/** Loads installed plugin bundles declared in config and reports recoverable issues. */
export async function loadInstalledPlugins(
  pluginsDir: string,
  configs: PluginConfig[],
): Promise<{ plugins: PluginDeclaration[]; issues: string[] }> {
  const plugins: PluginDeclaration[] = [];
  const issues: string[] = [];

  for (const config of configs) {
    const pluginDir = join(pluginsDir, config.name);
    if (!existsSync(pluginDir)) {
      issues.push(`Plugin "${config.name}" is in agents.toml but not installed. Run 'npx @sentry/dotagents install'.`);
      continue;
    }
    try {
      const manifest = await loadManifest(pluginDir) ?? { name: config.name };
      assertPluginName(config.name, manifest, pluginDir);
      plugins.push({
        name: config.name,
        source: config.source,
        pluginDir,
        manifest: normalizeManifest(config.name, manifest),
        targets: config.targets,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push(`Failed to load installed plugin "${config.name}": ${message}`);
    }
  }

  return { plugins, issues };
}

/** Removes installed plugin bundles by lockfile name using path-safe names only. */
export async function pruneInstalledPlugins(
  pluginsDir: string,
  names: Iterable<string>,
): Promise<string[]> {
  if (!existsSync(pluginsDir)) {return [];}

  const pruned: string[] = [];
  for (const name of names) {
    const pluginPath = managedPluginPath(pluginsDir, name);
    if (!pluginPath || !existsSync(pluginPath)) {continue;}
    await rm(pluginPath, { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}

/** Returns true when an existing plugin bundle was previously installed by dotagents. */
export function isManagedPluginInstall(pluginDir: string): boolean {
  return existsSync(join(pluginDir, DOTAGENTS_MANAGED_PLUGIN_MARKER));
}

/** Converts a resolved plugin to its lockfile entry. */
export function lockEntryForPlugin(resolved: ResolvedPlugin): LockedPlugin {
  if (resolved.type === "local") {
    return { source: resolved.plugin.source };
  }
  return {
    source: resolved.plugin.source,
    resolved_url: resolved.resolvedUrl,
    resolved_path: resolved.resolvedPath,
    ...(resolved.resolvedRef === undefined ? {} : { resolved_ref: resolved.resolvedRef }),
    resolved_commit: resolved.commit,
  };
}

/** Returns true for direct `path:.agents/plugins/...` plugin sources. */
export function isInPlacePluginSource(source: string): boolean {
  let parsed: ReturnType<typeof parseSource>;
  try {
    parsed = parseSource(source);
  } catch {
    return false;
  }
  if (parsed.type !== "local" || !parsed.path) {return false;}

  const normalized = posix.normalize(parsed.path.replaceAll("\\", "/")).replace(/^\.\//, "");
  return normalized.startsWith(".agents/plugins/");
}

/** Returns true when a resolved plugin source lives inside the project plugin tree. */
export function isProjectPluginSource(
  pluginDir: string,
  pluginsDir: string,
): boolean {
  const rootPath = resolve(pluginsDir);
  const relPath = relative(rootPath, resolve(pluginDir));
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

/** Returns true when a plugin config resolves back into this project's managed plugin tree. */
export function isSameProjectPluginConfig(
  plugin: Pick<PluginConfig, "name" | "source" | "path">,
  pluginsDir: string,
  projectRoot: string,
): boolean {
  if (isInPlacePluginSource(plugin.source)) {return true;}

  try {
    const parsed = parseSource(plugin.source);
    if (parsed.type !== "local" || !parsed.path) {return false;}
    const sourceDir = resolve(projectRoot, parsed.path);
    const pluginDir = plugin.path
      ? resolve(sourceDir, plugin.path)
      : resolve(sourceDir, ".agents", "plugins", plugin.name);
    if (!plugin.path && !existsSync(pluginDir)) {return false;}
    const relPath = relative(sourceDir, pluginDir);
    if (relPath.startsWith("..") || isAbsolute(relPath)) {return false;}
    return isProjectPluginSource(pluginDir, pluginsDir);
  } catch {
    return false;
  }
}

async function discoverPlugin(
  sourceDir: string,
  config: PluginConfig,
): Promise<PluginCandidate | null> {
  if (config.path) {
    const dir = await resolveInside(sourceDir, config.path, "Plugin path");
    return loadPluginCandidate(sourceDir, dir, { name: config.name });
  }

  const matches: PluginCandidate[] = [];
  const canonicalDir = await resolveInside(sourceDir, join(".agents", "plugins", config.name), "Canonical plugin source");
  const canonical = await loadPluginCandidate(sourceDir, canonicalDir);
  if (canonical && candidateMatches(config.name, canonical)) {
    return canonical;
  }

  const unsupportedMarketplaceSources: string[] = [];
  const fromMarketplace = await discoverFromMarketplaces(sourceDir, config.name, unsupportedMarketplaceSources);
  if (fromMarketplace) {return fromMarketplace;}

  for (const dir of [sourceDir, join(sourceDir, "plugins", config.name)]) {
    const candidate = await loadPluginCandidate(sourceDir, dir);
    if (candidate && candidateMatches(config.name, candidate)) {matches.push(candidate);}
  }

  const recursive = await scanPluginDirectories(sourceDir, join(sourceDir, "plugins"), config.name);
  matches.push(...recursive);

  const unique = rankedCandidates(config.name, matches);
  if (unique.length > 1) {
    throw new Error(
      `Plugin "${config.name}" is ambiguous in ${config.source}: ${unique.map((m) => m.path).join(", ")}`,
    );
  }
  if (unique.length === 0 && unsupportedMarketplaceSources.length > 0) {
    throw new Error(
      `Plugin "${config.name}" not found in ${config.source}. Matching marketplace entries use unsupported source types: ${[...new Set(unsupportedMarketplaceSources)].join(", ")}. Only local marketplace sources are supported.`,
    );
  }
  return unique[0] ?? null;
}

/**
 * Reads marketplace selector files and resolves only explicit local sources.
 * Relative paths are anchored at the marketplace file directory, plus any
 * marketplace-level `metadata.pluginRoot` prefix.
 */
async function discoverFromMarketplaces(
  sourceDir: string,
  name: string,
  unsupportedSources: string[],
): Promise<PluginCandidate | null> {
  for (const marketplacePath of MARKETPLACE_PATHS) {
    const filePath = join(sourceDir, marketplacePath);
    if (!existsSync(filePath)) {continue;}

    let marketplace: ReturnType<typeof parsePluginMarketplace>;
    try {
      marketplace = parsePluginMarketplace(await readJson(filePath), filePath);
    } catch {
      continue;
    }
    const root = typeof marketplace.metadata?.pluginRoot === "string"
      ? marketplace.metadata.pluginRoot
      : ".";
    for (const entry of marketplace.plugins) {
      if (entry.name !== name) {continue;}

      const path = localMarketplacePath(entry);
      if (!path) {
        unsupportedSources.push(marketplaceSourceType(entry));
        continue;
      }

      const marketplaceRoot = dirname(filePath);
      const pluginDir = await resolveInside(marketplaceRoot, join(root, path), "Marketplace plugin source");
      const candidate = await loadPluginCandidate(sourceDir, pluginDir, marketplaceManifestOverlay(entry));
      if (candidate) {return candidate;}
    }
  }

  return null;
}

async function scanPluginDirectories(
  sourceRoot: string,
  dir: string,
  name: string,
  depth = 2,
): Promise<PluginCandidate[]> {
  if (depth <= 0 || !existsSync(dir)) {return [];}

  const matches: PluginCandidate[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {continue;}
    const childDir = join(dir, entry.name);
    const candidate = await loadPluginCandidate(sourceRoot, childDir);
    if (candidate && candidateMatches(name, candidate)) {
      matches.push(candidate);
      continue;
    }
    matches.push(...await scanPluginDirectories(sourceRoot, childDir, name, depth - 1));
  }
  return matches;
}

async function loadPluginCandidate(
  sourceRoot: string,
  pluginDir: string,
  overlay: Partial<PluginManifest> = {},
): Promise<PluginCandidate | null> {
  if (!existsSync(pluginDir)) {return null;}
  await assertInsideSourceRoot(sourceRoot, pluginDir, "Plugin source");

  const manifest = await loadManifest(pluginDir);
  if (!manifest && !await hasPluginComponents(pluginDir)) {return null;}

  const name = manifest && typeof manifest["name"] === "string"
    ? String(manifest["name"])
    : typeof overlay["name"] === "string"
      ? String(overlay["name"])
      : basename(pluginDir);
  const combined = normalizeManifest(name, { ...overlay, ...manifest });
  return {
    dir: pluginDir,
    path: relativePath(sourceRoot, pluginDir),
    manifest: combined,
  };
}

function marketplaceManifestOverlay(
  entry: MarketplacePluginEntry,
): Partial<PluginManifest> {
  const overlay: Partial<PluginManifest> = { name: entry.name };
  if (entry.description) {overlay.description = entry.description;}
  if (entry.version) {overlay.version = entry.version;}
  if (entry.category) {overlay.category = entry.category;}
  return overlay;
}

async function loadManifest(pluginDir: string): Promise<PluginManifest | null> {
  for (const manifestPath of NATIVE_MANIFEST_PATHS) {
    const filePath = join(pluginDir, manifestPath);
    if (!existsSync(filePath)) {continue;}
    return parsePluginManifest(await readJson(filePath), filePath);
  }
  return null;
}

async function hasPluginComponents(pluginDir: string): Promise<boolean> {
  const paths = [
    "skills",
    "agents",
    "commands",
    "rules",
    "hooks/hooks.json",
    ".mcp.json",
    "mcp.json",
    ".lsp.json",
    ".app.json",
    "monitors/monitors.json",
    "bin",
    "SKILL.md",
  ];
  return paths.some((path) => existsSync(join(pluginDir, path)));
}

async function ensureCanonicalManifest(plugin: PluginDeclaration): Promise<void> {
  const filePath = join(plugin.pluginDir, "plugin.json");
  if (existsSync(filePath)) {return;}
  await writeFile(filePath, `${JSON.stringify(plugin.manifest, null, 2)}\n`, "utf-8");
}

async function writeManagedMarker(pluginDir: string): Promise<void> {
  await writeFile(join(pluginDir, DOTAGENTS_MANAGED_PLUGIN_MARKER), "managedBy=dotagents\n", "utf-8");
}

function toDeclaration(
  config: PluginConfig,
  candidate: PluginCandidate,
): PluginDeclaration {
  assertPluginName(config.name, candidate.manifest, candidate.path);
  return {
    name: config.name,
    source: config.source,
    pluginDir: candidate.dir,
    manifest: normalizeManifest(config.name, candidate.manifest),
    targets: config.targets,
  };
}

function assertPluginName(
  expected: string,
  manifest: PluginManifest,
  context: string,
): void {
  const actual = manifest["name"];
  if (typeof actual === "string" && actual !== expected) {
    throw new Error(`Plugin manifest name "${actual}" does not match configured name "${expected}" in ${context}.`);
  }
}

function normalizeManifest(
  name: string,
  manifest: PluginManifest,
): PluginManifest {
  return { ...manifest, name };
}

function candidateMatches(name: string, candidate: PluginCandidate): boolean {
  return basename(candidate.dir) === name || candidate.manifest["name"] === name;
}

/** Applies discovery precedence: directory-name matches win before manifest-name fallback. */
function rankedCandidates(name: string, candidates: PluginCandidate[]): PluginCandidate[] {
  const unique = dedupeCandidates(candidates);
  const directoryMatches = unique.filter((candidate) => basename(candidate.dir) === name);
  return directoryMatches.length > 0
    ? directoryMatches
    : unique.filter((candidate) => candidate.manifest["name"] === name);
}

function dedupeCandidates(candidates: PluginCandidate[]): PluginCandidate[] {
  const seen = new Set<string>();
  const result: PluginCandidate[] = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.dir);
    if (seen.has(key)) {continue;}
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/** Returns local marketplace paths; unsupported extension sources are skipped. */
function localMarketplacePath(entry: MarketplacePluginEntry): string | null {
  const { source } = entry;
  if (typeof source === "string") {return stripDotSlash(source);}

  if (source.source === "local" && typeof source.path === "string") {
    return stripDotSlash(source.path);
  }
  return null;
}

function marketplaceSourceType(entry: MarketplacePluginEntry): string {
  const { source } = entry;
  if (typeof source === "string") {return "local";}
  return source.source ?? "extension";
}

function stripDotSlash(path: string): string {
  return path.replace(/^\.\//, "");
}

/** Resolves a selector path while preserving the source-root containment boundary. */
async function resolveInside(root: string, childPath: string, label: string): Promise<string> {
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, childPath);
  const relPath = relative(rootPath, filePath);
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`${label} resolves outside source: ${childPath}`);
  }
  if (existsSync(filePath)) {
    await assertInsideSourceRoot(rootPath, filePath, label, childPath);
  }
  return filePath;
}

async function assertInsideSourceRoot(
  root: string,
  filePath: string,
  label: string,
  displayPath = relativePath(root, filePath),
): Promise<void> {
  const rootRealPath = await realpath(root);
  const fileRealPath = await realpath(filePath);
  const realRelPath = relative(rootRealPath, fileRealPath);
  if (realRelPath.startsWith("..") || isAbsolute(realRelPath)) {
    throw new Error(`${label} resolves outside source: ${displayPath}`);
  }
}

function managedPluginPath(pluginsDir: string, name: string): string | null {
  const rootPath = resolve(pluginsDir);
  const pluginPath = resolve(rootPath, name);
  const relPath = relative(rootPath, pluginPath);
  if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) {return null;}
  if (relPath.includes("/") || relPath.includes("\\")) {return null;}
  return pluginPath;
}

function relativePath(root: string, filePath: string): string {
  return relative(root, filePath).split("\\").join("/");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}
