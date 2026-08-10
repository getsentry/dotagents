import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
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
  NormalizedMcpDeclaration,
} from "./types.js";
import type { McpConfig } from "../config/schema.js";

export interface McpResolvedTarget {
  filePath: string;
  shared: boolean;
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
    return {
      filePath: join(projectRoot, relativePath),
      shared: spec.shared,
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

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) {continue;}

    const { mcp } = agent;
    const { filePath } = resolveTarget(id, mcp);
    if (seen.has(filePath)) {continue;}
    seen.add(filePath);

    const expectedServers = renderServers(agent.serializeServer, normalized);
    const expected = { [mcp.rootKey]: expectedServers };

    if (!existsSync(filePath)) {
      issues.push({ agent: id, issue: `MCP config missing: ${filePath}` });
      if (mode === "apply") {
        await writeDocument(filePath, mcp, expected);
        written.push(filePath);
      }
      continue;
    }

    let existing: Record<string, unknown>;
    let existingServers: Record<string, unknown>;
    try {
      existing = await readExisting(filePath, mcp);
      existingServers = readServerRoot(existing, mcp.rootKey, filePath);
    } catch {
      const issue = { agent: id, issue: `Failed to read MCP config: ${filePath}` };
      issues.push(issue);
      unresolved.push(issue);
      // Without a mergeable document, overwriting could destroy external config.
      continue;
    }

    const targetIssues = desiredIssues(id, filePath, existingServers, expectedServers);
    issues.push(...targetIssues);

    if (mode === "apply" && targetIssues.length > 0) {
      const next = {
        ...existing,
        [mcp.rootKey]: { ...existingServers, ...expectedServers },
      };
      await writeReconciledDocument(filePath, mcp, next, expectedServers);
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
        await writeDocument(target.filePath, agent.mcp, { [agent.mcp.rootKey]: expected });
        written.push(target.filePath);
        if (await writeManagedMcpState(statePath, managed)) {written.push(statePath);}
      }
    } else if (mode === "apply" && stateResult.state) {
      await rm(statePath, { force: true });
      removed.push(statePath);
    }
    return { issues, unresolved, written, managed, removed, skipped };
  }

  let existing: Record<string, unknown>;
  let existingServers: Record<string, unknown>;
  try {
    existing = await readExisting(target.filePath, agent.mcp);
    existingServers = readServerRoot(existing, agent.mcp.rootKey, target.filePath);
  } catch {
    const issue = { agent: agentId, issue: `Failed to read MCP config: ${target.filePath}` };
    return { issues: [issue], unresolved: [issue], written, managed: [], removed, skipped };
  }

  const managed: string[] = [];
  const expected: Record<string, unknown> = {};
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
  issues.push(...desiredIssues(agentId, target.filePath, existingServers, expected));

  if (mode === "apply") {
    const targetChanged = stale.some((name) => name in existingServers) ||
      desiredIssues(agentId, target.filePath, existingServers, expected).length > 0;
    if (targetChanged) {
      await writeManagedReconciledDocument(
        target.filePath,
        agent.mcp,
        existing,
        existingServers,
        expected,
        stale,
      );
      written.push(target.filePath);
      removed.push(...stale.filter((name) => name in existingServers));
    }
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
  serializeServer: (server: McpDeclaration) => [string, unknown],
  servers: NormalizedMcpDeclaration[],
): Record<string, unknown> {
  return Object.fromEntries(servers.map(serializeServer));
}

function desiredIssues(
  agent: string,
  filePath: string,
  existing: Record<string, unknown>,
  expected: Record<string, unknown>,
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
  document: Record<string, unknown>,
  rootKey: string,
  filePath: string,
): Record<string, unknown> {
  const root = document[rootKey];
  if (root === undefined) {return {};}
  if (!isRecord(root)) {
    throw new TypeError(`MCP config root must contain an object: ${filePath}`);
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function writeDocument(
  filePath: string,
  spec: McpConfigSpec,
  doc: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFileIfChanged(filePath, serialize(doc, spec.format));
}

async function readExisting(
  filePath: string,
  spec: McpConfigSpec,
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf-8");
  const jsoncErrors: JsoncParseError[] = [];
  const parsed: unknown = spec.format === "toml"
    ? parseTOML(raw)
    : spec.format === "jsonc"
      ? parseJsonc(raw, jsoncErrors, { allowTrailingComma: true })
      : JSON.parse(raw);
  if (jsoncErrors.length > 0) {
    throw new SyntaxError(`Invalid JSONC in ${filePath}`);
  }
  if (!isRecord(parsed)) {
    throw new TypeError(`MCP config must contain an object: ${filePath}`);
  }
  return parsed;
}

async function writeReconciledDocument(
  filePath: string,
  spec: McpConfigSpec,
  doc: Record<string, unknown>,
  expectedServers: Record<string, unknown>,
): Promise<void> {
  if (spec.format !== "jsonc") {
    await writeDocument(filePath, spec, doc);
    return;
  }

  let raw = await readFile(filePath, "utf-8");
  for (const [name, server] of Object.entries(expectedServers)) {
    const edits = modifyJsonc(raw, [spec.rootKey, name], server, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    raw = applyJsoncEdits(raw, edits);
  }
  await writeFileIfChanged(filePath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

async function writeManagedReconciledDocument(
  filePath: string,
  spec: McpConfigSpec,
  document: Record<string, unknown>,
  existingServers: Record<string, unknown>,
  expectedServers: Record<string, unknown>,
  removedNames: string[],
): Promise<void> {
  if (spec.format !== "jsonc") {
    const servers = { ...existingServers };
    for (const name of removedNames) {delete servers[name];}
    Object.assign(servers, expectedServers);
    await writeDocument(filePath, spec, { ...document, [spec.rootKey]: servers });
    return;
  }

  let raw = await readFile(filePath, "utf-8");
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
  await writeFileIfChanged(filePath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

async function readManagedMcpState(
  statePath: string,
): Promise<{ state?: ManagedMcpState; issue?: string }> {
  if (!existsSync(statePath)) {return {};}
  try {
    const value: unknown = JSON.parse(await readFile(statePath, "utf-8"));
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["servers"]) ||
      !value["servers"].every((name) => typeof name === "string")) {
      return { issue: `Invalid managed MCP state: ${statePath}` };
    }
    return {
      state: {
        version: 1,
        servers: [...new Set(value["servers"] as string[])].toSorted(),
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

function serialize(doc: Record<string, unknown>, format: "json" | "jsonc" | "toml"): string {
  if (format === "toml") {
    return `${tomlStringify(doc)}\n`;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await readFile(filePath, "utf-8")) === content) {return;}
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }

  await writeFile(filePath, content, "utf-8");
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
