import { readFile, writeFile, mkdir } from "node:fs/promises";
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

// --- Internal helpers ---

function normalizeMcpDeclaration(mcp: McpDeclaration): NormalizedMcpDeclaration {
  if (mcp.url) {
    return {
      name: mcp.name,
      url: mcp.url,
      ...(mcp.headers && { headers: mcp.headers }),
      ...(mcp.env?.length && { env: mcp.env }),
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
