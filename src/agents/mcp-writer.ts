import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { stringify as tomlStringify, parse as parseTOML } from "smol-toml";
import { getAgent } from "./registry.js";
import type { McpDeclaration, McpConfigSpec } from "./types.js";
import type { McpConfig } from "../config/schema.js";

export interface McpResolvedTarget {
  filePath: string;
  shared: boolean;
}

export type McpTargetResolver = (agentId: string, spec: McpConfigSpec) => McpResolvedTarget;

/**
 * Convert McpConfig entries (from agents.toml) to universal McpDeclarations.
 */
export function toMcpDeclarations(configs: McpConfig[]): McpDeclaration[] {
  return configs.map((m) => ({
    name: m.name,
    ...(m.command && { command: m.command }),
    ...(m.args && { args: m.args }),
    ...(m.url && { url: m.url }),
    ...(m.headers && { headers: m.headers }),
    ...(m.env.length > 0 && { env: m.env }),
  }));
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
 * - Dedicated files (shared=false): written fresh each time.
 * - Shared files (shared=true): read existing, merge dotagents servers under the root key, write back.
 */
export async function writeMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
): Promise<void> {
  if (servers.length === 0) return;

  // Deduplicate by resolved filePath so shared files aren't written twice
  const seen = new Set<string>();

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) continue;

    const { mcp } = agent;
    const { filePath, shared } = resolveTarget(id, mcp);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const serialized: Record<string, unknown> = {};
    for (const server of servers) {
      const [name, config] = agent.serializeServer(server);
      serialized[name] = config;
    }

    await mkdir(dirname(filePath), { recursive: true });

    if (shared) {
      await mergeWrite(filePath, mcp, serialized);
    } else {
      await freshWrite(filePath, mcp, serialized);
    }
  }
}

/**
 * Verify MCP configs exist and contain the expected servers.
 * Returns a list of issues found.
 */
export async function verifyMcpConfigs(
  agentIds: string[],
  servers: McpDeclaration[],
  resolveTarget: McpTargetResolver,
): Promise<{ agent: string; issue: string }[]> {
  if (servers.length === 0) return [];

  const issues: { agent: string; issue: string }[] = [];
  const seen = new Set<string>();

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) continue;

    const { mcp } = agent;
    const { filePath } = resolveTarget(id, mcp);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (!existsSync(filePath)) {
      issues.push({ agent: id, issue: `MCP config missing: ${filePath}` });
      continue;
    }

    // Verify content has the expected servers
    const expectedNames = servers.map((s) => s.name);
    try {
      const existing = await readExisting(filePath, mcp);
      const existingServers = existing[mcp.rootKey] as Record<string, unknown> | undefined;
      for (const name of expectedNames) {
        if (!existingServers || !(name in existingServers)) {
          issues.push({ agent: id, issue: `MCP server "${name}" missing from ${filePath}` });
        }
      }
    } catch {
      issues.push({ agent: id, issue: `Failed to read MCP config: ${filePath}` });
    }
  }

  return issues;
}

// --- Internal helpers ---

async function freshWrite(
  filePath: string,
  spec: McpConfigSpec,
  servers: Record<string, unknown>,
): Promise<void> {
  const doc = { [spec.rootKey]: servers };
  await writeFile(filePath, serialize(doc, spec.format), "utf-8");
}

async function mergeWrite(
  filePath: string,
  spec: McpConfigSpec,
  servers: Record<string, unknown>,
): Promise<void> {
  const existing = existsSync(filePath) ? await readExisting(filePath, spec) : {};
  const prev = (existing[spec.rootKey] ?? {}) as Record<string, unknown>;
  existing[spec.rootKey] = { ...prev, ...servers };
  await writeFile(filePath, serialize(existing, spec.format), "utf-8");
}

async function readExisting(
  filePath: string,
  spec: McpConfigSpec,
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf-8");
  if (spec.format === "toml") {
    return parseTOML(raw) as Record<string, unknown>;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function serialize(doc: Record<string, unknown>, format: "json" | "toml"): string {
  if (format === "toml") {
    return tomlStringify(doc) + "\n";
  }
  return JSON.stringify(doc, null, 2) + "\n";
}
