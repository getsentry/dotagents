import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertPluginBundleSymlinksContained,
  copyDir,
  HYBRID_LEGACY_ROOTS,
  isStandardPluginManifest,
  loadInstalledPluginBundle,
  NATIVE_PLUGIN_MANIFEST_PATHS,
  NATIVE_PLUGIN_SOURCES,
  nativePluginDisplayName,
  parseSource,
  resolvePlugin as resolvePluginSource,
  type AuthoredNativePluginInterfaces,
  type InstalledPluginProvenance,
  type NativePluginSource,
  type PluginManifest,
  type PluginResolveOptions,
  type ResolvedPlugin as ResolvedPluginSource,
} from "@sentry/dotagents-lib";
import type { PluginConfig } from "../config/schema.js";
import type { LockedPlugin } from "../lockfile/schema.js";
import { selectedAgentIds } from "./targets.js";
import type { PluginDeclaration } from "./types.js";
import { hasErrorCode, isString } from "../utils/type-guards.js";

// Owns installation into the canonical project tree. Source discovery and
// resolution live in @sentry/dotagents-lib. Resolved sources are never allowed
// to live inside the same project's `.agents/plugins` tree because installs
// replace managed destination dirs.

export type ResolvedPlugin = ResolvedPluginSource<PluginDeclaration>;

export interface PluginStoreServices {
  realpath(path: string): Promise<string>;
  rename: typeof rename;
  rm: typeof rm;
}

const DEFAULT_PLUGIN_STORE_SERVICES: PluginStoreServices = { realpath, rename, rm };

const COPILOT_GITHUB_MANIFEST_PATH = ".github/plugin/plugin.json";

export const DOTAGENTS_MANAGED_PLUGIN_MARKER = ".dotagents-managed";

export const DOTAGENTS_NATIVE_FALLBACKS_MARKER = ".dotagents-native-fallbacks";

const DOTAGENTS_NATIVE_SOURCE_MARKER = ".dotagents-native-source";

const COPILOT_UNSUPPORTED_LEGACY_FIELDS = [
  "agents",
  "commands",
  "hooks",
  "lspServers",
  "extensions",
] as const;

const COPILOT_UNSUPPORTED_STANDARD_RESOURCE_PATHS = [
  "com.github.copilot",
] as const;

const COPILOT_UNSUPPORTED_LEGACY_RESOURCE_PATHS = [
  ...COPILOT_UNSUPPORTED_STANDARD_RESOURCE_PATHS,
  "agents",
  "commands",
  "hooks.json",
  "hooks/hooks.json",
  ".lsp.json",
  "lsp.json",
  ".github/lsp.json",
] as const;

let tempInstallCounter = 0;

/** Resolves a plugin declaration to a trusted local or cached git source bundle. */
export async function resolvePlugin(
  config: PluginConfig,
  opts: PluginResolveOptions,
): Promise<ResolvedPlugin> {
  const resolved = await resolvePluginSource(config, opts);
  return { ...resolved, plugin: toDeclaration(resolved.plugin, config.targets) };
}

/** Copies a resolved plugin bundle into `.agents/plugins/<name>/` safely. */
export async function installPluginBundle(
  pluginsDir: string,
  resolved: ResolvedPlugin,
  overrides: Partial<PluginStoreServices> = {},
): Promise<PluginDeclaration> {
  const services = { ...DEFAULT_PLUGIN_STORE_SERVICES, ...overrides };
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
    const sourceDir = await services.realpath(resolved.plugin.pluginDir);
    await copyDir(sourceDir, tempDir, { verbatimSymlinks: true });
    await removeSourceOwnershipMarkers(tempDir);
    await assertPluginBundleSymlinksContained(tempDir);
    const staged = { ...resolved.plugin, pluginDir: tempDir };
    await removeRedundantNativeInterfaces(staged);
    await ensureCanonicalManifest(staged);
    await writeNativeSourceMarker(staged);
    await writeNativeFallbacksMarker(staged);
    await writeManagedMarker(tempDir);

    if (existsSync(destDir)) {
      await services.rename(destDir, backupDir);
      try {
        await services.rename(tempDir, destDir);
      } catch (err) {
        await services.rename(backupDir, destDir).catch(() => {});
        throw err;
      }
      // The new destination is committed; backup cleanup must not turn a
      // successful install into a failure that prevents lockfile updates.
      await services.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await services.rename(tempDir, destDir);
    }
  } finally {
    await services.rm(tempDir, { recursive: true, force: true });
  }

  return installed;
}

/** Loads installed plugin bundles declared in config and reports recoverable issues. */
export async function loadInstalledPlugins(
  pluginsDir: string,
  configs: PluginConfig[],
  installCommand: string,
  agentIds: string[],
): Promise<{ plugins: PluginDeclaration[]; issues: Array<{ name: string; issue: string }> }> {
  const plugins: PluginDeclaration[] = [];
  const issues: Array<{ name: string; issue: string }> = [];

  for (const config of configs) {
    const pluginDir = join(pluginsDir, config.name);
    if (!existsSync(pluginDir)) {
      issues.push({
        name: config.name,
        issue: `Plugin "${config.name}" is in agents.toml but not installed. Run '${installCommand}'.`,
      });
      continue;
    }
    try {
      const loaded = await loadInstalledPluginBundle(
        pluginsDir,
        pluginDir,
        config.name,
        readInstalledPluginProvenance,
      );
      plugins.push(preparePluginForTargets({
        ...loaded,
        source: config.source,
        targets: config.targets,
      }, agentIds));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({ name: config.name, issue: `Failed to load installed plugin "${config.name}": ${message}` });
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
  const entry: LockedPlugin = {
    source: resolved.plugin.source,
    resolved_url: resolved.resolvedUrl,
    resolved_path: resolved.resolvedPath,
    resolved_commit: resolved.commit,
  };
  if (resolved.resolvedRef !== undefined) {entry.resolved_ref = resolved.resolvedRef;}
  return entry;
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

async function removeSourceOwnershipMarkers(dir: string): Promise<void> {
  // Source-controlled markers never establish dotagents ownership or provenance.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filePath = join(dir, entry.name);
    if (
      entry.name === DOTAGENTS_MANAGED_PLUGIN_MARKER ||
      entry.name === DOTAGENTS_NATIVE_FALLBACKS_MARKER ||
      entry.name === DOTAGENTS_NATIVE_SOURCE_MARKER ||
      entry.name.endsWith(".dotagents-managed")
    ) {
      await rm(filePath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {await removeSourceOwnershipMarkers(filePath);}
  }
}

async function removeRedundantNativeInterfaces(plugin: PluginDeclaration): Promise<void> {
  for (const candidate of NATIVE_PLUGIN_MANIFEST_PATHS) {
    const nativeInterface = plugin.authoredNativeInterfaces?.[candidate.source];
    if (!nativeInterface || nativeInterface.fallback) {continue;}
    await rm(join(plugin.pluginDir, candidate.path), { force: true });
    if (
      nativeInterface.manifest?.["mcpServers"] === `./.${candidate.source}-plugin/mcp.json`
    ) {
      await rm(join(plugin.pluginDir, `.${candidate.source}-plugin`, "mcp.json"), { force: true });
    }
  }
}

async function ensureCanonicalManifest(plugin: PluginDeclaration): Promise<void> {
  const filePath = join(plugin.pluginDir, "plugin.json");
  if (existsSync(filePath)) {return;}
  await writeFile(filePath, `${JSON.stringify(plugin.manifest, null, 2)}\n`, "utf-8");
  // Marketplace-only native definitions become a manifest in the installed bundle.
  if (plugin.nativeSource) {
    const nativePath = join(plugin.pluginDir, `.${plugin.nativeSource}-plugin`, "plugin.json");
    if (!existsSync(nativePath)) {
      const manifest = plugin.authoredNativeInterfaces?.[plugin.nativeSource]?.manifest ?? plugin.manifest;
      await mkdir(dirname(nativePath), { recursive: true });
      await writeFile(nativePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    }
  }
  // Only .plugin/plugin.json outranks the new canonical root. Copilot's
  // lower-priority .github/plugin/plugin.json locator remains preserved.
  if (!plugin.nativeSource) {
    await rm(join(plugin.pluginDir, ".plugin", "plugin.json"), { force: true });
  }
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

async function writeNativeFallbacksMarker(plugin: PluginDeclaration): Promise<void> {
  const filePath = join(plugin.pluginDir, DOTAGENTS_NATIVE_FALLBACKS_MARKER);
  const sources = NATIVE_PLUGIN_SOURCES.filter(
    (source) => plugin.authoredNativeInterfaces?.[source]?.fallback,
  );
  if (sources.length === 0) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(filePath, `${sources.join("\n")}\n`, "utf-8");
}

async function readNativeFallbackSources(
  pluginDir: string,
): Promise<Set<NativePluginSource> | null> {
  let content: string;
  try {
    content = await readFile(join(pluginDir, DOTAGENTS_NATIVE_FALLBACKS_MARKER), "utf-8");
  } catch (err) {
    if (isNotFoundError(err)) {return null;}
    throw err;
  }

  const values = content.split("\n").filter(Boolean);
  const sources = new Set<NativePluginSource>();
  for (const value of values) {
    const source = NATIVE_PLUGIN_SOURCES.find((candidate) => candidate === value);
    if (!source || sources.has(source)) {
      throw new Error(`Invalid native fallback provenance: ${value || "<empty>"}`);
    }
    sources.add(source);
  }
  if (sources.size === 0) {
    throw new Error("Invalid native fallback provenance: empty marker");
  }
  return sources;
}

async function readInstalledPluginProvenance(pluginDir: string): Promise<InstalledPluginProvenance> {
  const fallbackSources = await readNativeFallbackSources(pluginDir);
  const nativeSource = await readNativeSourceMarker(pluginDir);
  if (fallbackSources && nativeSource && !fallbackSources.has(nativeSource)) {
    throw new Error("Installed plugin has conflicting native interface provenance. Reinstall the plugin.");
  }
  return { fallbackSources, nativeSource };
}

/** Returns whether installed provenance reserves a matching-client native fallback. */
export async function hasRecordedNativePluginFallback(
  pluginDir: string,
  source: NativePluginSource,
): Promise<boolean> {
  const provenance = await readInstalledPluginProvenance(pluginDir);
  return provenance.fallbackSources
    ? provenance.fallbackSources.has(source)
    : provenance.nativeSource === source;
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
  plugin: PluginDeclaration,
  targets: string[] | undefined,
): PluginDeclaration {
  return {
    ...plugin,
    compatibilityWarnings: compatibilityWarnings(
      plugin.name,
      plugin.manifest,
      plugin.authoredNativeInterfaces ?? {},
      legacyRootsFor(plugin),
      [],
    ),
    targets,
  };
}

/** Validates selected native interfaces and computes deterministic compatibility warnings. */
export function preparePluginForTargets(
  plugin: PluginDeclaration,
  agentIds: string[],
): PluginDeclaration {
  const interfaces = plugin.authoredNativeInterfaces ?? {};
  const selectedTargets = new Set(selectedAgentIds(agentIds, plugin));
  const canonicalManifestPath = join(plugin.pluginDir, "plugin.json");
  const copilotShadowPath = join(plugin.pluginDir, ".plugin", "plugin.json");
  const copilotGitHubManifestPath = join(plugin.pluginDir, COPILOT_GITHUB_MANIFEST_PATH);
  const importedFromCopilotLocator = !existsSync(canonicalManifestPath) &&
    plugin.nativeSource === undefined;
  if (
    selectedTargets.has("copilot") &&
    existsSync(copilotShadowPath) &&
    !importedFromCopilotLocator
  ) {
    throw new Error(
      `Plugin "${plugin.name}" cannot target Copilot because .plugin/plugin.json would shadow the canonical plugin.json for Copilot: ${copilotShadowPath}. Remove or rename the shadow manifest, or exclude "copilot" from this plugin's targets.`,
    );
  }
  if (
    selectedTargets.has("copilot") &&
    existsSync(copilotGitHubManifestPath) &&
    !existsSync(canonicalManifestPath) &&
    !existsSync(copilotShadowPath) &&
    plugin.nativeSource !== undefined
  ) {
    throw new Error(
      `Plugin "${plugin.name}" cannot target Copilot because dotagents selected its ${nativePluginDisplayName(plugin.nativeSource)} native manifest, but Copilot would load ${COPILOT_GITHUB_MANIFEST_PATH} instead. Remove one manifest or exclude "copilot" from this plugin's targets.`,
    );
  }
  if (selectedTargets.has("copilot")) {
    const unsupportedPaths = isStandardPluginManifest(plugin.manifest)
      ? COPILOT_UNSUPPORTED_STANDARD_RESOURCE_PATHS
      : COPILOT_UNSUPPORTED_LEGACY_RESOURCE_PATHS;
    const unsupportedRoots = unsupportedPaths.filter(
      (path) => existsSync(join(plugin.pluginDir, path)),
    );
    if (unsupportedRoots.length > 0) {
      throw new Error(
        `Plugin "${plugin.name}" cannot target Copilot because its bundle contains unsupported top-level resources: ${unsupportedRoots.join(", ")}. The Copilot projection supports skills and MCP servers, not resources Copilot would activate natively; remove those resources or exclude "copilot" from this plugin's targets.`,
      );
    }
  }
  if (selectedTargets.has("copilot")) {
    const unsupported = isStandardPluginManifest(plugin.manifest)
      ? []
      : COPILOT_UNSUPPORTED_LEGACY_FIELDS.filter(
          (field) => plugin.manifest[field] !== undefined,
        );
    if (unsupported.length > 0) {
      throw new Error(
        `Plugin "${plugin.name}" cannot target Copilot because its legacy plugin.json declares unsupported components: ${unsupported.join(", ")}. The Copilot projection supports skills and MCP servers, not components Copilot would activate natively; remove those fields or exclude "copilot" from this plugin's targets.`,
      );
    }
  }
  if (isStandardPluginManifest(plugin.manifest)) {
    assertNativeInterfaceNames(plugin.name, interfaces, plugin.pluginDir, selectedTargets);
  }
  for (const source of NATIVE_PLUGIN_SOURCES) {
    const nativeInterface = interfaces[source];
    if (!nativeInterface?.fallback || !nativeInterface.error || !selectedTargets.has(source)) {continue;}
    throw new Error(
      `Invalid ${nativePluginDisplayName(source)} native fallback for "${plugin.name}" at ${nativeInterface.path}: ${nativeInterface.error}`,
    );
  }
  return {
    ...plugin,
    compatibilityWarnings: compatibilityWarnings(
      plugin.name,
      plugin.manifest,
      interfaces,
      legacyRootsFor(plugin),
      selectedTargets,
    ),
  };
}

function legacyRootsFor(plugin: Pick<PluginDeclaration, "manifest" | "pluginDir">): string[] {
  return isStandardPluginManifest(plugin.manifest)
    ? HYBRID_LEGACY_ROOTS.filter((path) => existsSync(join(plugin.pluginDir, path)))
    : [];
}

function assertNativeInterfaceNames(
  expected: string,
  interfaces: AuthoredNativePluginInterfaces,
  context: string,
  selectedTargets: ReadonlySet<string>,
): void {
  for (const source of NATIVE_PLUGIN_SOURCES) {
    const nativeInterface = interfaces[source];
    if (!nativeInterface?.fallback) {continue;}
    const manifest = nativeInterface.manifest;
    if (!manifest) {continue;}
    const issue = nativeInterfaceNameIssue(expected, source, manifest);
    if (!issue || !selectedTargets.has(source)) {continue;}
    throw new Error(`${issue} in ${context}.`);
  }
}

function nativeInterfaceNameIssue(
  expected: string,
  source: NativePluginSource,
  manifest: PluginManifest,
): string | undefined {
  const actual = manifest["name"];
  if (actual === expected) {return undefined;}
  if (isString(actual)) {
    return `${nativePluginDisplayName(source)} native fallback manifest name "${actual}" does not match portable plugin name "${expected}"`;
  }
  return `${nativePluginDisplayName(source)} native fallback manifest is missing the portable plugin name "${expected}"`;
}

function compatibilityWarnings(
  name: string,
  manifest: PluginManifest,
  interfaces: AuthoredNativePluginInterfaces,
  legacyRoots: string[],
  selectedTargets: ReadonlySet<string> | string[],
): string[] {
  if (!isStandardPluginManifest(manifest)) {return [];}
  const warnings: string[] = [];
  const sources = NATIVE_PLUGIN_SOURCES.filter((source) => interfaces[source] !== undefined);
  const fallbackSources = sources.filter((source) => interfaces[source]?.fallback);
  const validFallbackSources = fallbackSources.filter(
    (source) => interfaces[source]?.manifest !== undefined,
  );
  if (fallbackSources.length > 0) {
    warnings.push(
      `Plugin "${name}" is a hybrid compatibility bundle: the portable core remains authoritative; authored ${validFallbackSources.map(nativePluginDisplayName).join(", ") || "native"} interfaces are retained only as matching-client fallbacks.`,
    );
  } else if (sources.length > 0) {
    warnings.push(
      `Plugin "${name}" is a hybrid compatibility bundle: the portable core remains authoritative; redundant authored native interfaces are ignored in favor of portable generation.`,
    );
  } else if (legacyRoots.length > 0) {
    warnings.push(
      `Plugin "${name}" contains ignored legacy root resources: ${legacyRoots.join(", ")}. They are preserved but are not portable plugin components.`,
    );
  }
  const selected = selectedTargets instanceof Set ? selectedTargets : new Set(selectedTargets);
  if (
    legacyRoots.length > 0 &&
    sources.length > 0 &&
    !validFallbackSources.some((source) => selected.has(source))
  ) {
    warnings.push(
      `Plugin "${name}" contains ignored legacy root resources for the selected targets: ${legacyRoots.join(", ")}. They remain available only to a matching native fallback.`,
    );
  }
  for (const source of sources) {
    const nativeInterface = interfaces[source]!;
    if (!nativeInterface.fallback) {
      warnings.push(
        `Plugin "${name}" has an authored ${nativePluginDisplayName(source)} interface that was ignored because the portable core can generate the ${nativePluginDisplayName(source)} adapter${nativeInterface.error ? `: ${nativeInterface.error}` : "."}`,
      );
      continue;
    }
    if (nativeInterface.error && !selected.has(source)) {
      warnings.push(
        `Plugin "${name}" has a malformed ${nativePluginDisplayName(source)} native fallback that was ignored because ${nativePluginDisplayName(source)} is not selected: ${nativeInterface.error}`,
      );
      continue;
    }
    const nameIssue = nativeInterface.manifest
      ? nativeInterfaceNameIssue(name, source, nativeInterface.manifest)
      : undefined;
    if (nameIssue && !selected.has(source)) {
      warnings.push(
        `Plugin "${name}" has an invalid ${nativePluginDisplayName(source)} native fallback that was ignored because ${nativePluginDisplayName(source)} is not selected: ${nameIssue}.`,
      );
      continue;
    }
    if (nativeInterface.manifest && metadataDiffers(manifest, nativeInterface.manifest)) {
      warnings.push(
        `Plugin "${name}" has differing portable and ${nativePluginDisplayName(source)} fallback metadata; the portable core remains the source of truth while ${nativePluginDisplayName(source)} receives the preserved fallback.`,
      );
    }
  }
  return warnings;
}

function metadataDiffers(portable: PluginManifest, native: PluginManifest): boolean {
  const keys = [
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
  ] as const;
  return keys.some((key) => !isDeepStrictEqual(portable[key], native[key]));
}

function isNotFoundError<ErrorValue>(err: ErrorValue): boolean {
  return hasErrorCode(err, "ENOENT");
}

function managedPluginPath(pluginsDir: string, name: string): string | null {
  const rootPath = resolve(pluginsDir);
  const pluginPath = resolve(rootPath, name);
  const relPath = relative(rootPath, pluginPath);
  if (!relPath || isOutsideRelativePath(relPath)) {return null;}
  if (relPath.includes("/") || relPath.includes("\\")) {return null;}
  return pluginPath;
}

function isOutsideRelativePath(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function isNotDirectoryError<ErrorValue>(err: ErrorValue): boolean {
  return hasErrorCode(err, "ENOTDIR");
}
