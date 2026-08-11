import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
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
import { PLUGIN_NAME_PATTERN, type PluginConfig } from "../config/schema.js";
import type { LockedPlugin } from "../lockfile/schema.js";
import {
  parsePluginManifest,
  parsePluginMarketplace,
  isStandardPluginManifest,
  type MarketplacePluginEntry,
  type LegacyPluginManifest,
  type PluginManifest,
} from "./schema.js";
import { isManagedJsonFile } from "./managed-files.js";
import type { NativePluginSource, PluginDeclaration } from "./types.js";

// Owns plugin source discovery and installation into the canonical project tree.
// Resolved sources are never allowed to live inside the same project's
// `.agents/plugins` tree because installs replace managed destination dirs.
export interface PluginResolveOptions {
  stateDir: string;
  projectRoot: string;
  defaultRepositorySource?: RepositorySource;
  minimumReleaseAge?: number;
  minimumReleaseAgeExclude?: string[];
  trust?: TrustPolicy;
  /** Reuse an existing git checkout without fetching. Missing checkouts are still cloned. */
  refresh?: boolean;
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

type PluginCandidateOrigin = "explicit" | "root" | "marketplace" | "canonical" | "conventional";

export interface PluginCandidate {
  name: string;
  dir: string;
  path: string;
  manifest: PluginManifest;
  nativeSource?: NativePluginSource;
  origin: PluginCandidateOrigin;
}

interface PluginCatalog {
  candidates: PluginCandidate[];
  unsupportedMarketplaceSources: Map<string, string[]>;
  marketplaceOutcomes: Map<string, Array<
    | { candidate: PluginCandidate }
    | { error: Error }
  >>;
  issues: Array<{
    name?: string;
    path?: string;
    origin: Exclude<PluginCandidateOrigin, "explicit">;
    error: Error;
    blocksNamedResolution: boolean;
  }>;
}

const MARKETPLACE_PATHS = [
  ".agents/plugins/marketplace.json",
  "marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".codex-plugin/marketplace.json",
  ".plugin/marketplace.json",
] as const;

const MANIFEST_PATHS: ReadonlyArray<{ path: string; nativeSource?: NativePluginSource }> = [
  { path: "plugin.json" },
  { path: ".codex-plugin/plugin.json", nativeSource: "codex" },
  { path: ".claude-plugin/plugin.json", nativeSource: "claude" },
  { path: ".cursor-plugin/plugin.json", nativeSource: "cursor" },
  { path: ".plugin/plugin.json" },
] as const;

export const DOTAGENTS_MANAGED_PLUGIN_MARKER = ".dotagents-managed";
const DOTAGENTS_NATIVE_SOURCE_MARKER = ".dotagents-native-source";

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
    const discovered = await resolvePluginCandidate(sourceDir, config);
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
    refresh: opts.refresh,
  });

  const discovered = await resolvePluginCandidate(cached.repoDir, config);
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
    const sourceDir = await realpath(resolved.plugin.pluginDir);
    await copyDir(sourceDir, tempDir, { verbatimSymlinks: true });
    await removeSourceOwnershipMarkers(tempDir);
    await assertPluginBundleSymlinksContained(tempDir);
    const staged = { ...resolved.plugin, pluginDir: tempDir };
    await ensureCanonicalManifest(staged);
    await writeNativeSourceMarker(staged);
    await writeManagedMarker(tempDir);

    if (existsSync(destDir)) {
      await rename(destDir, backupDir);
      try {
        await rename(tempDir, destDir);
      } catch (err) {
        await rename(backupDir, destDir).catch(() => {});
        throw err;
      }
      // The new destination is committed; backup cleanup must not turn a
      // successful install into a failure that prevents lockfile updates.
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await rename(tempDir, destDir);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return installed;
}

/** Loads installed plugin bundles declared in config and reports recoverable issues. */
export async function loadInstalledPlugins(
  pluginsDir: string,
  configs: PluginConfig[],
): Promise<{ plugins: PluginDeclaration[]; issues: Array<{ name: string; issue: string }> }> {
  const plugins: PluginDeclaration[] = [];
  const issues: Array<{ name: string; issue: string }> = [];

  for (const config of configs) {
    const pluginDir = join(pluginsDir, config.name);
    if (!existsSync(pluginDir)) {
      issues.push({
        name: config.name,
        issue: `Plugin "${config.name}" is in agents.toml but not installed. Run 'npx @sentry/dotagents install'.`,
      });
      continue;
    }
    try {
      await assertInsideSourceRoot(pluginsDir, pluginDir, "Installed plugin");
      await assertPluginBundleSymlinksContained(pluginDir);
      const loaded = await loadManifest(pluginDir);
      if (!loaded) {
        throw new Error("Plugin bundle has no plugin.json or supported native manifest");
      }
      const manifest = loaded.manifest;
      await validateStandardBundleLayout(pluginDir, manifest, true);
      assertPluginName(config.name, manifest, pluginDir);
      plugins.push({
        name: config.name,
        source: config.source,
        pluginDir,
        manifest: normalizeManifest(config.name, manifest),
        nativeSource: await readNativeSourceMarker(pluginDir) ?? loaded?.nativeSource,
        targets: config.targets,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({ name: config.name, issue: `Failed to load installed plugin "${config.name}": ${message}` });
    }
  }

  return { plugins, issues };
}

async function assertPluginBundleSymlinksContained(pluginDir: string): Promise<void> {
  const rootRealPath = await realpath(pluginDir);

  const visit = async (dirPath: string): Promise<void> => {
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isSymbolicLink()) {
        let targetRealPath: string;
        try {
          targetRealPath = await realpath(entryPath);
        } catch (err) {
          throw new Error(
            `Plugin bundle contains an invalid symlink: ${relativePath(pluginDir, entryPath)}`,
            { cause: err },
          );
        }
        const targetRelativePath = relative(rootRealPath, targetRealPath);
        if (isOutsideRelativePath(targetRelativePath)) {
          throw new Error(
            `Plugin bundle symlink resolves outside the plugin directory: ${relativePath(pluginDir, entryPath)}`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  };

  await visit(pluginDir);
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
    if (!await isManagedPluginInstall(pluginPath)) {continue;}
    await rm(pluginPath, { recursive: true, force: true });
    pruned.push(name);
  }
  return pruned;
}

/** Returns true when an existing plugin bundle was previously installed by dotagents. */
export async function isManagedPluginInstall(pluginDir: string): Promise<boolean> {
  const markerPath = join(pluginDir, DOTAGENTS_MANAGED_PLUGIN_MARKER);
  try {
    const markerStat = await lstat(markerPath);
    return markerStat.isFile() && await readFile(markerPath, "utf-8") === "managedBy=dotagents\n";
  } catch (err) {
    if (isNotFoundError(err) || isNotDirectoryError(err)) {return false;}
    throw err;
  }
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
  return relPath === "" || !isOutsideRelativePath(relPath);
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
    if (isOutsideRelativePath(relPath)) {return false;}
    return isProjectPluginSource(pluginDir, pluginsDir);
  } catch {
    return false;
  }
}

async function resolvePluginCandidate(
  sourceDir: string,
  config: PluginConfig,
): Promise<PluginCandidate | null> {
  if (config.path) {
    const dir = await resolveInside(sourceDir, config.path, "Plugin path");
    return loadPluginCandidate(sourceDir, dir, { name: config.name }, "Plugin source", "explicit");
  }

  const catalog = await discoverPluginCatalog(sourceDir);
  return resolveNamedPluginCandidate(catalog, config);
}

function resolveNamedPluginCandidate(
  catalog: PluginCatalog,
  config: Pick<PluginConfig, "name" | "source">,
): PluginCandidate | null {
  const { candidates } = catalog;
  const canonicalPath = posix.join(".agents", "plugins", config.name);
  const canonical = candidates.find((candidate) => candidate.path === canonicalPath);
  if (canonical && candidateMatches(config.name, canonical)) {
    return canonical;
  }

  const canonicalIssue = catalog.issues.find(
    (issue) => issue.origin === "canonical" && issue.path === canonicalPath,
  );
  if (canonicalIssue) {throw canonicalIssue.error;}

  const marketplaceOutcome = catalog.marketplaceOutcomes.get(config.name)?.[0];
  if (marketplaceOutcome && "error" in marketplaceOutcome) {
    throw marketplaceOutcome.error;
  }
  if (marketplaceOutcome) {return marketplaceOutcome.candidate;}

  const conventionalIssue = catalog.issues.find(
    (issue) => issue.origin === "conventional" &&
      issue.blocksNamedResolution && issue.name === config.name,
  );
  if (conventionalIssue) {throw conventionalIssue.error;}

  const unique = rankedCandidates(
    config.name,
    candidates.filter((candidate) => candidate.origin !== "marketplace"),
  );
  if (unique.length > 1) {
    throw new Error(
      `Plugin "${config.name}" is ambiguous in ${config.source}: ${unique.map((m) => m.path).join(", ")}`,
    );
  }
  const unsupportedMarketplaceSources = catalog.unsupportedMarketplaceSources.get(config.name) ?? [];
  if (unique.length === 0 && unsupportedMarketplaceSources.length > 0) {
    throw new Error(
      `Plugin "${config.name}" not found in ${config.source}. Matching marketplace entries use unsupported source types: ${[...new Set(unsupportedMarketplaceSources)].join(", ")}. Only local marketplace sources are supported.`,
    );
  }
  const rootIssue = catalog.issues.find((issue) => issue.origin === "root");
  if (unique.length === 0 && rootIssue) {throw rootIssue.error;}
  return unique[0] ?? null;
}

/** Discovers valid plugins from supported source locations. */
export async function discoverPlugins(
  sourceDir: string,
  requestedNames?: string[],
): Promise<PluginCandidate[]> {
  const catalog = await discoverPluginCatalog(sourceDir);
  let candidates = catalog.candidates;
  if (requestedNames?.length) {
    const requested: PluginCandidate[] = [];
    for (const name of requestedNames) {
      const candidate = resolveNamedPluginCandidate(catalog, { name, source: sourceDir });
      if (candidate) {requested.push(candidate);}
    }
    if (requested.length > 0) {
      candidates = await dedupeCandidates(requested);
    }
  } else if (catalog.issues[0]) {
    throw catalog.issues[0].error;
  }
  for (const candidate of candidates) {
    await assertPluginBundleSymlinksContained(candidate.dir);
  }
  return candidates;
}

async function discoverPluginCatalog(sourceDir: string): Promise<PluginCatalog> {
  const candidates: PluginCandidate[] = [];
  const issues: PluginCatalog["issues"] = [];

  try {
    const root = await loadPluginCandidate(sourceDir, sourceDir, {}, "Plugin source", "root");
    if (root) {candidates.push(root);}
  } catch (err) {
    issues.push({
      path: "",
      origin: "root",
      error: err instanceof Error ? err : new Error(String(err)),
      blocksNamedResolution: false,
    });
  }

  const marketplace = await discoverFromMarketplaces(sourceDir);
  candidates.push(...marketplace.candidates);
  issues.push(...marketplace.issues);
  candidates.push(...await scanPluginDirectories(
    sourceDir,
    join(sourceDir, ".agents", "plugins"),
    2,
    "Canonical plugin source",
    "canonical",
    issues,
    marketplace.referencedDirs,
  ));
  candidates.push(...await scanPluginDirectories(
    sourceDir,
    join(sourceDir, "plugins"),
    2,
    "Plugin source",
    "conventional",
    issues,
    marketplace.referencedDirs,
  ));

  return {
    candidates: await dedupeCandidates(candidates),
    unsupportedMarketplaceSources: marketplace.unsupportedSources,
    marketplaceOutcomes: marketplace.outcomes,
    issues,
  };
}

/**
 * Reads marketplace selector files and resolves only explicit local sources.
 * Relative paths prefer the repository root used by current Claude
 * marketplaces, then fall back to the marketplace file directory for legacy
 * catalogs. Both forms remain contained by the source root.
 */
async function discoverFromMarketplaces(
  sourceDir: string,
): Promise<{
  candidates: PluginCandidate[];
  unsupportedSources: Map<string, string[]>;
  outcomes: PluginCatalog["marketplaceOutcomes"];
  issues: PluginCatalog["issues"];
  referencedDirs: Set<string>;
}> {
  const candidates: PluginCandidate[] = [];
  const unsupportedSources = new Map<string, string[]>();
  const outcomes: PluginCatalog["marketplaceOutcomes"] = new Map();
  const issues: PluginCatalog["issues"] = [];
  const referencedDirs = new Set<string>();
  for (const marketplacePath of MARKETPLACE_PATHS) {
    const filePath = join(sourceDir, marketplacePath);
    if (!existsSync(filePath)) {continue;}

    let marketplace: ReturnType<typeof parsePluginMarketplace>;
    try {
      marketplace = parsePluginMarketplace(await readJson(filePath), filePath);
    } catch (err) {
      issues.push({
        origin: "marketplace",
        error: err instanceof Error ? err : new Error(String(err)),
        blocksNamedResolution: false,
      });
      continue;
    }
    const root = typeof marketplace.metadata?.pluginRoot === "string"
      ? marketplace.metadata.pluginRoot
      : ".";
    for (const entry of marketplace.plugins) {
      const path = localMarketplacePath(entry);
      if (!path) {
        const sources = unsupportedSources.get(entry.name) ?? [];
        sources.push(marketplaceSourceType(entry));
        unsupportedSources.set(entry.name, sources);
        continue;
      }
      const marketplaceRoot = dirname(filePath);
      let pluginDir: string | undefined;
      let candidate: PluginCandidate | null;
      try {
        candidate = null;
        const resolutionErrors: Error[] = [];
        const anchors = [...new Set([sourceDir, marketplaceRoot])];
        for (const anchor of anchors) {
          let resolvedDir: string;
          try {
            resolvedDir = await resolveMarketplaceSource(
              sourceDir,
              anchor,
              join(root, path),
              "Marketplace plugin source",
            );
          } catch (err) {
            resolutionErrors.push(err instanceof Error ? err : new Error(String(err)));
            continue;
          }
          const resolvedCandidate = await loadPluginCandidate(
            sourceDir,
            resolvedDir,
            marketplaceManifestOverlay(entry),
            "Marketplace plugin source",
            "marketplace",
          );
          if (!resolvedCandidate) {continue;}
          pluginDir = resolvedDir;
          candidate = resolvedCandidate;
          break;
        }
        if (!candidate && resolutionErrors.length === anchors.length) {
          throw resolutionErrors[0]!;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        issues.push({
          name: entry.name,
          origin: "marketplace",
          error,
          blocksNamedResolution: true,
        });
        const namedOutcomes = outcomes.get(entry.name) ?? [];
        namedOutcomes.push({ error });
        outcomes.set(entry.name, namedOutcomes);
        continue;
      }
      if (!candidate) {
        const error = new Error(
          `Marketplace plugin "${entry.name}" in ${filePath} has no supported plugin manifest at ${path}.`,
        );
        issues.push({
          name: entry.name,
          origin: "marketplace",
          error,
          blocksNamedResolution: true,
        });
        const namedOutcomes = outcomes.get(entry.name) ?? [];
        namedOutcomes.push({ error });
        outcomes.set(entry.name, namedOutcomes);
        continue;
      }
      referencedDirs.add(resolve(pluginDir!));
      candidates.push(candidate);
      const namedOutcomes = outcomes.get(entry.name) ?? [];
      namedOutcomes.push({ candidate });
      outcomes.set(entry.name, namedOutcomes);
    }
  }
  return { candidates, unsupportedSources, outcomes, issues, referencedDirs };
}

async function scanPluginDirectories(
  sourceRoot: string,
  dir: string,
  depth = 2,
  label = "Plugin source",
  origin: PluginCandidateOrigin = "conventional",
  issues: PluginCatalog["issues"] = [],
  skippedDirs: ReadonlySet<string> = new Set(),
): Promise<PluginCandidate[]> {
  if (depth <= 0 || !await isDirectory(dir)) {return [];}

  const matches: PluginCandidate[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) {continue;}
    const childDir = join(dir, entry.name);
    if (skippedDirs.has(resolve(childDir))) {continue;}
    let candidate: PluginCandidate | null;
    try {
      candidate = await loadPluginCandidate(sourceRoot, childDir, {}, label, origin);
    } catch (err) {
      issues.push({
        name: entry.name,
        path: relativePath(sourceRoot, childDir),
        origin: origin === "canonical" ? "canonical" : "conventional",
        error: err instanceof Error ? err : new Error(String(err)),
        blocksNamedResolution: true,
      });
      candidate = null;
    }
    if (candidate) {
      matches.push(candidate);
      continue;
    }
    matches.push(...await scanPluginDirectories(
      sourceRoot,
      childDir,
      depth - 1,
      label,
      origin,
      issues,
      skippedDirs,
    ));
  }
  return matches;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (isNotFoundError(err)) {return false;}
    throw err;
  }
}

async function loadPluginCandidate(
  sourceRoot: string,
  pluginDir: string,
  overlay: Partial<LegacyPluginManifest> = {},
  label = "Plugin source",
  origin: PluginCandidateOrigin = "root",
): Promise<PluginCandidate | null> {
  if (!existsSync(pluginDir)) {return null;}
  await assertInsideSourceRoot(sourceRoot, pluginDir, label);

  const loaded = await loadManifest(pluginDir);
  if (!loaded) {return null;}
  const manifest = loaded.manifest;
  await validateStandardBundleLayout(pluginDir, manifest, false);

  const name = manifest && typeof manifest["name"] === "string"
    ? String(manifest["name"])
    : typeof overlay["name"] === "string"
      ? String(overlay["name"])
      : basename(pluginDir);
  const combined = manifest && isStandardPluginManifest(manifest)
    ? manifest
    : normalizeManifest(name, { ...overlay, ...manifest } as LegacyPluginManifest);
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid plugin name "${name}" in ${relativePath(sourceRoot, pluginDir) || "."}. ` +
        "Plugin names must be 1-64 lowercase letters, numbers, hyphens, or dots, have alphanumeric ends, and not contain '--' or '..'.",
    );
  }
  return {
    name,
    dir: pluginDir,
    path: relativePath(sourceRoot, pluginDir),
    manifest: combined,
    nativeSource: loaded?.nativeSource,
    origin,
  };
}

function marketplaceManifestOverlay(
  entry: MarketplacePluginEntry,
): Partial<LegacyPluginManifest> {
  const overlay: Partial<LegacyPluginManifest> = { name: entry.name };
  if (entry.description) {overlay.description = entry.description;}
  if (entry.version) {overlay.version = entry.version;}
  if (entry.category) {overlay.category = entry.category;}
  return overlay;
}

async function loadManifest(
  pluginDir: string,
): Promise<{ manifest: PluginManifest; nativeSource?: NativePluginSource } | null> {
  for (const candidate of MANIFEST_PATHS) {
    const filePath = join(pluginDir, candidate.path);
    if (!existsSync(filePath)) {continue;}
    return {
      manifest: parsePluginManifest(await readJson(filePath), filePath),
      nativeSource: candidate.nativeSource,
    };
  }
  return null;
}

async function validateStandardBundleLayout(
  pluginDir: string,
  manifest: PluginManifest,
  allowManagedAdapters: boolean,
): Promise<void> {
  if (!isStandardPluginManifest(manifest)) {return;}
  const legacyRoots = [
    "agents",
    "commands",
    "rules",
    "hooks",
    "monitors",
    ".mcp.json",
    ".lsp.json",
    ".app.json",
  ];
  const found = legacyRoots.filter((path) => existsSync(join(pluginDir, path)));
  for (const dir of [".claude-plugin", ".cursor-plugin", ".codex-plugin"]) {
    if (!existsSync(join(pluginDir, dir))) {continue;}
    const manifestPath = join(pluginDir, dir, "plugin.json");
    if (allowManagedAdapters && await isManagedJsonFile(manifestPath)) {continue;}
    found.push(dir);
  }
  if (found.length > 0) {
    throw new Error(
      `Agent Plugins v1 bundle contains legacy root components: ${found.join(", ")}. Move client-specific resources into reverse-domain extension directories.`,
    );
  }
}

async function removeSourceOwnershipMarkers(dir: string): Promise<void> {
  // Source-controlled markers never establish dotagents ownership or provenance.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name);
    if (
      entry.name === DOTAGENTS_MANAGED_PLUGIN_MARKER ||
      entry.name === DOTAGENTS_NATIVE_SOURCE_MARKER ||
      entry.name.endsWith(".dotagents-managed")
    ) {
      await rm(filePath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {await removeSourceOwnershipMarkers(filePath);}
  }
}

async function ensureCanonicalManifest(plugin: PluginDeclaration): Promise<void> {
  const filePath = join(plugin.pluginDir, "plugin.json");
  if (existsSync(filePath)) {return;}
  await writeFile(filePath, `${JSON.stringify(plugin.manifest, null, 2)}\n`, "utf-8");
}

async function writeManagedMarker(pluginDir: string): Promise<void> {
  await writeFile(join(pluginDir, DOTAGENTS_MANAGED_PLUGIN_MARKER), "managedBy=dotagents\n", "utf-8");
}

async function writeNativeSourceMarker(plugin: PluginDeclaration): Promise<void> {
  const filePath = join(plugin.pluginDir, DOTAGENTS_NATIVE_SOURCE_MARKER);
  if (plugin.nativeSource) {
    await writeFile(filePath, `${plugin.nativeSource}\n`, "utf-8");
  } else {
    await rm(filePath, { force: true });
  }
}

async function readNativeSourceMarker(pluginDir: string): Promise<NativePluginSource | undefined> {
  try {
    const value = (await readFile(join(pluginDir, DOTAGENTS_NATIVE_SOURCE_MARKER), "utf-8")).trim();
    return value === "claude" || value === "cursor" || value === "codex" ? value : undefined;
  } catch (err) {
    if (isNotFoundError(err)) {return undefined;}
    throw err;
  }
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
    nativeSource: candidate.nativeSource,
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
  return basename(candidate.dir) === name || candidate.name === name;
}

/** Applies discovery precedence: directory-name matches win before manifest-name fallback. */
function rankedCandidates(name: string, candidates: PluginCandidate[]): PluginCandidate[] {
  const directoryMatches = candidates.filter((candidate) => basename(candidate.dir) === name);
  return directoryMatches.length > 0
    ? directoryMatches
    : candidates.filter((candidate) => candidate.name === name);
}

async function dedupeCandidates(candidates: PluginCandidate[]): Promise<PluginCandidate[]> {
  const seen = new Set<string>();
  const result: PluginCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${await realpath(candidate.dir)}\0${candidate.name}`;
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
  if (isOutsideRelativePath(relPath)) {
    throw new Error(`${label} resolves outside source: ${childPath}`);
  }
  if (existsSync(filePath)) {
    await assertInsideSourceRoot(rootPath, filePath, label, childPath);
  }
  return filePath;
}

async function resolveMarketplaceSource(
  sourceRoot: string,
  marketplaceRoot: string,
  childPath: string,
  label: string,
): Promise<string> {
  const filePath = resolve(marketplaceRoot, childPath);
  const sourceRootPath = resolve(sourceRoot);
  const relPath = relative(sourceRootPath, filePath);
  if (isOutsideRelativePath(relPath)) {
    throw new Error(`${label} resolves outside source: ${childPath}`);
  }
  if (existsSync(filePath)) {
    await assertInsideSourceRoot(sourceRootPath, filePath, label, childPath);
  }
  return filePath;
}

async function assertInsideSourceRoot(
  root: string,
  filePath: string,
  label: string,
  displayPath = relativePath(root, filePath),
): Promise<void> {
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(root);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`${label} source root does not exist: ${displayPath}`, { cause: err });
    }
    throw err;
  }
  let fileRealPath: string;
  try {
    fileRealPath = await realpath(filePath);
  } catch (err) {
    if (isNotFoundError(err)) {
      throw new Error(`${label} source path does not exist: ${displayPath}`, { cause: err });
    }
    throw err;
  }
  const realRelPath = relative(rootRealPath, fileRealPath);
  if (isOutsideRelativePath(realRelPath)) {
    throw new Error(`${label} resolves outside source: ${displayPath}`);
  }
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function managedPluginPath(pluginsDir: string, name: string): string | null {
  const rootPath = resolve(pluginsDir);
  const pluginPath = resolve(rootPath, name);
  const relPath = relative(rootPath, pluginPath);
  if (!relPath || isOutsideRelativePath(relPath)) {return null;}
  if (relPath.includes("/") || relPath.includes("\\")) {return null;}
  return pluginPath;
}

function relativePath(root: string, filePath: string): string {
  return relative(root, filePath).split("\\").join("/");
}

function isOutsideRelativePath(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function isNotDirectoryError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOTDIR";
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON ${filePath}: ${message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}
