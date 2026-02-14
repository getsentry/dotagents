import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { ensureSkillsSymlink, verifySymlinks } from "../../symlinks/manager.js";
import { hashDirectory } from "../../utils/hash.js";
import { getAgent } from "../../agents/registry.js";
import { verifyMcpConfigs, writeMcpConfigs, toMcpDeclarations } from "../../agents/mcp-writer.js";

export interface SyncIssue {
  type: "orphan" | "modified" | "symlink" | "missing" | "mcp";
  name: string;
  message: string;
}

export interface SyncOptions {
  projectRoot: string;
}

export interface SyncResult {
  issues: SyncIssue[];
  gitignoreUpdated: boolean;
  symlinksRepaired: number;
  mcpRepaired: number;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { projectRoot } = opts;
  const configPath = join(projectRoot, "agents.toml");
  const lockPath = join(projectRoot, "agents.lock");
  const agentsDir = join(projectRoot, ".agents");
  const skillsDir = join(agentsDir, "skills");

  const config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);
  const declaredNames = new Set(config.skills.map((s) => s.name));
  const issues: SyncIssue[] = [];

  // 1. Regenerate .agents/.gitignore
  await updateAgentsGitignore(agentsDir, config.gitignore, [...declaredNames]);

  // 2. Check for orphaned skills (installed but not in agents.toml)
  if (existsSync(skillsDir)) {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!declaredNames.has(entry.name)) {
        issues.push({
          type: "orphan",
          name: entry.name,
          message: `"${entry.name}" is installed but not in agents.toml`,
        });
      }
    }
  }

  // 3. Check for missing skills (in agents.toml but not installed)
  for (const name of declaredNames) {
    if (!existsSync(join(skillsDir, name))) {
      issues.push({
        type: "missing",
        name,
        message: `"${name}" is in agents.toml but not installed. Run 'dotagents install'.`,
      });
    }
  }

  // 4. Verify integrity hashes against lockfile
  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.skills)) {
      const installed = join(skillsDir, name);
      if (!existsSync(installed)) continue;

      const integrity = await hashDirectory(installed);
      if (integrity !== locked.integrity) {
        issues.push({
          type: "modified",
          name,
          message: `"${name}" has been locally modified (integrity mismatch)`,
        });
      }
    }
  }

  // 5. Verify and repair legacy symlinks
  const targets = config.symlinks?.targets ?? [];
  let symlinksRepaired = 0;

  const symlinkIssues = await verifySymlinks(
    agentsDir,
    targets.map((t) => join(projectRoot, t)),
  );

  for (const issue of symlinkIssues) {
    const targetDir = join(projectRoot, issue.target);
    await ensureSkillsSymlink(agentsDir, targetDir);
    symlinksRepaired++;
  }

  // 6. Verify and repair agent-specific symlinks (dedup across agents)
  const seenParentDirs = new Set(targets);
  const agentTargets: string[] = [];
  for (const agentId of config.agents) {
    const agent = getAgent(agentId);
    if (!agent) continue;
    if (seenParentDirs.has(agent.skillsParentDir)) continue;
    seenParentDirs.add(agent.skillsParentDir);
    agentTargets.push(join(projectRoot, agent.skillsParentDir));
  }

  const agentSymlinkIssues = await verifySymlinks(agentsDir, agentTargets);
  for (const issue of agentSymlinkIssues) {
    await ensureSkillsSymlink(agentsDir, issue.target);
    symlinksRepaired++;
  }

  // 7. Verify and repair MCP configs
  let mcpRepaired = 0;
  const mcpServers = toMcpDeclarations(config.mcp);

  const mcpIssues = await verifyMcpConfigs(projectRoot, config.agents, mcpServers);
  if (mcpIssues.length > 0) {
    await writeMcpConfigs(projectRoot, config.agents, mcpServers);
    mcpRepaired = mcpIssues.length;
    for (const issue of mcpIssues) {
      issues.push({
        type: "mcp",
        name: issue.agent,
        message: issue.issue,
      });
    }
  }

  return {
    issues,
    gitignoreUpdated: config.gitignore,
    symlinksRepaired,
    mcpRepaired,
  };
}

export default async function sync(): Promise<void> {
  const { resolve } = await import("node:path");
  const result = await runSync({ projectRoot: resolve(".") });

  if (result.gitignoreUpdated) {
    console.log(chalk.green("Regenerated .agents/.gitignore"));
  } else {
    console.log(chalk.green("Removed .agents/.gitignore (skills checked into git)"));
  }

  if (result.symlinksRepaired > 0) {
    console.log(chalk.green(`Repaired ${result.symlinksRepaired} symlink(s)`));
  }

  if (result.mcpRepaired > 0) {
    console.log(chalk.green(`Repaired ${result.mcpRepaired} MCP config(s)`));
  }

  if (result.issues.length === 0) {
    console.log(chalk.green("Everything in sync."));
    return;
  }

  for (const issue of result.issues) {
    switch (issue.type) {
      case "orphan":
      case "modified":
      case "mcp":
        console.log(chalk.yellow(`  warn: ${issue.message}`));
        break;
      case "missing":
        console.log(chalk.red(`  error: ${issue.message}`));
        break;
    }
  }
}
