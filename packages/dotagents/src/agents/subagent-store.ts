import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseTOML } from "smol-toml";
import {
  applyDefaultRepositorySource,
  ensureCached,
  isSourceExcluded,
  loadMarkdownFrontmatter,
  parseSource,
  resolveLocalSource,
  sanitizeCacheKey,
  validateTrustedSource,
  type RepositorySource,
  type TrustPolicy,
} from "@sentry/dotagents-lib";
import { DOTAGENTS_SUBAGENT_MARKER, serializeMarkdownSubagent } from "./definitions/helpers.js";
import { getAgent } from "./registry.js";
import { subagentIdentityFromMarkdownMeta } from "./subagent-identity.js";
import { SUBAGENT_NAME_PATTERN, type SubagentConfig } from "../config/schema.js";
import type { LockedSubagent } from "../lockfile/schema.js";
import type {
  NativeSubagentContent,
  NativeSubagentTarget,
  SubagentDeclaration,
  SubagentIdentityStrategy,
} from "./types.js";

const DOTAGENTS_NATIVE_FIELD = "dotagents_native";
const NATIVE_SUBAGENT_TARGETS = ["claude", "cursor", "codex", "opencode"] satisfies NativeSubagentTarget[];

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
  repairable: boolean;
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
  const desired = new Set<string>();
  const written: string[] = [];

  for (const subagent of subagents) {
    const fileName = `${subagent.name}.md`;
    desired.add(fileName);
    const filePath = join(subagentsDir, fileName);
    const content = serializeInstalledSubagent(subagent);
    if (await writeManagedFile(filePath, content)) {
      written.push(filePath);
    }
  }

  await pruneManagedMarkdownFiles(subagentsDir, desired);
  return written;
}

export async function loadInstalledSubagents(
  subagentsDir: string,
  configs: SubagentConfig[],
): Promise<{ subagents: SubagentDeclaration[]; issues: InstalledSubagentLoadIssue[] }> {
  const subagents: SubagentDeclaration[] = [];
  const issues: InstalledSubagentLoadIssue[] = [];

  for (const config of configs) {
    const filePath = join(subagentsDir, `${config.name}.md`);
    if (!existsSync(filePath)) {
      issues.push({
        name: config.name,
        issue: `Subagent "${config.name}" is in agents.toml but not installed. Run 'npx @sentry/dotagents install'.`,
        repairable: false,
      });
      continue;
    }

    try {
      const subagent = await loadSubagentFile(filePath);
      assertSubagentNameMatches(subagent.name, config.name, `${config.name}.md`);
      subagents.push({ ...subagent, targets: config.targets });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({
        name: config.name,
        issue: `Failed to load installed subagent "${config.name}": ${message}`,
        repairable: false,
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
  return {
    source: resolved.source,
    ...(resolved.resolvedUrl ? { resolved_url: resolved.resolvedUrl } : {}),
    ...(resolved.resolvedPath ? { resolved_path: resolved.resolvedPath } : {}),
    ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
    ...(resolved.commit ? { resolved_commit: resolved.commit } : {}),
  };
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
      const match = {
        path: relPath,
        subagent,
        ...(scanDir.nativeTarget ? { nativeTarget: scanDir.nativeTarget } : {}),
      };
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
  if (typeof meta["description"] !== "string" || !meta["description"]) {
    throw new Error(`Missing 'description' in subagent frontmatter: ${filePath}`);
  }
  if (!body) {
    throw new Error(`Missing subagent instructions body: ${filePath}`);
  }

  const native = readNativeOverlays(meta);
  if (opts.nativeTarget) {
    native[opts.nativeTarget] = raw;
  }

  return {
    name,
    description: meta["description"],
    instructions: body,
    ...(Object.keys(native).length > 0 ? { native } : {}),
  };
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

  let parsed: unknown;
  try {
    parsed = parseTOML(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Codex subagent TOML in ${filePath}: ${message}`, { cause: err });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Codex subagent TOML must be an object: ${filePath}`);
  }

  const name = parsed["name"];
  if (typeof name !== "string" || !name) {
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
  if (typeof description !== "string" || !description) {
    throw new Error(`Missing 'description' in Codex subagent TOML: ${filePath}`);
  }

  const instructions = parsed["developer_instructions"];
  if (typeof instructions !== "string" || !instructions.trim()) {
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

  for (const match of matches.slice(1)) {
    for (const [target, content] of Object.entries(match.subagent.native ?? {})) {
      const nativeTarget = target as NativeSubagentTarget;
      native[nativeTarget] ??= content;
    }
  }

  return {
    path: base.path,
    subagent: {
      ...base.subagent,
      ...(Object.keys(native).length > 0 ? { native } : {}),
    },
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
  return serializeMarkdownSubagent(
    {
      name: subagent.name,
      description: subagent.description,
      ...(subagent.native ? { [DOTAGENTS_NATIVE_FIELD]: subagent.native } : {}),
    },
    subagent.instructions,
  );
}

async function writeManagedFile(filePath: string, content: string): Promise<boolean> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (existing === content) {return false;}
    if (!existing.includes(DOTAGENTS_SUBAGENT_MARKER)) {
      throw new Error(`Subagent file exists and is not managed by dotagents: ${filePath}`);
    }
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }

  await writeFile(filePath, content, "utf-8");
  return true;
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
    if (existing.includes(DOTAGENTS_SUBAGENT_MARKER)) {
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
  if (normalized.endsWith(".toml")) {return "codex";}
  if (normalized.includes(".claude/agents/")) {return "claude";}
  if (normalized.includes(".cursor/agents/")) {return "cursor";}
  if (normalized.includes(".opencode/agents/")) {return "opencode";}
  return undefined;
}

function readNativeOverlays(meta: Record<string, unknown>): NativeSubagentContent {
  const raw = meta[DOTAGENTS_NATIVE_FIELD];
  if (!isPlainObject(raw)) {return {};}

  const native: NativeSubagentContent = {};
  for (const target of NATIVE_SUBAGENT_TARGETS) {
    const config = raw[target];
    if (typeof config === "string") {
      native[target] = config;
    } else if (isPlainObject(config) && typeof config["content"] === "string") {
      native[target] = config["content"];
    }
  }
  return native;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
