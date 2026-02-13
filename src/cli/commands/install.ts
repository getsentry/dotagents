import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { isGitLocked } from "../../lockfile/schema.js";
import type { Lockfile, LockedSkill } from "../../lockfile/schema.js";
import { resolveSkill } from "../../skills/resolver.js";
import type { ResolvedSkill } from "../../skills/resolver.js";
import { hashDirectory } from "../../utils/hash.js";
import { copyDir } from "../../utils/fs.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { ensureSkillsSymlink } from "../../symlinks/manager.js";
import { getAgent } from "../../agents/registry.js";
import { writeMcpConfigs } from "../../agents/mcp-writer.js";
import type { McpDeclaration } from "../../agents/types.js";

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

export interface InstallOptions {
  projectRoot: string;
  frozen?: boolean;
  force?: boolean;
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const { projectRoot, frozen, force } = opts;
  const configPath = join(projectRoot, "agents.toml");
  const lockPath = join(projectRoot, "agents.lock");
  const agentsDir = join(projectRoot, ".agents");
  const skillsDir = join(agentsDir, "skills");

  // 1. Read config
  const config = await loadConfig(configPath);
  const skillNames = config.skills.map((s) => s.name);

  if (skillNames.length === 0) {
    console.log(chalk.dim("No skills declared in agents.toml."));
    return { installed: [], skipped: [] };
  }

  // 2. Read lockfile
  const lockfile = await loadLockfile(lockPath);

  if (frozen && !lockfile) {
    throw new InstallError("--frozen requires agents.lock to exist.");
  }

  if (frozen) {
    // Verify all skills are in lockfile
    for (const name of skillNames) {
      if (!lockfile!.skills[name]) {
        throw new InstallError(
          `--frozen: skill "${name}" is in agents.toml but missing from agents.lock.`,
        );
      }
    }
  }

  // 3. Ensure directories exist
  await mkdir(skillsDir, { recursive: true });

  // 4. Resolve and install each skill
  const newLock: Lockfile = { version: 1, skills: {} };
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const name of skillNames) {
    const dep = config.skills.find((s) => s.name === name)!;
    const locked = lockfile?.skills[name];

    // If locked and not forced, use the locked commit
    const lockedCommit =
      !force && locked && isGitLocked(locked) ? locked.commit : undefined;

    let resolved: ResolvedSkill;
    try {
      resolved = await resolveSkill(name, dep, {
        projectRoot,
        lockedCommit,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new InstallError(`Failed to resolve skill "${name}": ${msg}`);
    }

    // Copy skill into .agents/skills/<name>/
    const destDir = join(skillsDir, name);
    await copyDir(resolved.skillDir, destDir);

    // Compute integrity hash
    const integrity = await hashDirectory(destDir);

    // Frozen mode: verify integrity matches lockfile
    if (frozen && locked) {
      if (locked.integrity !== integrity) {
        throw new InstallError(
          `--frozen: integrity mismatch for "${name}". ` +
            `Expected ${locked.integrity}, got ${integrity}.`,
        );
      }
    }

    // Build lock entry
    const lockEntry: LockedSkill =
      resolved.type === "git"
        ? {
            source: dep.source,
            resolved_url: resolved.resolvedUrl,
            resolved_path: resolved.resolvedPath,
            ...(resolved.resolvedRef ? { resolved_ref: resolved.resolvedRef } : {}),
            commit: resolved.commit,
            integrity,
          }
        : {
            source: dep.source,
            integrity,
          };

    newLock.skills[name] = lockEntry;
    installed.push(name);
  }

  // 5. Write lockfile (unless frozen)
  if (!frozen) {
    await writeLockfile(lockPath, newLock);
  }

  // 6. Regenerate .agents/.gitignore
  await updateAgentsGitignore(agentsDir, config.gitignore, skillNames);

  // 7. Create/verify symlinks (legacy [symlinks] config)
  const targets = config.symlinks?.targets ?? [];
  for (const target of targets) {
    await ensureSkillsSymlink(agentsDir, join(projectRoot, target));
  }

  // 8. Create agent-specific symlinks (dedup with legacy targets)
  const legacyTargetSet = new Set(targets);
  for (const agentId of config.agents) {
    const agent = getAgent(agentId);
    if (!agent) continue;
    if (legacyTargetSet.has(agent.skillsParentDir)) continue;
    await ensureSkillsSymlink(agentsDir, join(projectRoot, agent.skillsParentDir));
  }

  // 9. Write MCP config files
  const mcpServers: McpDeclaration[] = config.mcp.map((m) => ({
    name: m.name,
    ...(m.command && { command: m.command }),
    ...(m.args && { args: m.args }),
    ...(m.url && { url: m.url }),
    ...(m.headers && { headers: m.headers }),
    ...(m.env.length > 0 && { env: m.env }),
  }));
  await writeMcpConfigs(projectRoot, config.agents, mcpServers);

  return { installed, skipped };
}

export default async function install(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      frozen: { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
  });

  const { resolve } = await import("node:path");
  try {
    const result = await runInstall({
      projectRoot: resolve("."),
      frozen: values["frozen"],
      force: values["force"],
    });

    if (result.installed.length > 0) {
      console.log(
        chalk.green(`Installed ${result.installed.length} skill(s): ${result.installed.join(", ")}`),
      );
    }
  } catch (err) {
    if (err instanceof InstallError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
