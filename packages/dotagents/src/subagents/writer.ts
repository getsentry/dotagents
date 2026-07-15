import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgent } from "../targets/registry.js";
import { hasDotagentsMarkdownSubagentMarker, hasDotagentsTomlSubagentMarker } from "./format.js";
import { generatedSubagentIdentity, readSubagentFileIdentity } from "./identity.js";
import type { SubagentConfigSpec, SubagentDeclaration } from "./types.js";

export interface SubagentResolvedTarget {
  dirPath: string;
}

export type SubagentTargetResolver = (
  agentId: string,
  spec: SubagentConfigSpec,
) => SubagentResolvedTarget;

export interface SubagentWriteWarning {
  agent: string;
  name: string;
  message: string;
}

export interface SubagentWriteResult {
  warnings: SubagentWriteWarning[];
  written: number;
}

export interface SubagentVerifyIssue {
  agent: string;
  name: string;
  issue: string;
}

export interface SubagentReconcileOptions {
  mode: "inspect" | "apply";
  retainedSubagents?: Pick<SubagentDeclaration, "name" | "targets">[];
  prune?: boolean;
}

export interface SubagentReconcileResult {
  issues: SubagentVerifyIssue[];
  warnings: SubagentWriteWarning[];
  written: number;
  pruned: string[];
}

interface DesiredDir {
  extension: string;
  spec: SubagentConfigSpec;
  files: Set<string>;
}

interface PlannedWrite {
  dirPath: string;
  filePath: string;
  content: string;
}

export function projectSubagentResolver(projectRoot: string): SubagentTargetResolver {
  return (_id: string, spec: SubagentConfigSpec) => ({
    dirPath: join(projectRoot, spec.projectDir),
  });
}

export function userSubagentResolver(): SubagentTargetResolver {
  return (_id: string, spec: SubagentConfigSpec) => ({
    dirPath: spec.userDir,
  });
}

export async function writeSubagentConfigs(
  agentIds: string[],
  subagents: SubagentDeclaration[],
  resolveTarget: SubagentTargetResolver,
): Promise<SubagentWriteResult> {
  const result = await reconcileSubagentConfigs(agentIds, subagents, resolveTarget, {
    mode: "apply",
    prune: false,
  });
  return { warnings: result.warnings, written: result.written };
}

export async function pruneSubagentConfigs(
  agentIds: string[],
  desiredSubagents: Pick<SubagentDeclaration, "name" | "targets">[],
  resolveTarget: SubagentTargetResolver,
): Promise<string[]> {
  return pruneManagedFiles(initDesiredDirs(agentIds, desiredSubagents, resolveTarget));
}

export async function verifySubagentConfigs(
  agentIds: string[],
  subagents: SubagentDeclaration[],
  resolveTarget: SubagentTargetResolver,
): Promise<SubagentVerifyIssue[]> {
  if (subagents.length === 0) {return [];}
  const result = await reconcileSubagentConfigs(agentIds, subagents, resolveTarget, {
    mode: "inspect",
  });
  return result.issues;
}

/**
 * Inspects or applies runtime projections, pruning in apply mode by default.
 * Use retainedSubagents when pruning must preserve declarations that could not be loaded for writing.
 */
export async function reconcileSubagentConfigs(
  agentIds: string[],
  subagents: SubagentDeclaration[],
  resolveTarget: SubagentTargetResolver,
  options: SubagentReconcileOptions,
): Promise<SubagentReconcileResult> {
  const issues: SubagentVerifyIssue[] = [];
  const warnings: SubagentWriteWarning[] = [];
  const plannedWrites: PlannedWrite[] = [];
  const configuredAgents = new Set(agentIds);
  const seen = new Set<string>();

  for (const subagent of subagents) {
    for (const agentId of selectedAgentIds(agentIds, subagent)) {
      const issueBase = { agent: agentId, name: subagent.name };
      if (!configuredAgents.has(agentId)) {
        const message = `Subagent "${subagent.name}" targets agent "${agentId}", but "${agentId}" is not listed in agents`;
        issues.push({ ...issueBase, issue: message });
        warnings.push({ ...issueBase, message });
        continue;
      }

      const agent = getAgent(agentId);
      if (!agent) {continue;}
      if (!agent.subagents) {
        const message = `Agent "${agent.displayName}" does not support custom subagents`;
        issues.push({ ...issueBase, issue: message });
        warnings.push({ ...issueBase, message });
        continue;
      }

      const { dirPath } = resolveTarget(agentId, agent.subagents);
      const generated = agent.subagents.serialize(subagent);
      const filePath = join(dirPath, generated.fileName);
      if (seen.has(filePath)) {continue;}
      seen.add(filePath);
      const content = normalizeContent(generated.content);
      if (!hasDotagentsSubagentMarker(agent.subagents, content)) {
        throw new Error(`Internal error: generated subagent "${subagent.name}" is missing the dotagents marker`);
      }
      const generatedIdentity = generatedSubagentIdentity(
        agent.subagents,
        generated.fileName,
        content,
        subagent.name,
      );

      const identityConflict = await findUnmanagedIdentityConflict(
        dirPath,
        generated.fileName,
        agent.subagents,
        generatedIdentity,
      );
      if (identityConflict) {
        const message = `Subagent config identity conflicts with unmanaged file: ${identityConflict}`;
        issues.push({ ...issueBase, issue: message });
        warnings.push({ ...issueBase, message });
        continue;
      }

      if (!existsSync(filePath)) {
        issues.push({ ...issueBase, issue: `Subagent config missing: ${filePath}` });
        if (options.mode === "apply") {
          plannedWrites.push({ dirPath, filePath, content });
        }
        continue;
      }

      let existing: string;
      try {
        existing = await readFile(filePath, "utf-8");
      } catch (error) {
        issues.push({
          ...issueBase,
          issue: `Failed to read subagent config: ${filePath}`,
        });
        if (options.mode === "apply") {throw error;}
        continue;
      }

      if (!hasDotagentsSubagentMarker(agent.subagents, existing)) {
        const message = `Subagent config exists and is not managed by dotagents: ${filePath}`;
        issues.push({ ...issueBase, issue: message });
        warnings.push({ ...issueBase, message });
        continue;
      }

      if (existing !== content) {
        issues.push({ ...issueBase, issue: `Subagent config out of date: ${filePath}` });
        if (options.mode === "apply") {
          plannedWrites.push({ dirPath, filePath, content });
        }
      }
    }
  }

  const desiredByDir = options.mode === "apply" && options.prune !== false
    ? initDesiredDirs(
      agentIds,
      options.retainedSubagents ?? subagents,
      resolveTarget,
    )
    : null;

  for (const write of plannedWrites) {
    await mkdir(write.dirPath, { recursive: true });
    await writeFile(write.filePath, write.content, "utf-8");
  }

  const pruned = desiredByDir ? await pruneManagedFiles(desiredByDir) : [];

  return { issues, warnings, written: plannedWrites.length, pruned };
}

function initDesiredDirs(
  agentIds: string[],
  subagents: Pick<SubagentDeclaration, "name" | "targets">[],
  resolveTarget: SubagentTargetResolver,
): Map<string, DesiredDir> {
  const desiredByDir = new Map<string, DesiredDir>();
  const configuredAgents = new Set(agentIds);
  for (const agentId of configuredAgents) {
    const agent = getAgent(agentId);
    if (!agent?.subagents) {continue;}
    const { dirPath } = resolveTarget(agentId, agent.subagents);
    markDesired(desiredByDir, dirPath, agent.subagents);
  }

  for (const subagent of subagents) {
    for (const agentId of selectedAgentIds(agentIds, subagent)) {
      if (!configuredAgents.has(agentId)) {continue;}

      const agent = getAgent(agentId);
      if (!agent?.subagents) {continue;}

      const { dirPath } = resolveTarget(agentId, agent.subagents);
      markDesired(
        desiredByDir,
        dirPath,
        agent.subagents,
        `${subagent.name}${agent.subagents.fileExtension}`,
      );
    }
  }

  return desiredByDir;
}

function selectedAgentIds(
  agentIds: string[],
  subagent: Pick<SubagentDeclaration, "name" | "targets">,
): string[] {
  const targets = subagent.targets && subagent.targets.length > 0
    ? subagent.targets
    : agentIds;
  return [...new Set(targets)];
}

function markDesired(
  desiredByDir: Map<string, DesiredDir>,
  dirPath: string,
  spec: SubagentConfigSpec,
  fileName?: string,
): void {
  const desired = desiredByDir.get(dirPath) ?? {
    extension: spec.fileExtension,
    spec,
    files: new Set<string>(),
  };
  if (fileName) {
    desired.files.add(fileName);
  }
  desiredByDir.set(dirPath, desired);
}

async function pruneManagedFiles(
  desiredByDir: Map<string, DesiredDir>,
): Promise<string[]> {
  const pruned: string[] = [];
  for (const [dirPath, desired] of desiredByDir) {
    if (!existsSync(dirPath)) {continue;}

    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {continue;}
      if (!entry.name.endsWith(desired.extension)) {continue;}
      if (desired.files.has(entry.name)) {continue;}

      const filePath = join(dirPath, entry.name);
      const existing = await readFile(filePath, "utf-8");
      if (hasDotagentsSubagentMarker(desired.spec, existing)) {
        await rm(filePath);
        pruned.push(filePath);
      }
    }
  }
  return pruned;
}

async function findUnmanagedIdentityConflict(
  dirPath: string,
  generatedFileName: string,
  spec: SubagentConfigSpec,
  generatedIdentity: string | null,
): Promise<string | null> {
  if (!existsSync(dirPath)) {return null;}
  if (!generatedIdentity) {return null;}

  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    if (!entry.isFile()) {continue;}
    if (entry.name === generatedFileName) {continue;}
    if (!entry.name.endsWith(spec.fileExtension)) {continue;}

    const filePath = join(dirPath, entry.name);
    const existing = await readFile(filePath, "utf-8");
    if (hasDotagentsSubagentMarker(spec, existing)) {continue;}

    const existingIdentity = readSubagentFileIdentity(spec, filePath, entry.name, existing);
    if (existingIdentity === generatedIdentity) {
      return filePath;
    }
  }

  return null;
}

function hasDotagentsSubagentMarker(spec: SubagentConfigSpec, content: string): boolean {
  return spec.fileExtension === ".toml"
    ? hasDotagentsTomlSubagentMarker(content)
    : hasDotagentsMarkdownSubagentMarker(content);
}

function normalizeContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}
