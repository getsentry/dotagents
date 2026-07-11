import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import chalk from "chalk";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { normalizeSource } from "@sentry/dotagents-lib";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { addSkillToConfig } from "../../config/writer.js";
import { writeAgentsGitignore, checkRootGitignoreEntries } from "../../gitignore/writer.js";
import { ensureSkillsSymlink, verifySymlinks } from "../../symlinks/manager.js";
import { skillSymlinkTargets } from "../../targets/skill-symlinks.js";
import { verifyMcpConfigs, writeMcpConfigs, toMcpDeclarations, projectMcpResolver } from "../../targets/mcp-writer.js";
import { verifyHookConfigs, writeHookConfigs, toHookDeclarations, projectHookResolver } from "../../targets/hook-writer.js";
import { pruneSubagentConfigs, verifySubagentConfigs, writeSubagentConfigs, projectSubagentResolver, userSubagentResolver } from "../../subagents/writer.js";
import { loadInstalledSubagents, pruneInstalledSubagents } from "../../subagents/store.js";
import { userMcpResolver } from "../../targets/paths.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { ensureUserScopeBootstrapped } from "../ensure-user-scope.js";
import { isInPlaceSkill, managedSkillPath } from "../../utils/fs.js";

export interface SyncIssue {
  type: "symlink" | "missing" | "mcp" | "hooks" | "subagents";
  name: string;
  message: string;
}

export interface SyncOptions {
  scope: ScopeRoot;
}

export interface SyncResult {
  issues: SyncIssue[];
  adopted: string[];
  pruned: string[];
  gitignoreUpdated: boolean;
  symlinksRepaired: number;
  mcpRepaired: number;
  hooksRepaired: number;
  subagentsRepaired: number;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const { scope } = opts;
  const { configPath, lockPath, agentsDir, skillsDir } = scope;
  const subagentsDir = join(agentsDir, "agents");

  let config = await loadConfig(configPath);
  let lockfile = await loadLockfile(lockPath);
  // Build declared names from explicit entries + wildcard-expanded lockfile entries
  const declaredNames = new Set(
    config.skills.filter((s) => !isWildcardDep(s)).map((s) => s.name),
  );
  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.skills)) {
      const wildcardDep = config.skills.find(
        (s): s is Extract<typeof s, { name: "*" }> =>
          isWildcardDep(s) &&
          normalizeSource(s.source) === normalizeSource(locked.source),
      );
      if (wildcardDep && !wildcardDep.exclude.includes(name)) {
        declaredNames.add(name);
      }
    }
  }
  const issues: SyncIssue[] = [];
  const adopted: string[] = [];
  const pruned: string[] = [];

  // 1. Adopt orphaned skills (installed but not in agents.toml)
  if (existsSync(skillsDir)) {
    const adoptedLockEntries: Record<string, { source: string }> = {};
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      if (declaredNames.has(entry.name)) {continue;}

      const locked = lockfile?.skills[entry.name];
      if (locked && !isInPlaceSkill(locked.source)) {
        const removed = await removeStaleManagedSkill(skillsDir, entry.name);
        if (removed) {
          delete lockfile!.skills[entry.name];
          pruned.push(entry.name);
        }
        continue;
      }

      const sourcePrefix = scope.scope === "user" ? "path:skills/" : "path:.agents/skills/";
      const source = `${sourcePrefix}${entry.name}`;
      await addSkillToConfig(configPath, entry.name, { source });
      declaredNames.add(entry.name);

      adoptedLockEntries[entry.name] = { source };
      adopted.push(entry.name);
    }

    if (adopted.length > 0 || pruned.length > 0) {
      lockfile = {
        version: 1,
        skills: { ...lockfile?.skills, ...adoptedLockEntries },
        subagents: lockfile?.subagents ?? {},
      };
      await writeLockfile(lockPath, lockfile);
    }
    if (adopted.length > 0) {
      config = await loadConfig(configPath);
    }
  }

  const declaredSubagentNames = new Set(config.subagents.map((subagent) => subagent.name));
  if (lockfile && Object.keys(lockfile.subagents).some((name) => !declaredSubagentNames.has(name))) {
    const subagents = Object.fromEntries(
      Object.entries(lockfile.subagents).filter(([name]) => declaredSubagentNames.has(name)),
    );
    lockfile = { ...lockfile, subagents };
    await writeLockfile(lockPath, lockfile);
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
      if (!dep || isWildcardDep(dep)) {return true;} // wildcard-sourced skills are always managed
      return !isInPlaceSkill(dep.source);
    });
    const managedSubagentNames = new Set(config.subagents.map((subagent) => subagent.name));
    if (lockNow) {
      for (const name of Object.keys(lockNow.subagents)) {
        managedSubagentNames.add(name);
      }
    }
    await writeAgentsGitignore(
      agentsDir,
      managedNames,
      [...managedSubagentNames],
    );
    gitignoreUpdated = true;

    // Health check: warn if agents.lock and .agents/.gitignore are not in root .gitignore
    const missing = await checkRootGitignoreEntries(scope.root);
    if (missing.length > 0) {
      console.log(chalk.yellow(`Warning: ${missing.join(", ")} should be in .gitignore. Run 'npx @sentry/dotagents doctor --fix' to fix.`));
    }
  }

  // 3. Check for missing skills (in agents.toml but not installed)
  for (const name of declaredNames) {
    if (!existsSync(join(skillsDir, name))) {
      issues.push({
        type: "missing",
        name,
        message: `"${name}" is in agents.toml but not installed. Run 'npx @sentry/dotagents install'.`,
      });
    }
  }

  // 4. Verify and repair symlinks
  let symlinksRepaired = 0;
  const symlinkTargets = skillSymlinkTargets(
    scope,
    config.agents,
    config.symlinks?.targets,
  );
  const symlinkIssues = await verifySymlinks(agentsDir, symlinkTargets);
  for (const issue of symlinkIssues) {
    await ensureSkillsSymlink(agentsDir, issue.target);
    symlinksRepaired++;
  }

  // 5. Verify and repair MCP configs
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

  // 6. Verify and repair hook configs (skip for user scope)
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

  // 7. Verify and repair custom subagent files
  let subagentsRepaired = 0;
  const installedSubagentResult = await loadInstalledSubagents(subagentsDir, config.subagents);
  const prunedInstalledSubagents = await pruneInstalledSubagents(subagentsDir, config.subagents);
  const subagentDecls = installedSubagentResult.subagents;
  const subagentResolver = scope.scope === "user"
    ? userSubagentResolver()
    : projectSubagentResolver(scope.root);
  const subagentIssues = await verifySubagentConfigs(
    config.agents,
    subagentDecls,
    subagentResolver,
  );

  const subagentResult = await writeSubagentConfigs(
    config.agents,
    subagentDecls,
    subagentResolver,
  );
  const prunedSubagentConfigs = await pruneSubagentConfigs(
    config.agents,
    config.subagents,
    subagentResolver,
  );
  subagentsRepaired = subagentResult.written + prunedSubagentConfigs.length + prunedInstalledSubagents.length;

  for (const issue of installedSubagentResult.issues) {
    issues.push({
      type: "subagents",
      name: issue.name,
      message: issue.issue,
    });
  }
  for (const issue of subagentIssues) {
    issues.push({
      type: "subagents",
      name: issue.name,
      message: issue.issue,
    });
  }
  for (const warning of subagentResult.warnings) {
    const alreadyReported = issues.some(
      (issue) => issue.type === "subagents" && issue.message === warning.message,
    );
    if (!alreadyReported) {
      issues.push({
        type: "subagents",
        name: warning.name,
        message: warning.message,
      });
    }
  }

  return {
    issues,
    adopted,
    pruned,
    gitignoreUpdated,
    symlinksRepaired,
    mcpRepaired,
    hooksRepaired,
    subagentsRepaired,
  };
}

async function removeStaleManagedSkill(skillsDir: string, name: string): Promise<boolean> {
  const skillPath = managedSkillPath(skillsDir, name);
  if (!skillPath) {return false;}
  await rm(skillPath, { recursive: true, force: true });
  return true;
}

export default async function sync(_args: string[], flags?: { user?: boolean }): Promise<void> {
  let scope: ScopeRoot;
  try {
    scope = flags?.user ? resolveScope("user") : resolveDefaultScope(resolve("."));
    await ensureUserScopeBootstrapped(scope);
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

  if (result.pruned.length > 0) {
    console.log(chalk.green(`Pruned ${result.pruned.length} stale managed skill(s): ${result.pruned.join(", ")}`));
  }

  if (scope.scope === "project" && result.gitignoreUpdated) {
    console.log(chalk.green("Regenerated .agents/.gitignore"));
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

  if (result.subagentsRepaired > 0) {
    console.log(chalk.green(`Repaired ${result.subagentsRepaired} subagent config(s)`));
  }

  if (result.issues.length === 0) {
    console.log(chalk.green("Everything in sync."));
    return;
  }

  for (const issue of result.issues) {
    switch (issue.type) {
      case "mcp":
      case "hooks":
      case "subagents":
        console.log(chalk.yellow(`  warn: ${issue.message}`));
        break;
      case "missing":
        console.log(chalk.red(`  error: ${issue.message}`));
        break;
    }
  }
}
