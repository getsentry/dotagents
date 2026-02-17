import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { getAgent } from "./registry.js";
import type { HookDeclaration, HookConfigSpec } from "./types.js";
import type { HookConfig } from "../config/schema.js";

export interface HookResolvedTarget {
  filePath: string;
  shared: boolean;
}

export type HookTargetResolver = (agentId: string, spec: HookConfigSpec) => HookResolvedTarget;

/**
 * Convert HookConfig entries (from agents.toml) to universal HookDeclarations.
 */
export function toHookDeclarations(configs: HookConfig[]): HookDeclaration[] {
  return configs.map((h) => ({
    event: h.event,
    ...(h.matcher && { matcher: h.matcher }),
    command: h.command,
  }));
}

/**
 * Convenience resolver for project-scope hooks: joins spec.filePath with projectRoot.
 */
export function projectHookResolver(projectRoot: string): HookTargetResolver {
  return (_id: string, spec: HookConfigSpec) => ({
    filePath: join(projectRoot, spec.filePath),
    shared: spec.shared,
  });
}

export interface HookWriteWarning {
  agent: string;
  message: string;
}

/**
 * Write hook config files for each agent.
 * - Dedicated files (shared=false): written fresh each time.
 * - Shared files (shared=true): read existing, merge hooks under the root key, write back.
 * - Agents that don't support hooks: collected as warnings.
 */
export async function writeHookConfigs(
  agentIds: string[],
  hooks: HookDeclaration[],
  resolveTarget: HookTargetResolver,
): Promise<HookWriteWarning[]> {
  const warnings: HookWriteWarning[] = [];
  if (hooks.length === 0) return warnings;

  const seen = new Set<string>();

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) continue;

    if (!agent.hooks) {
      warnings.push({ agent: id, message: `Agent "${agent.displayName}" does not support hooks` });
      continue;
    }

    const serialized = agent.serializeHooks(hooks);
    const spec = agent.hooks;
    const { filePath, shared } = resolveTarget(id, spec);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    await mkdir(dirname(filePath), { recursive: true });

    if (shared) {
      await mergeWrite(filePath, spec, serialized);
    } else {
      await freshWrite(filePath, spec, serialized);
    }
  }

  return warnings;
}

/**
 * Verify hook configs exist and contain expected hook data.
 * Returns a list of issues found.
 */
export async function verifyHookConfigs(
  agentIds: string[],
  hooks: HookDeclaration[],
  resolveTarget: HookTargetResolver,
): Promise<{ agent: string; issue: string }[]> {
  if (hooks.length === 0) return [];

  const issues: { agent: string; issue: string }[] = [];
  const seen = new Set<string>();

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) continue;

    // Skip agents that don't support hooks
    if (!agent.hooks) continue;

    const spec = agent.hooks;
    const { filePath } = resolveTarget(id, spec);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (!existsSync(filePath)) {
      issues.push({ agent: id, issue: `Hook config missing: ${filePath}` });
      continue;
    }

    try {
      const existing = await readExisting(filePath);
      const hooksSection = existing[spec.rootKey];
      if (!hooksSection || typeof hooksSection !== "object") {
        issues.push({ agent: id, issue: `Hook config missing "${spec.rootKey}" key in ${filePath}` });
      }
    } catch {
      issues.push({ agent: id, issue: `Failed to read hook config: ${filePath}` });
    }
  }

  return issues;
}

// --- Internal helpers ---

async function freshWrite(
  filePath: string,
  spec: HookConfigSpec,
  serialized: unknown,
): Promise<void> {
  const doc: Record<string, unknown> = {
    ...spec.extraFields,
    [spec.rootKey]: serialized,
  };
  await writeFile(filePath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

async function mergeWrite(
  filePath: string,
  spec: HookConfigSpec,
  serialized: unknown,
): Promise<void> {
  const existing = existsSync(filePath) ? await readExisting(filePath) : {};
  existing[spec.rootKey] = serialized;
  await writeFile(filePath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

async function readExisting(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}
