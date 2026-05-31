import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse as parseTOML } from "smol-toml";
import { loadMarkdownFrontmatter } from "@sentry/dotagents-lib";
import { allAgents, getAgent } from "./registry.js";
import { DOTAGENTS_SUBAGENT_MARKER } from "./definitions/helpers.js";
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
  pruned: string[];
}

export interface SubagentVerifyIssue {
  agent: string;
  name: string;
  issue: string;
  repairable: boolean;
}

type DesiredSubagent = Pick<SubagentDeclaration, "name" | "targets">;

interface DesiredDir {
  extension: string;
  files: Set<string>;
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
  opts: { desiredSubagents?: DesiredSubagent[] } = {},
): Promise<SubagentWriteResult> {
  const warnings: SubagentWriteWarning[] = [];
  let written = 0;
  const configuredAgents = new Set(agentIds);
  const desiredByDir = initDesiredDirs(
    agentIds,
    opts.desiredSubagents ?? subagents,
    resolveTarget,
  );

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
      if (!content.includes(DOTAGENTS_SUBAGENT_MARKER)) {
        throw new Error(`Internal error: generated subagent "${subagent.name}" is missing the dotagents marker`);
      }
      const generatedIdentity = generatedSubagentIdentity(
        agentId,
        generated.fileName,
        content,
        subagent.name,
      );

      await mkdir(dirPath, { recursive: true });
      markDesired(desiredByDir, dirPath, agent.subagents.fileExtension, generated.fileName);
      const identityConflict = await findUnmanagedIdentityConflict(
        agentId,
        dirPath,
        generated.fileName,
        agent.subagents.fileExtension,
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
        warnings,
      });
      if (didWrite) {written++;}
    }
  }

  const pruned = await pruneManagedFiles(desiredByDir);
  return { warnings, written, pruned };
}

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
          repairable: false,
        });
        continue;
      }

      const agent = getAgent(agentId);
      if (!agent) {continue;}
      if (!agent.subagents) {
        issues.push({
          ...issueBase,
          issue: `Agent "${agent.displayName}" does not support custom subagents`,
          repairable: false,
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
        agentId,
        dirPath,
        generated.fileName,
        agent.subagents.fileExtension,
        generatedSubagentIdentity(agentId, generated.fileName, content, subagent.name),
      );
      if (identityConflict) {
        issues.push({
          ...issueBase,
          issue: `Subagent config identity conflicts with unmanaged file: ${identityConflict}`,
          repairable: false,
        });
        continue;
      }

      if (!existsSync(filePath)) {
        issues.push({
          ...issueBase,
          issue: `Subagent config missing: ${filePath}`,
          repairable: true,
        });
        continue;
      }

      try {
        const existing = await readFile(filePath, "utf-8");
        if (!existing.includes(DOTAGENTS_SUBAGENT_MARKER)) {
          issues.push({
            ...issueBase,
            issue: `Subagent config exists and is not managed by dotagents: ${filePath}`,
            repairable: false,
          });
          continue;
        }

        if (existing !== normalizeContent(generated.content)) {
          issues.push({
            ...issueBase,
            issue: `Subagent config out of date: ${filePath}`,
            repairable: true,
          });
        }
      } catch {
        issues.push({
          ...issueBase,
          issue: `Failed to read subagent config: ${filePath}`,
          repairable: false,
        });
      }
    }
  }

  return issues;
}

function initDesiredDirs(
  agentIds: string[],
  subagents: DesiredSubagent[],
  resolveTarget: SubagentTargetResolver,
): Map<string, DesiredDir> {
  const desiredByDir = new Map<string, DesiredDir>();
  const configuredAgents = new Set(agentIds);
  for (const agent of allAgents()) {
    if (!agent.subagents) {continue;}
    const { dirPath } = resolveTarget(agent.id, agent.subagents);
    markDesired(desiredByDir, dirPath, agent.subagents.fileExtension);
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
        agent.subagents.fileExtension,
        `${subagent.name}${agent.subagents.fileExtension}`,
      );
    }
  }

  return desiredByDir;
}

function selectedAgentIds(
  agentIds: string[],
  subagent: DesiredSubagent,
): string[] {
  return [...new Set(subagent.targets ?? agentIds)];
}

function markDesired(
  desiredByDir: Map<string, DesiredDir>,
  dirPath: string,
  extension: string,
  fileName?: string,
): void {
  const desired = desiredByDir.get(dirPath) ?? { extension, files: new Set<string>() };
  if (fileName) {
    desired.files.add(fileName);
  }
  desiredByDir.set(dirPath, desired);
}

async function writeManagedFile(
  filePath: string,
  content: string,
  context: { agent: string; name: string; warnings: SubagentWriteWarning[] },
): Promise<boolean> {
  try {
    const existing = await readFile(filePath, "utf-8");
    if (existing === content) {return false;}
    if (!existing.includes(DOTAGENTS_SUBAGENT_MARKER)) {
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
      if (existing.includes(DOTAGENTS_SUBAGENT_MARKER)) {
        await rm(filePath);
        pruned.push(filePath);
      }
    }
  }
  return pruned;
}

async function findUnmanagedIdentityConflict(
  agentId: string,
  dirPath: string,
  generatedFileName: string,
  extension: string,
  generatedIdentity: string | null,
): Promise<string | null> {
  if (!existsSync(dirPath)) {return null;}
  if (!generatedIdentity) {return null;}

  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) {continue;}
    if (entry.name === generatedFileName) {continue;}
    if (!entry.name.endsWith(extension)) {continue;}

    const filePath = join(dirPath, entry.name);
    const existing = await readFile(filePath, "utf-8");
    if (existing.includes(DOTAGENTS_SUBAGENT_MARKER)) {continue;}

    const existingIdentity = await readExistingSubagentIdentity(agentId, filePath, entry.name, existing);
    if (existingIdentity === generatedIdentity) {
      return filePath;
    }
  }

  return null;
}

function generatedSubagentIdentity(
  agentId: string,
  fileName: string,
  content: string,
  portableName: string,
): string | null {
  if (agentId === "opencode") {
    return basename(fileName, extname(fileName));
  }
  if (agentId === "codex") {
    return readCodexSubagentIdentity(content);
  }
  return portableName;
}

async function readExistingSubagentIdentity(
  agentId: string,
  filePath: string,
  fileName: string,
  content: string,
): Promise<string | null> {
  if (agentId === "opencode") {
    return basename(fileName, extname(fileName));
  }
  if (agentId === "codex") {
    return readCodexSubagentIdentity(content);
  }

  try {
    const { meta } = await loadMarkdownFrontmatter(filePath);
    const name = typeof meta["name"] === "string" && meta["name"] ? meta["name"] : null;
    return name ?? (agentId === "cursor" ? basename(fileName, extname(fileName)) : null);
  } catch {
    return null;
  }
}

function readCodexSubagentIdentity(content: string): string | null {
  try {
    const parsed = parseTOML(content);
    if (isPlainObject(parsed) && typeof parsed["name"] === "string" && parsed["name"]) {
      return parsed["name"];
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
