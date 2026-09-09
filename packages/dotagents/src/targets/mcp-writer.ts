import { chmod, lstat, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  type ParseError as JsoncParseError,
} from "jsonc-parser";
import { stringify as tomlStringify, parse as parseTOML } from "smol-toml";
import { getAgent } from "./registry.js";
import type {
  McpDeclaration,
  McpConfigSpec,
  McpSerializer,
  NormalizedMcpDeclaration,
} from "./types.js";
import type { McpConfig } from "../config/schema.js";
import { isSerializedObject, type SerializedObject } from "@sentry/dotagents-lib";
import { hasErrorCode, isObject, isString } from "../utils/type-guards.js";
import { resolveProjectPath } from "../scope.js";

export interface McpResolvedTarget {
  filePath: string;
  shared: boolean;
  mode?: number;
  preferredFilePath?: string;
  acceptsBareServerMap?: boolean;
  recognizesBareServerMap?: boolean;
}

export type McpTargetResolver = (agentId: string, spec: McpConfigSpec) => McpResolvedTarget;

export interface McpReconcileIssue {
  agent: string;
  issue: string;
}

export interface McpReconcileResult {
  issues: McpReconcileIssue[];
  unresolved: McpReconcileIssue[];
  written: string[];
}

interface ManagedMcpState {
  version: 1;
  servers: string[];
}

export interface ManagedMcpReconcileOptions {
  agentId: string;
  servers: McpDeclaration[];
  target: McpResolvedTarget;
  statePath: string;
  protectedNames?: Iterable<string>;
  mode: "inspect" | "apply";
}

export interface ManagedMcpReconcileResult extends McpReconcileResult {
  managed: string[];
  removed: string[];
  skipped: McpReconcileIssue[];
}

/**
 * Convert McpConfig entries (from agents.toml) to universal McpDeclarations.
 */
export function toMcpDeclarations(configs: McpConfig[]): NormalizedMcpDeclaration[] {
  return configs.map(normalizeMcpDeclaration);
}

/**
 * Resolve project MCP config to the first existing preferred or fallback path.
 * When no candidate exists, use the preferred path for creation.
 */
export function projectMcpResolver(projectRoot: string): McpTargetResolver {
  return (_id: string, spec: McpConfigSpec) => {
    const candidates = [spec.filePath, ...(spec.fallbackFilePaths ?? [])];
    const relativePath = candidates.find((candidate) => existsSync(join(projectRoot, candidate)))
      ?? spec.filePath;
    const filePath = resolveProjectPath(projectRoot, relativePath);
    const preferredFilePath = resolveProjectPath(projectRoot, spec.filePath);
    return {
      filePath,
      shared: spec.shared,
      ...(filePath !== preferredFilePath && { preferredFilePath }),
      ...(spec.acceptsBareServerMap && { acceptsBareServerMap: true }),
      ...((spec.acceptsBareServerMap || spec.recognizesBareServerMap) && {
        recognizesBareServerMap: true,
      }),
    };
  };
}

/**
 * Write MCP config files for each agent.
 * - Existing files preserve undeclared servers and unrelated top-level content.
 * - Missing files are created only when servers are declared.
 * - Files are only written when the serialized output changes.
 */
export async function writeMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
): Promise<void> {
  await reconcileMcpConfigs(agentIds, servers, resolveTarget, "apply");
}

/** Inspect MCP configs for semantic drift without applying repairs. */
export async function verifyMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
): Promise<{ agent: string; issue: string }[]> {
  return (await reconcileMcpConfigs(agentIds, servers, resolveTarget, "inspect")).issues;
}

/**
 * Inspect or apply currently declared MCP names while preserving all other
 * content in existing target files.
 * Returned issues describe the drift observed before any repair.
 */
export async function reconcileMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
  mode: "inspect" | "apply",
): Promise<McpReconcileResult> {
  const issues: McpReconcileIssue[] = [];
  const unresolved: McpReconcileIssue[] = [];
  const written: string[] = [];
  const seen = new Set<string>();
  const normalized = servers.map(normalizeMcpDeclaration);
  if (normalized.length === 0) {return { issues, unresolved, written };}

  const initialTargets = agentIds.flatMap((id) => {
    const agent = getAgent(id);
    if (!agent) {return [];}
    return [{ id, agent, target: resolveTarget(id, agent.mcp) }];
  });
  const claimedPaths = new Set(initialTargets.map(({ target }) => target.filePath));
  const promotedFallbacks = new Map<string, McpResolvedTarget>();
  const targets = initialTargets.map((entry) => {
    const preferredFilePath = entry.target.preferredFilePath;
    if (!preferredFilePath || !claimedPaths.has(preferredFilePath)) {return entry;}
    promotedFallbacks.set(preferredFilePath, entry.target);
    return Object.assign({}, entry, {
      target: Object.assign({}, entry.target, { filePath: preferredFilePath }),
    });
  });
  const pathFormats = new Map<string, { recognizesBare: boolean; requiresRoot: boolean }>();
  for (const { target } of targets) {
    const format = pathFormats.get(target.filePath) ?? {
      recognizesBare: false,
      requiresRoot: false,
    };
    format.recognizesBare ||= target.recognizesBareServerMap === true ||
      target.acceptsBareServerMap === true;
    format.requiresRoot ||= target.acceptsBareServerMap !== true;
    pathFormats.set(target.filePath, format);
  }

  for (const { id, agent, target } of targets) {
    const { mcp } = agent;
    const { filePath } = target;
    const pathFormat = pathFormats.get(filePath)!;
    if (seen.has(filePath)) {continue;}
    seen.add(filePath);

    const expectedServers = renderServers(agent.serializeServer, normalized);
    const expected = { [mcp.rootKey]: expectedServers };
    const modeCheck = await desiredModeIssue(id, filePath, target.mode);
    if (modeCheck && !modeCheck.missing && !modeCheck.directRegularFile) {
      issues.push(modeCheck.issue);
      unresolved.push(modeCheck.issue);
      continue;
    }

    if (!existsSync(filePath)) {
      issues.push({ agent: id, issue: `MCP config missing: ${filePath}` });
      if (mode === "apply") {
        const fallbackTarget = promotedFallbacks.get(filePath);
        if (fallbackTarget) {
          let fallback: SerializedObject;
          let fallbackRoot: McpServerRoot;
          try {
            fallback = await readExisting(fallbackTarget.filePath, mcp);
            fallbackRoot = readServerRootOrBare(
              fallback,
              mcp.rootKey,
              fallbackTarget.filePath,
              fallbackTarget.recognizesBareServerMap === true ||
                fallbackTarget.acceptsBareServerMap === true,
            );
          } catch {
            const issue = { agent: id, issue: `Failed to read MCP config: ${fallbackTarget.filePath}` };
            issues.push(issue);
            unresolved.push(issue);
            continue;
          }
          await writeDocument(
            filePath,
            mcp,
            mergeServerDocument(
              fallback,
              mcp.rootKey,
              fallbackRoot,
              expectedServers,
              !pathFormat.requiresRoot,
            ),
            target.mode,
          );
        } else {
          await writeDocument(filePath, mcp, expected, target.mode);
        }
        written.push(filePath);
      }
      continue;
    }

    if (modeCheck) {issues.push(modeCheck.issue);}
    if (mode === "apply") {
      await repairModeBeforeRead(filePath, modeCheck, target.mode);
    }

    let existing: SerializedObject;
    let existingRoot: McpServerRoot;
    try {
      existing = await readExisting(filePath, mcp);
      existingRoot = readServerRootOrBare(
        existing,
        mcp.rootKey,
        filePath,
        pathFormat.recognizesBare,
      );
    } catch {
      const issue = { agent: id, issue: `Failed to read MCP config: ${filePath}` };
      issues.push(issue);
      unresolved.push(issue);
      // Without a mergeable document, overwriting could destroy external config.
      continue;
    }

    const targetIssues = desiredIssues(id, filePath, existingRoot.servers, expectedServers);
    issues.push(...targetIssues);
    const envelopeIssue = existingRoot.bare && pathFormat.requiresRoot
      ? {
          agent: id,
          issue: `MCP config bare server map must be nested under "${mcp.rootKey}" to share ${filePath}`,
        }
      : undefined;
    if (envelopeIssue) {issues.push(envelopeIssue);}
    const contentChanged = targetIssues.length > 0 || envelopeIssue !== undefined;
    if (mode === "apply" && (contentChanged || modeCheck)) {
      const next = mergeServerDocument(
        existing,
        mcp.rootKey,
        existingRoot,
        expectedServers,
        !pathFormat.requiresRoot,
      );
      if (contentChanged) {
        await writeReconciledDocument(filePath, mcp, next, expectedServers, target.mode);
      }
      await enforceMode(filePath, mcp, next, modeCheck, target.mode);
      written.push(filePath);
    }
  }

  return { issues, unresolved, written };
}

/**
 * Reconcile one adapter-owned subset of a shared MCP config.
 *
 * Ownership is stored outside the client config so unrelated entries remain
 * untouched and stale adapter entries can be pruned deterministically.
 */
export async function reconcileManagedMcpConfig(
  options: ManagedMcpReconcileOptions,
): Promise<ManagedMcpReconcileResult> {
  const { agentId, target, statePath, mode } = options;
  const agent = getAgent(agentId);
  if (!agent) {
    return { issues: [], unresolved: [], written: [], managed: [], removed: [], skipped: [] };
  }

  const stateResult = await readManagedMcpState(statePath);
  if (stateResult.issue) {
    const issue = { agent: agentId, issue: stateResult.issue };
    return { issues: [issue], unresolved: [issue], written: [], managed: [], removed: [], skipped: [] };
  }

  const previous = new Set(stateResult.state?.servers ?? []);
  const protectedNames = new Set(options.protectedNames ?? []);
  const desired = renderServers(
    agent.serializeServer,
    options.servers.map(normalizeMcpDeclaration),
  );
  const issues: McpReconcileIssue[] = [];
  const unresolved: McpReconcileIssue[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const skipped: McpReconcileIssue[] = [];
  const modeCheck = await desiredModeIssue(agentId, target.filePath, target.mode);
  if (modeCheck && !modeCheck.missing && !modeCheck.directRegularFile) {
    issues.push(modeCheck.issue);
    unresolved.push(modeCheck.issue);
    return { issues, unresolved, written, managed: [], removed, skipped };
  }

  if (!existsSync(target.filePath)) {
    const managed = Object.keys(desired).filter((name) => !protectedNames.has(name)).toSorted();
    for (const name of Object.keys(desired)) {
      if (protectedNames.has(name)) {
        const issue = { agent: agentId, issue: `MCP server "${name}" conflicts with a declared server and was not projected.` };
        issues.push(issue);
        skipped.push(issue);
      }
    }
    if (managed.length > 0) {
      issues.push({ agent: agentId, issue: `MCP config missing: ${target.filePath}` });
      if (mode === "apply") {
        const expected = Object.fromEntries(managed.map((name) => [name, desired[name]]));
        await writeDocument(
          target.filePath,
          agent.mcp,
          { [agent.mcp.rootKey]: expected },
          target.mode,
        );
        written.push(target.filePath);
        if (await writeManagedMcpState(statePath, managed)) {written.push(statePath);}
      }
    } else if (mode === "apply" && stateResult.state) {
      await rm(statePath, { force: true });
      removed.push(statePath);
    }
    return { issues, unresolved, written, managed, removed, skipped };
  }

  if (modeCheck) {issues.push(modeCheck.issue);}
  if (mode === "apply") {
    await repairModeBeforeRead(target.filePath, modeCheck, target.mode);
  }

  let existing: SerializedObject;
  let existingServers: SerializedObject;
  try {
    existing = await readExisting(target.filePath, agent.mcp);
    existingServers = readServerRoot(existing, agent.mcp.rootKey, target.filePath);
  } catch {
    const issue = { agent: agentId, issue: `Failed to read MCP config: ${target.filePath}` };
    return { issues: [issue], unresolved: [issue], written, managed: [], removed, skipped };
  }

  const managed: string[] = [];
  const expected: SerializedObject = {};
  for (const [name, value] of Object.entries(desired)) {
    if (protectedNames.has(name)) {
      const issue = { agent: agentId, issue: `MCP server "${name}" conflicts with a declared server and was not projected.` };
      issues.push(issue);
      skipped.push(issue);
      continue;
    }
    if (name in existingServers && !previous.has(name)) {
      const issue = { agent: agentId, issue: `MCP server "${name}" already exists in ${target.filePath} and is not managed by dotagents plugins.` };
      issues.push(issue);
      skipped.push(issue);
      continue;
    }
    managed.push(name);
    expected[name] = value;
  }
  managed.sort();

  const stale = [...previous]
    .filter((name) => !managed.includes(name) && !protectedNames.has(name))
    .toSorted();
  for (const name of stale) {
    if (name in existingServers) {
      issues.push({ agent: agentId, issue: `Managed MCP server "${name}" is stale in ${target.filePath}` });
    }
  }
  const targetIssues = desiredIssues(agentId, target.filePath, existingServers, expected);
  issues.push(...targetIssues);
  if (mode === "apply") {
    const targetChanged = stale.some((name) => name in existingServers) ||
      targetIssues.length > 0;
    const nextServers = { ...existingServers };
    for (const name of stale) {delete nextServers[name];}
    Object.assign(nextServers, expected);
    const next = { ...existing, [agent.mcp.rootKey]: nextServers };
    if (targetChanged) {
      await writeManagedReconciledDocument(
        target.filePath,
        agent.mcp,
        existing,
        existingServers,
        expected,
        stale,
        target.mode,
      );
      removed.push(...stale.filter((name) => name in existingServers));
    }
    await enforceMode(target.filePath, agent.mcp, next, modeCheck, target.mode);
    if (targetChanged || modeCheck) {written.push(target.filePath);}
    if (managed.length > 0) {
      if (await writeManagedMcpState(statePath, managed)) {written.push(statePath);}
    } else if (stateResult.state) {
      await rm(statePath, { force: true });
      removed.push(statePath);
    }
  }

  return { issues, unresolved, written, managed, removed, skipped };
}

// --- Internal helpers ---

function normalizeMcpDeclaration(mcp: McpDeclaration): NormalizedMcpDeclaration {
  if (mcp.url) {
    return {
      name: mcp.name,
      url: mcp.url,
      ...(mcp.headers && { headers: mcp.headers }),
      ...(mcp.interpolateEnvRefs !== undefined && {
        interpolateEnvRefs: mcp.interpolateEnvRefs,
      }),
      ...(mcp.env?.length && { env: mcp.env }),
      ...(mcp.envValues && { envValues: mcp.envValues }),
    };
  }
  if (!mcp.command) {
    throw new TypeError(`MCP declaration "${mcp.name}" has no transport`);
  }
  return {
    name: mcp.name,
    command: mcp.command,
    ...(mcp.args && { args: mcp.args }),
    ...(mcp.env?.length && { env: mcp.env }),
    ...(mcp.envValues && { envValues: mcp.envValues }),
    ...(mcp.cwd && { cwd: mcp.cwd }),
  };
}

function renderServers(
  serializeServer: McpSerializer,
  servers: NormalizedMcpDeclaration[],
): SerializedObject {
  return Object.fromEntries(servers.map(serializeServer));
}

function desiredIssues(
  agent: string,
  filePath: string,
  existing: SerializedObject,
  expected: SerializedObject,
): McpReconcileIssue[] {
  return Object.entries(expected).flatMap(([name, value]) => {
    if (!(name in existing)) {
      return [{ agent, issue: `MCP server "${name}" missing from ${filePath}` }];
    }
    if (!isDeepStrictEqual(existing[name], value)) {
      return [{ agent, issue: `MCP server "${name}" drifted in ${filePath}` }];
    }
    return [];
  });
}

function readServerRoot(
  document: SerializedObject,
  rootKey: string,
  filePath: string,
): SerializedObject {
  const root = document[rootKey];
  if (root === undefined) {return {};}
  if (!isObject(root) || Array.isArray(root) || root instanceof Date) {
    throw new TypeError(`MCP config root must contain an object: ${filePath}`);
  }
  return root;
}

interface McpServerRoot {
  servers: SerializedObject;
  bare: boolean;
}

function readServerRootOrBare(
  document: SerializedObject,
  rootKey: string,
  filePath: string,
  acceptsBare: boolean,
): McpServerRoot {
  if (
    document[rootKey] === undefined &&
    acceptsBare &&
    isBareMcpServerMap(document)
  ) {
    return { servers: document, bare: true };
  }
  return { servers: readServerRoot(document, rootKey, filePath), bare: false };
}

function isBareMcpServerMap(document: SerializedObject): boolean {
  return Object.values(document).every((value) => (
    isSerializedObject(value) &&
    (isString(value["command"]) || isString(value["url"]))
  ));
}

function mergeServerDocument(
  document: SerializedObject,
  rootKey: string,
  root: McpServerRoot,
  expectedServers: SerializedObject,
  preserveBare: boolean,
): SerializedObject {
  const servers = { ...root.servers, ...expectedServers };
  if (root.bare) {
    return preserveBare ? servers : { [rootKey]: servers };
  }
  return { ...document, [rootKey]: servers };
}

async function writeDocument(
  filePath: string,
  spec: McpConfigSpec,
  doc: SerializedObject,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileIfChanged(filePath, serialize(doc, spec.format), mode);
}

async function readExisting(
  filePath: string,
  spec: McpConfigSpec,
): Promise<SerializedObject> {
  const raw = await readFile(filePath, "utf-8");
  const jsoncErrors: JsoncParseError[] = [];
  const parsed = spec.format === "toml"
    ? parseTOML(raw)
    : spec.format === "jsonc"
      ? parseJsonc(raw, jsoncErrors, { allowTrailingComma: true })
      : JSON.parse(raw);
  if (jsoncErrors.length > 0) {
    throw new SyntaxError(`Invalid JSONC in ${filePath}`);
  }
  if (spec.format === "toml") {
    if (!isTomlObject(parsed)) {
      throw new TypeError(`MCP config must contain an object: ${filePath}`);
    }
    return parsed;
  }
  if (!isSerializedObject(parsed)) {
    throw new TypeError(`MCP config must contain an object: ${filePath}`);
  }
  return parsed;
}

function isTomlObject<Value>(value: Value): value is Value & SerializedObject {
  return isObject(value) && !Array.isArray(value) && !(value instanceof Date);
}

async function writeReconciledDocument(
  filePath: string,
  spec: McpConfigSpec,
  doc: SerializedObject,
  expectedServers: SerializedObject,
  mode?: number,
): Promise<void> {
  if (spec.format !== "jsonc") {
    await writeDocument(filePath, spec, doc, mode);
    return;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
    await writeDocument(filePath, spec, doc, mode);
    return;
  }
  for (const [name, server] of Object.entries(expectedServers)) {
    const edits = modifyJsonc(raw, [spec.rootKey, name], server, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    raw = applyJsoncEdits(raw, edits);
  }
  await writeFileIfChanged(filePath, raw.endsWith("\n") ? raw : `${raw}\n`, mode);
}

async function writeManagedReconciledDocument(
  filePath: string,
  spec: McpConfigSpec,
  document: SerializedObject,
  existingServers: SerializedObject,
  expectedServers: SerializedObject,
  removedNames: string[],
  mode?: number,
): Promise<void> {
  const servers = { ...existingServers };
  for (const name of removedNames) {delete servers[name];}
  Object.assign(servers, expectedServers);
  const next = { ...document, [spec.rootKey]: servers };

  if (spec.format !== "jsonc") {
    await writeDocument(filePath, spec, next, mode);
    return;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
    await writeDocument(filePath, spec, next, mode);
    return;
  }
  for (const name of removedNames) {
    raw = applyJsoncEdits(raw, modifyJsonc(raw, [spec.rootKey, name], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  for (const [name, server] of Object.entries(expectedServers)) {
    raw = applyJsoncEdits(raw, modifyJsonc(raw, [spec.rootKey, name], server, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  await writeFileIfChanged(filePath, raw.endsWith("\n") ? raw : `${raw}\n`, mode);
}

async function readManagedMcpState(
  statePath: string,
): Promise<{ state?: ManagedMcpState; issue?: string }> {
  if (!existsSync(statePath)) {return {};}
  try {
    const value = JSON.parse(await readFile(statePath, "utf-8"));
    if (!isSerializedObject(value) || value["version"] !== 1) {
      return { issue: `Invalid managed MCP state: ${statePath}` };
    }
    const servers = value["servers"];
    if (!Array.isArray(servers)) {
      return { issue: `Invalid managed MCP state: ${statePath}` };
    }
    const validatedServers = servers.filter(isString);
    if (validatedServers.length !== servers.length) {
      return { issue: `Invalid managed MCP state: ${statePath}` };
    }
    return {
      state: {
        version: 1,
        servers: [...new Set(validatedServers)].toSorted(),
      },
    };
  } catch {
    return { issue: `Failed to read managed MCP state: ${statePath}` };
  }
}

async function writeManagedMcpState(statePath: string, servers: string[]): Promise<boolean> {
  const content = `${JSON.stringify({ version: 1, servers: servers.toSorted() }, null, 2)}\n`;
  try {
    if (await readFile(statePath, "utf-8") === content) {return false;}
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, content, "utf-8");
  return true;
}

function serialize(doc: SerializedObject, format: "json" | "jsonc" | "toml"): string {
  if (format === "toml") {
    return `${tomlStringify(doc)}\n`;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function writeFileIfChanged(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  try {
    if ((await readFile(filePath, "utf-8")) === content) {return;}
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }

  try {
    await writeFile(filePath, content, { encoding: "utf-8", mode });
  } catch (err) {
    if (
      mode === undefined
      || (!hasErrorCode(err, "EACCES") && !hasErrorCode(err, "EPERM"))
    ) {
      throw err;
    }
    try {
      await chmod(filePath, mode);
    } catch (chmodError) {
      if (!isNotFoundError(chmodError)) {throw chmodError;}
    }
    await writeFile(filePath, content, { encoding: "utf-8", mode });
  }
}

async function desiredModeIssue(
  agent: string,
  filePath: string,
  expectedMode?: number,
): Promise<{ issue: McpReconcileIssue; missing: boolean; directRegularFile: boolean } | undefined> {
  if (expectedMode === undefined) {return undefined;}
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(filePath);
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
    return {
      issue: { agent, issue: `MCP config missing: ${filePath}` },
      missing: true,
      directRegularFile: false,
    };
  }
  if (!fileStat.isFile()) {
    return {
      issue: { agent, issue: `MCP config is not a regular file: ${filePath}` },
      missing: false,
      directRegularFile: false,
    };
  }
  const actualMode = fileStat.mode & 0o777;
  if (actualMode === expectedMode) {return undefined;}
  return {
    issue: {
      agent,
      issue: `MCP config mode is ${actualMode.toString(8)}, expected ${expectedMode.toString(8)}: ${filePath}`,
    },
    missing: false,
    directRegularFile: true,
  };
}

async function repairModeBeforeRead(
  filePath: string,
  modeCheck: Awaited<ReturnType<typeof desiredModeIssue>>,
  expectedMode?: number,
): Promise<void> {
  if (!modeCheck || modeCheck.missing || !modeCheck.directRegularFile || expectedMode === undefined) {return;}
  try {
    await chmod(filePath, expectedMode);
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }
}

async function enforceMode(
  filePath: string,
  spec: McpConfigSpec,
  document: SerializedObject,
  modeCheck: Awaited<ReturnType<typeof desiredModeIssue>>,
  expectedMode?: number,
): Promise<void> {
  if (!modeCheck || expectedMode === undefined) {return;}
  try {
    await chmod(filePath, expectedMode);
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
    await writeDocument(filePath, spec, document, expectedMode);
  }
}

function isNotFoundError<ErrorValue>(err: ErrorValue): boolean {
  return hasErrorCode(err, "ENOENT");
}
