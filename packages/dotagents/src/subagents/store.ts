import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseTOML, type TomlTableWithoutBigInt } from "smol-toml";
import {
  applyDefaultRepositorySource,
  ensureCached,
  isSerializedObject,
  isSourceExcluded,
  loadMarkdownFrontmatter,
  parseSource,
  resolveLocalSource,
  sanitizeCacheKey,
  validateTrustedSource,
  type RepositorySource,
  type SerializedObject,
  type TrustPolicy,
} from "@sentry/dotagents-lib";
import { getAgent } from "../targets/registry.js";
import { hasDotagentsMarkdownSubagentMarker, serializeMarkdownSubagent } from "./format.js";
import { subagentIdentityFromMarkdownMeta } from "./identity.js";
import { SUBAGENT_NAME_PATTERN, type SubagentConfig } from "../config/schema.js";
import type { LockedSubagent } from "../lockfile/schema.js";
import type {
  NativeSubagentContent,
  NativeSubagentTarget,
  SubagentDeclaration,
  SubagentIdentityStrategy,
} from "./types.js";
import { hasErrorCode, isNonEmptyString, isString } from "../utils/type-guards.js";

const DOTAGENTS_NATIVE_FIELD = "dotagents_native";
const NATIVE_SUBAGENT_TARGETS = ["claude", "cursor", "codex", "opencode"] satisfies NativeSubagentTarget[];
let tempFileCounter = 0;

interface SubagentScanDir {
  dir: string;
  flat?: boolean;
  nativeTarget?: NativeSubagentTarget;
  extensions: readonly string[];
}

interface DiscoveredSubagent {
  path: string;
  subagent: SubagentDeclaration;
  nativeTarget?: NativeSubagentTarget;
}

const SUBAGENT_SCAN_DIRS: readonly SubagentScanDir[] = [
  { dir: "agents", extensions: [".md"] },
  { dir: ".agents/agents", extensions: [".md"] },
  { dir: ".claude/agents", nativeTarget: "claude", extensions: [".md"] },
  { dir: ".cursor/agents", nativeTarget: "cursor", extensions: [".md"] },
  { dir: ".codex/agents", nativeTarget: "codex", extensions: [".toml"] },
  { dir: ".opencode/agents", nativeTarget: "opencode", extensions: [".md"] },
] as const;

export interface SubagentResolveOptions {
  stateDir: string;
  projectRoot: string;
  defaultRepositorySource?: RepositorySource;
  minimumReleaseAge?: number;
  minimumReleaseAgeExclude?: string[];
  trust?: TrustPolicy;
}

export type ResolvedSubagentType = "git" | "local";

export interface ResolvedSubagent {
  type: ResolvedSubagentType;
  source: string;
  resolvedUrl?: string;
  resolvedPath?: string;
  resolvedRef?: string;
  commit?: string;
  subagent: SubagentDeclaration;
}

export interface InstalledSubagentLoadIssue {
  name: string;
  issue: string;
}

export class InstalledSubagentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstalledSubagentWriteError";
  }
}

export async function resolveSubagent(
  config: SubagentConfig,
  opts: SubagentResolveOptions,
): Promise<ResolvedSubagent> {
  const sourceForResolve = applyDefaultRepositorySource(
    config.source,
    opts.defaultRepositorySource,
  );
  if (opts.trust) {validateTrustedSource(sourceForResolve, opts.trust);}

  const parsed = parseSource(sourceForResolve);

  if (parsed.type === "local") {
    const sourceDir = await resolveLocalSource(opts.projectRoot, parsed.path!);
    const subagent = await loadSubagentFromSource(sourceDir, config);
    return { type: "local", source: config.source, subagent };
  }

  if (parsed.type === "well-known") {
    throw new Error(
      `HTTPS well-known sources are not supported for subagents. Use a git: URL, GitHub/GitLab repository, or path: source for "${config.name}".`,
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

  const discovered = await discoverSubagent(cached.repoDir, config);
  if (!discovered) {
    throw new Error(`Subagent "${config.name}" not found in ${config.source}.`);
  }

  return {
    type: "git",
    source: config.source,
    resolvedUrl: cloneUrl,
    resolvedPath: discovered.path,
    resolvedRef: ref,
    commit: cached.commit,
    subagent: { ...discovered.subagent, targets: config.targets },
  };
}

export async function writeInstalledSubagents(
  subagentsDir: string,
  subagents: SubagentDeclaration[],
): Promise<string[]> {
  if (subagents.length === 0 && !existsSync(subagentsDir)) {
    return [];
  }

  await mkdir(subagentsDir, { recursive: true });
  const plannedWrites: Array<{
    filePath: string;
    content: string;
    previous?: string;
  }> = [];

  for (const subagent of subagents) {
    const fileName = `${subagent.name}.md`;
    const filePath = join(subagentsDir, fileName);
    const content = serializeInstalledSubagent(subagent);
    const previous = await readManagedInstalledSubagentFile(filePath);
    if (previous !== content) {
      plannedWrites.push({ filePath, content, previous });
    }
  }

  const written: string[] = [];
  let attempted: (typeof plannedWrites)[number] | undefined;
  try {
    for (const planned of plannedWrites) {
      attempted = planned;
      await replaceFileAtomic(planned.filePath, planned.content);
      written.push(planned.filePath);
      attempted = undefined;
    }
  } catch (err) {
    const rollbackWrites = attempted
      ? [...plannedWrites.slice(0, written.length), attempted]
      : plannedWrites.slice(0, written.length);
    for (const planned of rollbackWrites.toReversed()) {
      if (planned.previous === undefined) {
        await rm(planned.filePath, { force: true });
      } else {
        await replaceFileAtomic(planned.filePath, planned.previous);
      }
    }
    throw err;
  }

  return written;
}

export async function loadInstalledSubagents(
  subagentsDir: string,
  configs: SubagentConfig[],
  installCommand: string,
): Promise<{ subagents: SubagentDeclaration[]; issues: InstalledSubagentLoadIssue[] }> {
  const subagents: SubagentDeclaration[] = [];
  const issues: InstalledSubagentLoadIssue[] = [];

  for (const config of configs) {
    const filePath = join(subagentsDir, `${config.name}.md`);
    if (!existsSync(filePath)) {
      issues.push({
        name: config.name,
        issue: `Subagent "${config.name}" is in agents.toml but not installed. Run '${installCommand}'.`,
      });
      continue;
    }

    try {
      await assertManagedInstalledSubagentFile(filePath);
      const subagent = await loadSubagentFile(filePath);
      assertSubagentNameMatches(subagent.name, config.name, `${config.name}.md`);
      subagents.push({ ...subagent, targets: config.targets });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({
        name: config.name,
        issue: `Failed to load installed subagent "${config.name}": ${message}`,
      });
    }
  }

  return { subagents, issues };
}

export async function pruneInstalledSubagents(
  subagentsDir: string,
  configs: SubagentConfig[],
): Promise<string[]> {
  const desired = new Set(configs.map((config) => `${config.name}.md`));
  return pruneManagedMarkdownFiles(subagentsDir, desired);
}

export function lockEntryForSubagent(resolved: ResolvedSubagent): LockedSubagent {
  if (resolved.type === "local") {return { source: resolved.source };}
  if (!resolved.resolvedUrl || !resolved.resolvedPath || !resolved.commit) {
    throw new Error(`Incomplete git resolution for subagent "${resolved.subagent.name}".`);
  }
  const entry: LockedSubagent = {
    source: resolved.source,
    resolved_url: resolved.resolvedUrl,
    resolved_path: resolved.resolvedPath,
    resolved_commit: resolved.commit,
  };
  if (resolved.resolvedRef) {entry.resolved_ref = resolved.resolvedRef;}
  return entry;
}

async function loadSubagentFromSource(
  sourceDir: string,
  config: SubagentConfig,
): Promise<SubagentDeclaration> {
  const discovered = await discoverSubagent(sourceDir, config);
  if (!discovered) {
    throw new Error(`Subagent "${config.name}" not found in ${config.source}.`);
  }
  return { ...discovered.subagent, targets: config.targets };
}

async function discoverSubagent(
  sourceDir: string,
  config: SubagentConfig,
): Promise<{ path: string; subagent: SubagentDeclaration } | null> {
  if (config.path) {
    const sourceRoot = resolve(sourceDir);
    const filePath = resolve(sourceRoot, config.path);
    const relPath = relative(sourceRoot, filePath);
    if (relPath.startsWith("..") || isAbsolute(relPath)) {
      throw new Error(`Subagent path resolves outside source: ${config.path}`);
    }
    const nativeTarget = inferNativeTarget(config.path);
    const subagent = await loadSubagentFile(filePath, {
      expectedName: nativeTarget ? config.name : undefined,
      nativeTarget,
      nameFromFile: basename(filePath, extname(filePath)),
    });
    if (nativeTarget !== "codex") {
      assertSubagentNameMatches(subagent.name, config.name, config.path);
    }
    return { path: config.path, subagent };
  }

  const matches: DiscoveredSubagent[] = [];
  for (const scanDir of SUBAGENT_SCAN_DIRS) {
    const absDir = join(sourceDir, scanDir.dir);
    const candidates = await listSubagentFiles(absDir, {
      flat: scanDir.flat ?? false,
      extensions: scanDir.extensions,
    });
    const fileNameMatches: DiscoveredSubagent[] = [];
    const metadataMatches: DiscoveredSubagent[] = [];

    for (const filePath of candidates) {
      const nameFromFile = basename(filePath, extname(filePath));
      let subagent: SubagentDeclaration;
      try {
        subagent = await loadSubagentFile(filePath, {
          nativeTarget: scanDir.nativeTarget,
          nameFromFile,
        });
      } catch (err) {
        if (nameFromFile === config.name) {throw err;}
        // Ignore Markdown/TOML files that are not subagent declarations.
        continue;
      }

      const relPath = relativePath(sourceDir, filePath);
      if (nameFromFile === config.name && subagent.name !== config.name) {
        assertSubagentNameMatches(subagent.name, config.name, relPath);
      }
      if (subagent.name !== config.name) {continue;}
      const match: DiscoveredSubagent = {
        path: relPath,
        subagent,
      };
      if (scanDir.nativeTarget) {match.nativeTarget = scanDir.nativeTarget;}
      if (nameFromFile === config.name) {
        fileNameMatches.push(match);
      } else {
        metadataMatches.push(match);
      }
    }

    const selected = selectDiscoveredSubagent(config.name, scanDir, fileNameMatches, metadataMatches);
    if (selected) {matches.push(selected);}
  }

  if (matches.length === 0) {return null;}
  return mergeDiscoveredSubagents(config.name, matches);
}

async function loadSubagentFile(
  filePath: string,
  opts: {
    expectedName?: string;
    nativeTarget?: NativeSubagentTarget;
    nameFromFile?: string;
  } = {},
): Promise<SubagentDeclaration> {
  if (extname(filePath) === ".toml") {
    if (opts.nativeTarget && opts.nativeTarget !== "codex") {
      throw new Error(`Unsupported ${opts.nativeTarget} subagent file extension ".toml": ${filePath}`);
    }
    return loadCodexSubagentFile(filePath, opts);
  }

  const { meta, body, raw } = await loadMarkdownFrontmatter(filePath);
  const name = subagentIdentityFromMarkdownMeta(
    identityStrategyForNativeTarget(opts.nativeTarget),
    opts.nameFromFile,
    meta,
  );
  if (!name) {
    throw new Error(`Missing 'name' in subagent frontmatter: ${filePath}`);
  }
  if (!SUBAGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid subagent name "${name}" in ${filePath}; expected lowercase letters, numbers, and hyphens`,
    );
  }
  if (!isNonEmptyString(meta["description"])) {
    throw new Error(`Missing 'description' in subagent frontmatter: ${filePath}`);
  }
  if (!body) {
    throw new Error(`Missing subagent instructions body: ${filePath}`);
  }

  const native = readNativeOverlays(meta);
  if (opts.nativeTarget) {
    native[opts.nativeTarget] = raw;
  }

  const subagent: SubagentDeclaration = {
    name,
    description: meta["description"],
    instructions: body,
  };
  if (Object.keys(native).length > 0) {subagent.native = native;}
  return subagent;
}

async function loadCodexSubagentFile(
  filePath: string,
  opts: {
    expectedName?: string;
    nameFromFile?: string;
  } = {},
): Promise<SubagentDeclaration> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    throw new Error(`Codex subagent TOML not found: ${filePath}`);
  }

  let parsed: TomlTableWithoutBigInt;
  try {
    parsed = parseTOML(content, { integersAsBigInt: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Codex subagent TOML in ${filePath}: ${message}`, { cause: err });
  }

  const name = parsed["name"];
  if (!isNonEmptyString(name)) {
    throw new Error(`Missing 'name' in Codex subagent TOML: ${filePath}`);
  }

  const portableName = opts.expectedName ?? (
    SUBAGENT_NAME_PATTERN.test(name) ? name : opts.nameFromFile ?? name
  );
  if (!SUBAGENT_NAME_PATTERN.test(portableName)) {
    throw new Error(
      `Invalid subagent name "${portableName}" in ${filePath}; expected lowercase letters, numbers, and hyphens`,
    );
  }

  const description = parsed["description"];
  if (!isNonEmptyString(description)) {
    throw new Error(`Missing 'description' in Codex subagent TOML: ${filePath}`);
  }

  const instructions = parsed["developer_instructions"];
  if (!isNonEmptyString(instructions) || !instructions.trim()) {
    throw new Error(`Missing 'developer_instructions' in Codex subagent TOML: ${filePath}`);
  }

  return {
    name: portableName,
    description,
    instructions,
    native: {
      codex: content,
    },
  };
}

function mergeDiscoveredSubagents(
  name: string,
  matches: DiscoveredSubagent[],
): DiscoveredSubagent {
  const portableMatches = matches.filter((match) => !match.nativeTarget);
  if (portableMatches.length > 1) {
    throw new Error(
      `Ambiguous portable matches for subagent "${name}": ${portableMatches.map((m) => m.path).join(", ")}`,
    );
  }

  const base = portableMatches[0] ?? matches[0]!;
  const native: NativeSubagentContent = { ...base.subagent.native };

  for (const match of matches) {
    for (const [target, content] of Object.entries(match.subagent.native ?? {})) {
      if (isNativeSubagentTarget(target)) {native[target] ??= content;}
    }
  }

  const subagent: SubagentDeclaration = { ...base.subagent };
  if (Object.keys(native).length > 0) {subagent.native = native;}
  return {
    path: base.path,
    subagent,
  };
}

function identityStrategyForNativeTarget(
  target: NativeSubagentTarget | undefined,
): SubagentIdentityStrategy {
  if (!target) {return "frontmatter-name";}
  const identity = getAgent(target)?.subagents?.identity;
  if (!identity) {
    throw new Error(`Agent "${target}" does not define subagent identity rules.`);
  }
  return identity;
}

function assertSubagentNameMatches(
  actualName: string,
  expectedName: string,
  sourcePath: string,
): void {
  if (actualName === expectedName) {return;}
  throw new Error(
    `Subagent "${sourcePath}" declares name "${actualName}", but agents.toml requested "${expectedName}".`,
  );
}

async function listSubagentFiles(
  dirPath: string,
  opts: { flat: boolean; extensions: readonly string[] },
): Promise<string[]> {
  if (!existsSync(dirPath)) {return [];}
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const absPath = join(dirPath, entry.name);
    if (entry.isFile() && opts.extensions.includes(extname(entry.name))) {
      files.push(absPath);
    } else if (!opts.flat && entry.isDirectory()) {
      files.push(...await listSubagentFiles(absPath, opts));
    }
  }
  return files;
}

function selectDiscoveredSubagent(
  name: string,
  scanDir: SubagentScanDir,
  fileNameMatches: DiscoveredSubagent[],
  metadataMatches: DiscoveredSubagent[],
): DiscoveredSubagent | null {
  assertSingleDiscoveryMatch(name, scanDir, "filename", fileNameMatches);
  if (fileNameMatches.length > 0) {
    return fileNameMatches[0]!;
  }

  assertSingleDiscoveryMatch(name, scanDir, "metadata", metadataMatches);
  return metadataMatches[0] ?? null;
}

function assertSingleDiscoveryMatch(
  name: string,
  scanDir: SubagentScanDir,
  kind: string,
  matches: DiscoveredSubagent[],
): void {
  if (matches.length <= 1) {return;}
  throw new Error(
    `Ambiguous ${kind} matches for subagent "${name}" in ${scanDir.dir}: ${matches.map((m) => m.path).join(", ")}`,
  );
}

function serializeInstalledSubagent(subagent: SubagentDeclaration): string {
  const fields: SerializedObject = {
    name: subagent.name,
    description: subagent.description,
  };
  if (subagent.native) {fields[DOTAGENTS_NATIVE_FIELD] = subagent.native;}
  return serializeMarkdownSubagent(
    fields,
    subagent.instructions,
  );
}

async function assertManagedInstalledSubagentFile(filePath: string): Promise<void> {
  await readManagedInstalledSubagentFile(filePath);
}

async function readManagedInstalledSubagentFile(filePath: string): Promise<string | undefined> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (!hasDotagentsMarkdownSubagentMarker(existing)) {
      throw new InstalledSubagentWriteError(`Subagent file exists and is not managed by dotagents: ${filePath}`);
    }
    return existing;
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
    return undefined;
  }
}

async function replaceFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${tempFileCounter++}`;
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
}

async function pruneManagedMarkdownFiles(dirPath: string, desired: Set<string>): Promise<string[]> {
  if (!existsSync(dirPath)) {return [];}

  const pruned: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {continue;}
    if (!entry.name.endsWith(".md")) {continue;}
    if (desired.has(entry.name)) {continue;}

    const filePath = join(dirPath, entry.name);
    const existing = await readFile(filePath, "utf-8");
    if (hasDotagentsMarkdownSubagentMarker(existing)) {
      await rm(filePath);
      pruned.push(filePath);
    }
  }

  return pruned;
}

function relativePath(root: string, filePath: string): string {
  return relative(resolve(root), filePath).replaceAll("\\", "/");
}

function inferNativeTarget(filePath: string): NativeSubagentTarget | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.includes(".claude/agents/")) {return "claude";}
  if (normalized.includes(".cursor/agents/")) {return "cursor";}
  if (normalized.includes(".codex/agents/")) {return "codex";}
  if (normalized.includes(".opencode/agents/")) {return "opencode";}
  if (normalized.endsWith(".toml")) {return "codex";}
  return undefined;
}

function readNativeOverlays(meta: SerializedObject): NativeSubagentContent {
  const raw = meta[DOTAGENTS_NATIVE_FIELD];
  if (!isSerializedObject(raw)) {return {};}

  const native: NativeSubagentContent = {};
  for (const target of NATIVE_SUBAGENT_TARGETS) {
    const config = raw[target];
    if (isString(config)) {
      native[target] = config;
    } else if (isSerializedObject(config) && isString(config["content"])) {
      native[target] = config["content"];
    }
  }
  return native;
}

function isNotFoundError<ErrorValue>(err: ErrorValue): boolean {
  return hasErrorCode(err, "ENOENT");
}

function isNativeSubagentTarget(target: string): target is NativeSubagentTarget {
  return target === "claude" || target === "cursor" || target === "codex" || target === "opencode";
}
