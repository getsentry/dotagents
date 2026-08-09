import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseTOML } from "smol-toml";
import { parseArgs } from "node:util";
import chalk from "chalk";
import { filterManagedPluginSkillNames } from "../../gitignore/skills.js";
import { checkRootGitignoreEntries, ensureRootGitignoreEntries, writeAgentsGitignore } from "../../gitignore/writer.js";
import { loadConfig } from "../../config/loader.js";
import { isWildcardDep } from "../../config/schema.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { verifySymlinks } from "../../symlinks/manager.js";
import { skillSymlinkTargets } from "../../targets/skill-symlinks.js";
import { resolveScope, resolveDefaultScope, ScopeError, type ScopeRoot } from "../../scope.js";
import { exec } from "@sentry/dotagents-lib";
import { isInPlaceSkill } from "../../utils/fs.js";
import { isInPlacePluginSource, isSameProjectPluginConfig, loadInstalledPlugins } from "../../plugins/store.js";
import { projectedPiSkillNames } from "../../plugins/runtime/writer.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  fix?: () => Promise<void>;
}

export interface DoctorOptions {
  scope: ScopeRoot;
  fix?: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  fixed: number;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const { scope, fix } = opts;
  const checks: DoctorCheck[] = [];
  let fixed = 0;

  // 1. Check agents.toml exists
  if (!existsSync(scope.configPath)) {
    checks.push({
      name: "agents.toml",
      status: "error",
      message: "agents.toml not found. Run 'npx @sentry/dotagents init' to create one.",
    });
    return { checks, fixed };
  }

  const config = await loadConfig(scope.configPath);

  // 2. Check for legacy fields in agents.toml (raw TOML parsing)
  const rawConfig = parseTOML(await readFile(scope.configPath, "utf-8")) as Record<string, unknown>;

  if ("pin" in rawConfig) {
    const fixFn = async () => {
      const content = await readFile(scope.configPath, "utf-8");
      const cleaned = content
        .split("\n")
        .filter((line) => !/^\s*pin\s*=/.test(line))
        .join("\n");
      await writeFile(scope.configPath, cleaned, "utf-8");
    };
    checks.push({
      name: "legacy pin field",
      status: "warn",
      message: "agents.toml contains 'pin' which is no longer used in v1. Remove it.",
      fix: fixFn,
    });
  }

  if ("gitignore" in rawConfig) {
    const fixFn = async () => {
      const content = await readFile(scope.configPath, "utf-8");
      const cleaned = content
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return !/^\s*gitignore\s*=/.test(line) && !trimmed.startsWith("# Managed skills are gitignored") && !trimmed.startsWith("# Check skills into git");
        })
        .join("\n");
      await writeFile(scope.configPath, cleaned, "utf-8");
    };
    checks.push({
      name: "legacy gitignore field",
      status: "warn",
      message: "agents.toml contains 'gitignore' which is no longer used in v1. Gitignore is always managed. Remove it.",
      fix: fixFn,
    });
  }

  // 3. Check for legacy fields in agents.lock
  const lockfile = await loadLockfile(scope.lockPath);
  if (lockfile && existsSync(scope.lockPath)) {
    const rawLock = parseTOML(await readFile(scope.lockPath, "utf-8")) as Record<string, unknown>;
    const rawSkills = (rawLock["skills"] ?? {}) as Record<string, Record<string, unknown>>;
    const hasLegacyLockFields = Object.values(rawSkills).some(
      (s) => "commit" in s || "integrity" in s,
    );

    if (hasLegacyLockFields) {
      const fixFn = async () => {
        // Re-write lockfile which will drop unknown fields
        await writeLockfile(scope.lockPath, lockfile);
      };
      checks.push({
        name: "legacy lockfile fields",
        status: "warn",
        message: "agents.lock contains 'commit' or 'integrity' fields from v0. These are no longer used.",
        fix: fixFn,
      });
    }
  }

  // 4. Root .gitignore health check (project scope only)
  if (scope.scope === "project") {
    const missing = await checkRootGitignoreEntries(scope.root);
    if (missing.length > 0) {
      checks.push({
        name: "root .gitignore",
        status: "error",
        message: `Missing from .gitignore: ${missing.join(", ")}. These files should not be committed.`,
        fix: async () => {
          await ensureRootGitignoreEntries(scope.root);
        },
      });
    } else {
      checks.push({ name: "root .gitignore", status: "ok", message: "Root .gitignore is configured correctly." });
    }
  }

  // 5. Check if generated files are tracked by git (project scope only)
  if (scope.scope === "project") {
    const trackedFiles = await findTrackedGeneratedFiles(scope.root);
    if (trackedFiles.length > 0) {
      checks.push({
        name: "tracked generated files",
        status: "warn",
        message: `Generated files checked into git: ${trackedFiles.join(", ")}. Remove them with 'git rm --cached'.`,
        fix: async () => {
          await exec("git", ["rm", "--cached", ...trackedFiles], { cwd: scope.root });
        },
      });
    }
  }

  // 6. .agents/.gitignore exists (project scope only)
  if (scope.scope === "project") {
    if (existsSync(`${scope.agentsDir}/.gitignore`)) {
      checks.push({ name: ".agents/.gitignore", status: "ok", message: ".agents/.gitignore exists." });
    } else {
      const managedNames = getManagedSkillNames(config, lockfile);
      const managedSubagentNames = getManagedSubagentNames(config, lockfile);
      const managedPluginNames = getManagedPluginNames(config, lockfile, scope);
      checks.push({
        name: ".agents/.gitignore",
        status: "warn",
        message: ".agents/.gitignore is missing. Run 'npx @sentry/dotagents install' or 'npx @sentry/dotagents sync' to regenerate.",
        fix: async () => {
          const installedPlugins = await loadInstalledPlugins(
            scope.pluginsDir,
            config.plugins.filter((plugin) => !isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root)),
          );
          await writeAgentsGitignore(
            scope.agentsDir,
            [
              ...managedNames,
              ...await filterManagedPluginSkillNames(
                await projectedPiSkillNames(config.agents, installedPlugins.plugins),
                config,
                scope.skillsDir,
                scope.pluginsDir,
              ),
            ],
            managedSubagentNames,
            managedPluginNames,
          );
        },
      });
    }
  }

  // 7. Skills directory exists
  if (existsSync(scope.skillsDir)) {
    checks.push({ name: "skills directory", status: "ok", message: "Skills directory exists." });
  } else {
    checks.push({
      name: "skills directory",
      status: "warn",
      message: ".agents/skills/ directory is missing. Run 'npx @sentry/dotagents install' to create it.",
    });
  }

  // 8. Declared skills are installed
  const declaredNames = getDeclaredSkillNames(config, lockfile);
  const missingSkills = declaredNames.filter((name) => !existsSync(`${scope.skillsDir}/${name}`));
  if (missingSkills.length > 0) {
    checks.push({
      name: "installed skills",
      status: "error",
      message: `${missingSkills.length} skill(s) not installed: ${missingSkills.join(", ")}. Run 'npx @sentry/dotagents install'.`,
    });
  } else if (declaredNames.length > 0) {
    checks.push({ name: "installed skills", status: "ok", message: `All ${declaredNames.length} declared skill(s) installed.` });
  } else {
    checks.push({ name: "installed skills", status: "ok", message: "No skills declared." });
  }

  // 9. Declared plugins are installed
  const userScopePlugins = scope.scope === "user"
    ? config.plugins.map((plugin) => plugin.name)
    : [];
  const sameProjectPlugins = scope.scope === "project"
    ? config.plugins
      .filter((plugin) => isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
      .map((plugin) => plugin.name)
    : [];
  const missingPlugins = config.plugins
    .filter((plugin) => !sameProjectPlugins.includes(plugin.name))
    .filter((plugin) => !existsSync(`${scope.pluginsDir}/${plugin.name}`))
    .map((plugin) => plugin.name);
  const pluginErrors: string[] = [];
  if (userScopePlugins.length > 0) {
    pluginErrors.push(
      `${userScopePlugins.length} plugin(s) declared in user scope: ${userScopePlugins.join(", ")}. User-scope plugins are not supported yet; declare plugins in a project agents.toml instead.`,
    );
  } else {
    if (sameProjectPlugins.length > 0) {
      pluginErrors.push(
        `${sameProjectPlugins.length} plugin(s) resolve inside this project's .agents/plugins/ tree: ${sameProjectPlugins.join(", ")}. Same-project plugins cannot be installed into the same project; use an external source path or a separate repo.`,
      );
    }
    if (missingPlugins.length > 0) {
      pluginErrors.push(
        `${missingPlugins.length} plugin(s) not installed: ${missingPlugins.join(", ")}. Run 'npx @sentry/dotagents install'.`,
      );
    }
  }
  if (pluginErrors.length > 0) {
    checks.push({
      name: "installed plugins",
      status: "error",
      message: pluginErrors.join(" "),
    });
  } else if (config.plugins.length > 0) {
    checks.push({ name: "installed plugins", status: "ok", message: `All ${config.plugins.length} declared plugin(s) installed.` });
  } else {
    checks.push({ name: "installed plugins", status: "ok", message: "No plugins declared." });
  }

  // 10. Symlinks (project scope only)
  if (scope.scope === "project" && existsSync(scope.agentsDir)) {
    const targets = skillSymlinkTargets(
      scope,
      config.agents,
      config.symlinks?.targets,
    );

    if (targets.length > 0) {
      const issues = await verifySymlinks(scope.agentsDir, targets);
      if (issues.length > 0) {
        checks.push({
          name: "symlinks",
          status: "warn",
          message: `${issues.length} symlink(s) broken or missing. Run 'npx @sentry/dotagents sync' to repair.`,
        });
      } else {
        checks.push({ name: "symlinks", status: "ok", message: "All symlinks intact." });
      }
    }
  }

  // Apply fixes if --fix was passed
  if (fix) {
    for (const check of checks) {
      if (check.status !== "ok" && check.fix) {
        await check.fix();
        check.status = "ok";
        fixed++;
      }
    }
  }

  return { checks, fixed };
}

const GENERATED_FILES = ["agents.lock", ".agents/.gitignore"];

async function findTrackedGeneratedFiles(root: string): Promise<string[]> {
  const tracked: string[] = [];
  for (const file of GENERATED_FILES) {
    try {
      const { stdout } = await exec("git", ["ls-files", file], { cwd: root });
      if (stdout.trim()) {
        tracked.push(file);
      }
    } catch {
      // Not a git repo or git not available — skip
    }
  }
  return tracked;
}

function getDeclaredSkillNames(
  config: Awaited<ReturnType<typeof loadConfig>>,
  lockfile: Awaited<ReturnType<typeof loadLockfile>>,
): string[] {
  const names = new Set(
    config.skills.filter((s) => !isWildcardDep(s)).map((s) => s.name),
  );
  if (lockfile) {
    for (const name of Object.keys(lockfile.skills)) {
      names.add(name);
    }
  }
  return [...names];
}

function getManagedSkillNames(
  config: Awaited<ReturnType<typeof loadConfig>>,
  lockfile: Awaited<ReturnType<typeof loadLockfile>>,
): string[] {
  const allNames = lockfile
    ? Object.keys(lockfile.skills)
    : config.skills.filter((s) => !isWildcardDep(s)).map((s) => s.name);
  return allNames.filter((name) => {
    const dep = config.skills.find((s) => s.name === name);
    if (!dep || isWildcardDep(dep)) {return true;}
    return !isInPlaceSkill(dep.source);
  });
}

function getManagedSubagentNames(
  config: Awaited<ReturnType<typeof loadConfig>>,
  lockfile: Awaited<ReturnType<typeof loadLockfile>>,
): string[] {
  const names = new Set(config.subagents.map((subagent) => subagent.name));
  if (lockfile) {
    for (const name of Object.keys(lockfile.subagents)) {
      names.add(name);
    }
  }
  return [...names];
}

function getManagedPluginNames(
  config: Awaited<ReturnType<typeof loadConfig>>,
  lockfile: Awaited<ReturnType<typeof loadLockfile>>,
  scope: ScopeRoot,
): string[] {
  const names = new Set(
    config.plugins
      .filter((plugin) => !isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
      .map((plugin) => plugin.name),
  );
  const sameProjectPluginNames = new Set(
    config.plugins
      .filter((plugin) => isSameProjectPluginConfig(plugin, scope.pluginsDir, scope.root))
      .map((plugin) => plugin.name),
  );
  if (lockfile) {
    for (const [name, locked] of Object.entries(lockfile.plugins)) {
      if (sameProjectPluginNames.has(name)) {continue;}
      if (!isInPlacePluginSource(locked.source)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

export default async function doctor(args: string[], flags?: { user?: boolean }): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fix: { type: "boolean" },
    },
    strict: true,
  });

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

  const result = await runDoctor({ scope, fix: values["fix"] });

  const hasIssues = result.checks.some((c) => c.status !== "ok");

  for (const check of result.checks) {
    const icon = check.status === "ok" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("!") : chalk.red("✗");
    const msg = check.status === "ok" ? chalk.dim(check.message) : check.message;
    console.log(`  ${icon} ${msg}`);
  }

  const unfixable = result.checks.filter((c) => c.status !== "ok" && !c.fix);

  if (result.fixed > 0) {
    console.log(chalk.green(`\nFixed ${result.fixed} issue(s).`));
    if (unfixable.length > 0) {
      console.log(chalk.yellow(`${unfixable.length} issue(s) require manual action.`));
    }
  } else if (hasIssues && !values["fix"]) {
    const fixable = result.checks.filter((c) => c.status !== "ok" && c.fix).length;
    if (fixable > 0) {
      console.log(chalk.yellow(`\nRun 'npx @sentry/dotagents doctor --fix' to auto-fix ${fixable} issue(s).`));
    }
  } else if (!hasIssues) {
    console.log(chalk.green("\nAll checks passed."));
  }

  if (hasIssues && (!values["fix"] || unfixable.length > 0)) {
    process.exitCode = 1;
  }
}
