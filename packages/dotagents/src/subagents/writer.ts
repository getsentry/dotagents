import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgent } from "../targets/registry.js";
import { hasDotagentsMarkdownSubagentMarker, hasDotagentsTomlSubagentMarker } from "./format.js";
import { generatedSubagentIdentity, readSubagentFileIdentity } from "./identity.js";
import type { SubagentConfigSpec, SubagentDeclaration } from "./types.js";

// Owns runtime-specific subagent projection. Managed markers protect generated
// files, while identity checks prevent overwriting user-authored subagents.
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

interface DesiredDir {
  extension: string;
  spec: SubagentConfigSpec;
  files: Set<string>;
}

/** Resolves project-scope runtime subagent directories relative to a project root. */
export function projectSubagentResolver(projectRoot: string): SubagentTargetResolver {
  return (_id: string, spec: SubagentConfigSpec) => ({
    dirPath: join(projectRoot, spec.projectDir),
  });
}

/** Resolves user-scope runtime subagent directories from each target definition. */
export function userSubagentResolver(): SubagentTargetResolver {
  return (_id: string, spec: SubagentConfigSpec) => ({
    dirPath: spec.userDir,
  });
}

/** Writes managed runtime subagent configs for all configured target agents. */
export async function writeSubagentConfigs(
  agentIds: string[],
  subagents: SubagentDeclaration[],
  resolveTarget: SubagentTargetResolver,
): Promise<SubagentWriteResult> {
  const warnings: SubagentWriteWarning[] = [];
  let written = 0;
  const configuredAgents = new Set(agentIds);

  for (const subagent of subagents) {
    for (const agentId of selectedAgentIds(agentIds, subagent)) {
      if (!configuredAgents.has(agentId)) {
        warnings.push({
          agent: agentId,
          name: subagent.name,
          message: `Subagent "${subagent.name}" targets agent "${agentId}", but "${agentId}" is not listed in agents`,
        });
        continue;
      }

      const agent = getAgent(agentId);
      if (!agent) {continue;}
      if (!agent.subagents) {
        warnings.push({
          agent: agentId,
          name: subagent.name,
          message: `Agent "${agent.displayName}" does not support custom subagents`,
        });
        continue;
      }

      const { dirPath } = resolveTarget(agentId, agent.subagents);
      const generated = agent.subagents.serialize(subagent);
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

      await mkdir(dirPath, { recursive: true });
      const identityConflict = await findUnmanagedIdentityConflict(
        dirPath,
        generated.fileName,
        agent.subagents,
        generatedIdentity,
      );
      if (identityConflict) {
        warnings.push({
          agent: agentId,
          name: subagent.name,
          message: `Subagent config identity conflicts with unmanaged file: ${identityConflict}`,
        });
        continue;
      }
      const didWrite = await writeManagedFile(join(dirPath, generated.fileName), content, {
        agent: agentId,
        name: subagent.name,
        spec: agent.subagents,
        warnings,
      });
      if (didWrite) {written++;}
    }
  }

  return { warnings, written };
}

/** Prunes managed runtime subagent files that are no longer desired. */
export async function pruneSubagentConfigs(
  agentIds: string[],
  desiredSubagents: Pick<SubagentDeclaration, "name" | "targets">[],
  resolveTarget: SubagentTargetResolver,
): Promise<string[]> {
  return pruneManagedFiles(initDesiredDirs(agentIds, desiredSubagents, resolveTarget));
}

/** Verifies that managed runtime subagent files exist and still match desired output. */
export async function verifySubagentConfigs(
  agentIds: string[],
  subagents: SubagentDeclaration[],
  resolveTarget: SubagentTargetResolver,
): Promise<SubagentVerifyIssue[]> {
  if (subagents.length === 0) {return [];}

  const issues: SubagentVerifyIssue[] = [];
  const configuredAgents = new Set(agentIds);
  const seen = new Set<string>();

  for (const subagent of subagents) {
    for (const agentId of selectedAgentIds(agentIds, subagent)) {
      const issueBase = { agent: agentId, name: subagent.name };

      if (!configuredAgents.has(agentId)) {
        issues.push({
          ...issueBase,
          issue: `Subagent "${subagent.name}" targets agent "${agentId}", but "${agentId}" is not listed in agents`,
        });
        continue;
      }

      const agent = getAgent(agentId);
      if (!agent) {continue;}
      if (!agent.subagents) {
        issues.push({
          ...issueBase,
          issue: `Agent "${agent.displayName}" does not support custom subagents`,
        });
        continue;
      }

      const { dirPath } = resolveTarget(agentId, agent.subagents);
      const generated = agent.subagents.serialize(subagent);
      const filePath = join(dirPath, generated.fileName);
      if (seen.has(filePath)) {continue;}
      seen.add(filePath);
      const content = normalizeContent(generated.content);

      const identityConflict = await findUnmanagedIdentityConflict(
        dirPath,
        generated.fileName,
        agent.subagents,
        generatedSubagentIdentity(agent.subagents, generated.fileName, content, subagent.name),
      );
      if (identityConflict) {
        issues.push({
          ...issueBase,
          issue: `Subagent config identity conflicts with unmanaged file: ${identityConflict}`,
        });
        continue;
      }

      if (!existsSync(filePath)) {
        issues.push({
          ...issueBase,
          issue: `Subagent config missing: ${filePath}`,
        });
        continue;
      }

      try {
        const existing = await readFile(filePath, "utf-8");
        if (!hasDotagentsSubagentMarker(agent.subagents, existing)) {
          issues.push({
            ...issueBase,
            issue: `Subagent config exists and is not managed by dotagents: ${filePath}`,
          });
          continue;
        }

        if (existing !== normalizeContent(generated.content)) {
          issues.push({
            ...issueBase,
            issue: `Subagent config out of date: ${filePath}`,
          });
        }
      } catch {
        issues.push({
          ...issueBase,
          issue: `Failed to read subagent config: ${filePath}`,
        });
      }
    }
  }

  return issues;
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

async function writeManagedFile(
  filePath: string,
  content: string,
  context: { agent: string; name: string; spec: SubagentConfigSpec; warnings: SubagentWriteWarning[] },
): Promise<boolean> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (existing === content) {return false;}
    if (!hasDotagentsSubagentMarker(context.spec, existing)) {
      context.warnings.push({
        agent: context.agent,
        name: context.name,
        message: `Subagent config exists and is not managed by dotagents: ${filePath}`,
      });
      return false;
    }
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }

  await writeFile(filePath, content, "utf-8");
  return true;
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

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
