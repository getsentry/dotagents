import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { getAgent } from "./registry.js";
import type { HookDeclaration, HookConfigSpec } from "./types.js";
import type { HookConfig } from "../config/schema.js";

export interface HookResolvedTarget {
  filePath: string;
  shared: boolean;
}

export type HookTargetResolver = (agentId: string, spec: HookConfigSpec) => HookResolvedTarget;

export interface HookReconcileIssue {
  agent: string;
  issue: string;
}

export interface HookWriteWarning {
  agent: string;
  message: string;
}

export interface HookReconcileResult {
  issues: HookReconcileIssue[];
  warnings: HookWriteWarning[];
  written: string[];
  removed: string[];
}

/** Convert HookConfig entries from agents.toml to universal declarations. */
export function toHookDeclarations(configs: HookConfig[]): HookDeclaration[] {
  return configs.map((h) => ({
    event: h.event,
    ...(h.matcher && { matcher: h.matcher }),
    command: h.command,
  }));
}

/** Resolve project hook config paths relative to the project root. */
export function projectHookResolver(projectRoot: string): HookTargetResolver {
  return (_id: string, spec: HookConfigSpec) => ({
    filePath: join(projectRoot, spec.filePath),
    shared: spec.shared,
  });
}

/** Write hook configs while retaining the v1 warning-only result shape. */
export async function writeHookConfigs(
  agentIds: string[],
  hooks: HookDeclaration[],
  resolveTarget: HookTargetResolver,
): Promise<HookWriteWarning[]> {
  if (hooks.length === 0) {return [];}
  return (await reconcileHookConfigs(agentIds, hooks, resolveTarget, "apply")).warnings;
}

/** Inspect hook configs while retaining the v1 issue-only result shape. */
export async function verifyHookConfigs(
  agentIds: string[],
  hooks: HookDeclaration[],
  resolveTarget: HookTargetResolver,
): Promise<HookReconcileIssue[]> {
  if (hooks.length === 0) {return [];}
  return (await reconcileHookConfigs(agentIds, hooks, resolveTarget, "inspect")).issues;
}

/** Inspect or apply the target-specific hook root owned by dotagents. */
export async function reconcileHookConfigs(
  agentIds: string[],
  hooks: HookDeclaration[],
  resolveTarget: HookTargetResolver,
  mode: "inspect" | "apply",
): Promise<HookReconcileResult> {
  const issues: HookReconcileIssue[] = [];
  const warnings: HookWriteWarning[] = [];
  const written: string[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent) {continue;}

    if (!agent.hooks) {
      if (hooks.length > 0) {
        warnings.push({
          agent: id,
          message: `Agent "${agent.displayName}" does not support hooks`,
        });
      }
      continue;
    }

    const spec = agent.hooks;
    const { filePath, shared } = resolveTarget(id, spec);
    if (seen.has(filePath)) {continue;}
    seen.add(filePath);

    if (hooks.length === 0) {
      if (!existsSync(filePath)) {continue;}
      if (!shared) {
        issues.push({ agent: id, issue: `Stale hook config: ${filePath}` });
        if (mode === "apply") {
          await rm(filePath);
          removed.push(filePath);
        }
        continue;
      }

      const existing = await readForCleanup(filePath, issues, id);
      if (!existing || !(spec.rootKey in existing)) {continue;}
      issues.push({ agent: id, issue: `Stale hook root "${spec.rootKey}" in ${filePath}` });
      if (mode === "apply") {
        delete existing[spec.rootKey];
        await writeDocument(filePath, existing);
        written.push(filePath);
      }
      continue;
    }

    const serialized = agent.serializeHooks(hooks);
    const expected = { ...spec.extraFields, [spec.rootKey]: serialized };
    if (!existsSync(filePath)) {
      issues.push({ agent: id, issue: `Hook config missing: ${filePath}` });
      if (mode === "apply") {
        await writeDocument(filePath, expected);
        written.push(filePath);
      }
      continue;
    }

    let existing: Record<string, unknown> | undefined;
    try {
      existing = await readExisting(filePath);
    } catch (error) {
      issues.push({ agent: id, issue: `Failed to read hook config: ${filePath}` });
      if (mode === "apply" && !shared) {
        await writeDocument(filePath, expected);
        written.push(filePath);
        continue;
      }
      if (mode === "apply") {throw error;}
      continue;
    }

    const matches = shared
      ? isDeepStrictEqual(existing[spec.rootKey], serialized)
      : isDeepStrictEqual(existing, expected);
    if (matches) {continue;}

    issues.push({ agent: id, issue: `Hook config drifted: ${filePath}` });
    if (mode === "apply") {
      const next = shared ? { ...existing, [spec.rootKey]: serialized } : expected;
      await writeDocument(filePath, next);
      written.push(filePath);
    }
  }

  return { issues, warnings, written, removed };
}

async function readForCleanup(
  filePath: string,
  issues: HookReconcileIssue[],
  agent: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readExisting(filePath);
  } catch {
    issues.push({ agent, issue: `Failed to read hook config: ${filePath}` });
    return undefined;
  }
}

async function writeDocument(
  filePath: string,
  document: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
}

async function readExisting(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf-8");
  const document: unknown = JSON.parse(raw);
  if (!isRecord(document)) {
    throw new TypeError(`Hook config must contain an object: ${filePath}`);
  }
  return document;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
