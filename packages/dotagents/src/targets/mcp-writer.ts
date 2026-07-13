import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
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
  written: string[];
  removed: string[];
}

/**
 * Convert McpConfig entries (from agents.toml) to universal McpDeclarations.
 */
export function toMcpDeclarations(configs: McpConfig[]): NormalizedMcpDeclaration[] {
  return configs.map(normalizeMcpDeclaration);
}

/**
 * Convenience resolver for project-scope MCP: joins spec.filePath with projectRoot.
 */
export function projectMcpResolver(projectRoot: string): McpTargetResolver {
  return (_id: string, spec: McpConfigSpec) => ({
    filePath: join(projectRoot, spec.filePath),
    shared: spec.shared,
  });
}

/**
 * Write MCP config files for each agent.
 * - Dedicated files (shared=false): generated from scratch.
 * - Shared files (shared=true): read existing and merge dotagents servers under the root key.
 * - Files are only written when the serialized output changes.
 */
export async function writeMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
): Promise<void> {
  if (servers.length === 0) {return;}
  await reconcileMcpConfigs(agentIds, servers, resolveTarget, "apply");
}

/** Inspect MCP configs for semantic drift without applying repairs. */
export async function verifyMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
): Promise<{ agent: string; issue: string }[]> {
  if (servers.length === 0) {return [];}
  return (await reconcileMcpConfigs(agentIds, servers, resolveTarget, "inspect")).issues;
}

/**
 * Inspect or apply desired MCP state. Dedicated targets are fully owned;
 * shared targets update desired names while preserving every other entry.
 * Returned issues describe the drift observed before any repair.
 */
export async function reconcileMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
  mode: "inspect" | "apply",
): Promise<McpReconcileResult> {
  const issues: McpReconcileIssue[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();
  const normalized = servers.map(normalizeMcpDeclaration);

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) {continue;}

    const { mcp } = agent;
    const { filePath, shared } = resolveTarget(id, mcp);
    if (seen.has(filePath)) {continue;}
    seen.add(filePath);

    if (normalized.length === 0) {
      if (!shared && existsSync(filePath)) {
        issues.push({ agent: id, issue: `Stale MCP config: ${filePath}` });
        if (mode === "apply") {
          await rm(filePath);
          removed.push(filePath);
        }
      }
      continue;
    }

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
    try {
      existing = await readExisting(filePath, mcp);
    } catch (error) {
      issues.push({ agent: id, issue: `Failed to read MCP config: ${filePath}` });
      if (mode === "apply" && !shared) {
        await writeDocument(filePath, mcp, expected);
        written.push(filePath);
        continue;
      }
      if (mode === "apply") {
        throw error;
      }
      continue;
    }

    const existingServers = asRecord(existing[mcp.rootKey]);
    const targetIssues = shared
      ? sharedIssues(id, filePath, existingServers, expectedServers)
      : dedicatedIssues(id, filePath, existing, expected, existingServers, expectedServers);
    issues.push(...targetIssues);

    if (mode === "apply" && targetIssues.length > 0) {
      const next = shared
        ? { ...existing, [mcp.rootKey]: { ...existingServers, ...expectedServers } }
        : expected;
      await writeDocument(filePath, mcp, next);
      written.push(filePath);
    }
  }

  return { issues, written, removed };
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

function sharedIssues(
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

function dedicatedIssues(
  agent: string,
  filePath: string,
  existing: Record<string, unknown>,
  expected: Record<string, unknown>,
  existingServers: Record<string, unknown>,
  expectedServers: Record<string, unknown>,
): McpReconcileIssue[] {
  if (isDeepStrictEqual(existing, expected)) {return [];}
  const issues = sharedIssues(agent, filePath, existingServers, expectedServers);
  return issues.length > 0
    ? issues
    : [{ agent, issue: `MCP config drifted: ${filePath}` }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
  const parsed: unknown = spec.format === "toml" ? parseTOML(raw) : JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new TypeError(`MCP config must contain an object: ${filePath}`);
  }
  return parsed;
}

function serialize(doc: Record<string, unknown>, format: "json" | "toml"): string {
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
