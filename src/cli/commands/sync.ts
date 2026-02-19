import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { normalizeSource } from "../../skills/resolver.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { addSkillToConfig } from "../../config/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { ensureSkillsSymlink, verifySymlinks } from "../../symlinks/manager.js";
import { hashDirectory } from "../../utils/hash.js";
import { getAgent } from "../../agents/registry.js";
import { verifyMcpConfigs, writeMcpConfigs, toMcpDeclarations, projectMcpResolver } from "../../agents/mcp-writer.js";
import { verifyHookConfigs, writeHookConfigs, toHookDeclarations, projectHookResolver } from "../../agents/hook-writer.js";
import { userMcpResolver } from "../../agents/paths.js";
import { resolveScope, resolveDefaultScope, ScopeError } from "../../scope.js";
import type { ScopeRoot } from "../../scope.js";

/** A skill whose source points to its own install location (adopted orphan). */
function isInPlaceSkill(source: string): boolean {
  return source.startsWith("path:.agents/skills/") || source.startsWith("path:skills/");
}

export interface SyncIssue {
  type: "modified" | "symlink" | "missing" | "mcp" | "hooks";
  name: string;
  message: string;
}

export interface SyncOptions {
  scope: ScopeRoot;
}

export interface SyncResult {
  issues: SyncIssue[];
  adopted: string[];
  gitignoreUpdated: boolean;
  symlinksRepaired: number;
  mcpRepaired: number;
  hooksRepaired: number;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { scope } = opts;
  const { configPath, lockPath, agentsDir, skillsDir } = scope;

  let config = await loadConfig(configPath);
  const lockfile = await loadLockfile(lockPath);
  // Build declared names from explicit entries + wildcard-expanded lockfile entries
  const declaredNames = new Set(
    config.skills.filter((s) => !isWildcardDep(s)).map((s) => s.name),
  );
  if (lockfile) {
    // Add concrete skill names from wildcard sources
    const wildcardSources = new Set(
      config.skills.filter(isWildcardDep).map((s) => normalizeSource(s.source)),
    );
    for (const [name, locked] of Object.entries(lockfile.skills)) {
      if (wildcardSources.has(normalizeSource(locked.source))) {
        declaredNames.add(name);
      }
    }
  }
  const issues: SyncIssue[] = [];
  const adopted: string[] = [];

  // 1. Adopt orphaned skills (installed but not in agents.toml)
  if (existsSync(skillsDir)) {
    const adoptedLockEntries: Record<string, { source: string; integrity: string }> = {};
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (declaredNames.has(entry.name)) continue;

      const sourcePrefix = scope.scope === "user" ? "path:skills/" : "path:.agents/skills/";
      const source = `${sourcePrefix}${entry.name}`;
      await addSkillToConfig(configPath, entry.name, { source });
      declaredNames.add(entry.name);

      const integrity = await hashDirectory(join(skillsDir, entry.name));
      adoptedLockEntries[entry.name] = { source, integrity };
      adopted.push(entry.name);
    }

    if (adopted.length > 0) {
      await writeLockfile(lockPath, {
        version: 1,
        skills: { ...lockfile?.skills, ...adoptedLockEntries },
      });
      config = await loadConfig(configPath);
    }
  }

  // 2. Regenerate .agents/.gitignore (skip for user scope)
  let gitignoreUpdated = false;
  if (scope.scope === "project") {
    // Use lockfile for concrete names when available (wildcard entries expand there),
    // fall back to explicit config entries when no lockfile exists
    const lockNow = await loadLockfile(lockPath);
    const allNames = lockNow
      ? Object.keys(lockNow.skills)
      : config.skills.filter((s) => !isWildcardDep(s)).map((s) => s.name);
    const managedNames = allNames.filter((name) => {
      const dep = config.skills.find((s) => s.name === name);
      if (!dep || isWildcardDep(dep)) return true; // wildcard-sourced skills are always managed
      return !isInPlaceSkill(dep.source);
    });
    await updateAgentsGitignore(agentsDir, config.gitignore, managedNames);
    gitignoreUpdated = config.gitignore;
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

  // 5. Verify and repair symlinks
  let symlinksRepaired = 0;

  if (scope.scope === "user") {
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const agentId of config.agents) {
      const agent = getAgent(agentId);
      if (!agent?.userSkillsParentDirs) continue;
      for (const dir of agent.userSkillsParentDirs) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        targets.push(dir);
      }
    }

    const symlinkIssues = await verifySymlinks(agentsDir, targets);
    for (const issue of symlinkIssues) {
      await ensureSkillsSymlink(agentsDir, issue.target);
      symlinksRepaired++;
    }
  } else {
    const legacyTargets = config.symlinks?.targets ?? [];
    const legacyIssues = await verifySymlinks(
      agentsDir,
      legacyTargets.map((t) => join(scope.root, t)),
    );
    for (const issue of legacyIssues) {
      await ensureSkillsSymlink(agentsDir, join(scope.root, issue.target));
      symlinksRepaired++;
    }

    const seenParentDirs = new Set(legacyTargets);
    const agentTargets: string[] = [];
    for (const agentId of config.agents) {
      const agent = getAgent(agentId);
      if (!agent?.skillsParentDir) continue;
      if (seenParentDirs.has(agent.skillsParentDir)) continue;
      seenParentDirs.add(agent.skillsParentDir);
      agentTargets.push(join(scope.root, agent.skillsParentDir));
    }

    const agentSymlinkIssues = await verifySymlinks(agentsDir, agentTargets);
    for (const issue of agentSymlinkIssues) {
      await ensureSkillsSymlink(agentsDir, issue.target);
      symlinksRepaired++;
    }
  }

  // 6. Verify and repair MCP configs
  let mcpRepaired = 0;
  const mcpServers = toMcpDeclarations(config.mcp);
  const mcpResolver = scope.scope === "user" ? userMcpResolver() : projectMcpResolver(scope.root);

  const mcpIssues = await verifyMcpConfigs(config.agents, mcpServers, mcpResolver);
  if (mcpIssues.length > 0) {
    await writeMcpConfigs(config.agents, mcpServers, mcpResolver);
    mcpRepaired = mcpIssues.length;
    for (const issue of mcpIssues) {
      issues.push({
        type: "mcp",
        name: issue.agent,
        message: issue.issue,
      });
    }
  }

  // 7. Verify and repair hook configs (skip for user scope)
  let hooksRepaired = 0;
  if (scope.scope === "project") {
    const hookDecls = toHookDeclarations(config.hooks);
    const hookResolver = projectHookResolver(scope.root);

    const hookIssues = await verifyHookConfigs(config.agents, hookDecls, hookResolver);
    if (hookIssues.length > 0) {
      await writeHookConfigs(config.agents, hookDecls, hookResolver);
      hooksRepaired = hookIssues.length;
      for (const issue of hookIssues) {
        issues.push({
          type: "hooks",
          name: issue.agent,
          message: issue.issue,
        });
      }
    }
  }

  return {
    issues,
    adopted,
    gitignoreUpdated,
    symlinksRepaired,
    mcpRepaired,
    hooksRepaired,
  };
}

export default async function sync(_args: string[], flags?: { user?: boolean }): Promise<void> {
  let scope: ScopeRoot;
  try {
    scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
  } catch (err) {
    if (err instanceof ScopeError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const result = await runSync({ scope });

  if (result.adopted.length > 0) {
    console.log(chalk.green(`Adopted ${result.adopted.length} orphan(s): ${result.adopted.join(", ")}`));
  }

  if (scope.scope === "project") {
    if (result.gitignoreUpdated) {
      console.log(chalk.green("Regenerated .agents/.gitignore"));
    } else {
      console.log(chalk.green("Removed .agents/.gitignore (skills checked into git)"));
    }
  }

  if (result.symlinksRepaired > 0) {
    console.log(chalk.green(`Repaired ${result.symlinksRepaired} symlink(s)`));
  }

  if (result.mcpRepaired > 0) {
    console.log(chalk.green(`Repaired ${result.mcpRepaired} MCP config(s)`));
  }

  if (result.hooksRepaired > 0) {
    console.log(chalk.green(`Repaired ${result.hooksRepaired} hook config(s)`));
  }

  if (result.issues.length === 0) {
    console.log(chalk.green("Everything in sync."));
    return;
  }

  for (const issue of result.issues) {
    switch (issue.type) {
      case "modified":
      case "mcp":
      case "hooks":
        console.log(chalk.yellow(`  warn: ${issue.message}`));
        break;
      case "missing":
        console.log(chalk.red(`  error: ${issue.message}`));
        break;
    }
  }
}
