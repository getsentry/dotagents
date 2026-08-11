import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import chalk from "chalk";
import { generateDefaultConfig } from "../../config/writer.js";
import { writeAgentsGitignore, ensureRootGitignoreEntries } from "../../gitignore/writer.js";
import { ensureSkillsSymlink } from "../../symlinks/manager.js";
import { loadConfig } from "../../config/loader.js";
import { allAgentIds, allAgents } from "../../targets/registry.js";
import { skillSymlinkTargets } from "../../targets/skill-symlinks.js";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import { findGitDir, type ScopeRoot } from "../../scope.js";
import type { TrustConfig } from "../../config/schema.js";
import { GitError, TrustError } from "@sentry/dotagents-lib";
import { formatGitError, formatTrustError } from "../errors.js";
import { runInstall } from "./install.js";
import { allPluginOnlyAgentIds } from "../../plugins/targets.js";
import { commandPrefix, type CommandContext } from "../context.js";
import {
  installPostMergeHook,
  updateManagedPostMergeHook,
} from "../post-merge-hook.js";

export { installPostMergeHook } from "../post-merge-hook.js";

const BOOTSTRAP_SKILL = { name: "dotagents", source: "getsentry/dotagents" } as const;

export interface InitOptions {
  force?: boolean;
  agents?: string[];
  trust?: TrustConfig;
  skills?: Array<{ name: string; source: string }>;
  scope: ScopeRoot;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const { scope, force, agents } = opts;
  let { trust } = opts;
  const { configPath, agentsDir, skillsDir } = scope;
  const skills = opts.skills ?? [BOOTSTRAP_SKILL];

  if (existsSync(configPath) && !force) {
    throw new InitError("agents.toml already exists. Use --force to overwrite.");
  }

  // Validate agent IDs before writing config
  const validIds = [...allAgentIds(), ...allPluginOnlyAgentIds()];
  if (agents) {
    const unknown = agents.filter((id) => !validIds.includes(id));
    if (unknown.length > 0) {
      throw new InitError(
        `Unknown agent(s): ${unknown.join(", ")}. Valid agents: ${validIds.join(", ")}`,
      );
    }
  }

  // Auto-whitelist bootstrap skill source in restricted trust
  if (trust && !trust.allow_all && skills.some((s) => s.source === "getsentry/dotagents")) {
    const alreadyCovered =
      trust.github_orgs.includes("getsentry") ||
      trust.github_repos.includes("getsentry/dotagents");
    if (!alreadyCovered) {
      trust = { ...trust, github_repos: [...trust.github_repos, "getsentry/dotagents"] };
    }
  }

  await mkdir(agentsDir, { recursive: true });
  await writeFile(configPath, generateDefaultConfig({ agents, trust, skills }), "utf-8");
  await mkdir(skillsDir, { recursive: true });

  // Set up gitignore and symlinks based on config
  const config = await loadConfig(configPath);

  if (scope.scope === "project") {
    await writeAgentsGitignore(agentsDir, []);
    await ensureRootGitignoreEntries(scope.root);
  }

  // Symlinks — create per-agent symlinks so each agent discovers skills
  const symlinkResults: { target: string; created: boolean; migrated: string[] }[] = [];

  const symlinkTargets = skillSymlinkTargets(
    scope,
    config.agents,
    config.symlinks?.targets,
  );
  for (const target of symlinkTargets) {
    const result = await ensureSkillsSymlink(agentsDir, target);
    const displayTarget = scope.scope === "project"
      ? relative(scope.root, target)
      : target;
    symlinkResults.push({ target: displayTarget, ...result });
  }

  // Auto-install declared skills (best-effort — may fail offline)
  if (config.skills.length > 0) {
    try {
      await runInstall({ scope });
    } catch (err) {
      // Re-throw structured errors — TrustError is a policy violation, GitError
      // carries the auth-required SSH hint. Both deserve a hard fail with the
      // formatted message rather than the generic "could not install" copy.
      if (err instanceof TrustError || err instanceof GitError) {throw err;}
      console.log(chalk.yellow(`Could not install skills. Run \`${commandPrefix(scope)} install\` to install them later.`));
    }
  }

  return printSummary(scope, symlinkResults);
}

function printSummary(
  scope: ScopeRoot,
  symlinks: { target: string; created: boolean; migrated: string[] }[],
): void {
  const prefix = scope.scope === "user" ? "~/.agents/" : "";
  console.log(chalk.green(`Created ${prefix}agents.toml`));
  console.log(chalk.green(`Created ${prefix}${scope.scope === "user" ? "" : ".agents/"}skills/`));
  if (scope.scope === "project") {
    console.log(chalk.green("Created .agents/.gitignore"));
  }

  for (const s of symlinks) {
    if (s.created) {
      const label = `${s.target}/skills/`;
      const source = scope.scope === "user" ? "~/.agents/skills/" : ".agents/skills/";
      console.log(chalk.green(`Created symlink: ${label} → ${source}`));
    }
    if (s.migrated.length > 0) {
      console.log(
        chalk.yellow(
          `Migrated ${s.migrated.length} skill(s) from ${s.target}/skills/ to ${scope.scope === "user" ? "~/.agents/" : ".agents/"}skills/`,
        ),
      );
    }
  }

  const cmd = commandPrefix(scope);
  console.log(
    `\n${chalk.bold("Next steps:")}\n  1. Add skills: ${cmd} add getsentry/skills find-bugs\n  2. Install: ${cmd} install`,
  );
}

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

class CancelledError extends Error {}

const BANNER = `
     _       _                         _
  __| | ___ | |_  __ _  __ _  ___ _ __| |_ ___
 / _\` |/ _ \\| __|/ _\` |/ _\` |/ _ \\ '_ \\ __/ __|
| (_| | (_) | |_| (_| | (_| |  __/ | | | |_\\__ \\
 \\__,_|\\___/ \\__|\\__,_|\\__, |\\___|_| |_|\\__|___/
                       |___/
`;

async function runInteractiveInit(scope: ScopeRoot, force?: boolean): Promise<void> {
  function cancelled(): never {
    clack.outro("Setup cancelled.");
    // eslint-disable-next-line no-restricted-syntax
    throw new CancelledError();
  }

  function prompt<T>(result: T | symbol): T {
    if (clack.isCancel(result)) {cancelled();}
    return result;
  }

  clack.intro(BANNER);

  const selectedAgents = prompt(
    await clack.multiselect({
      message: "Which agents do you use? (space to select, enter to confirm)",
      options: [
        ...allAgents().map((a) => ({ label: a.displayName, value: a.id })),
        { label: "Grok Build (plugins)", value: "grok" },
        { label: "Pi (plugin skills)", value: "pi" },
      ],
      required: true,
    }),
  );

  const trustMode = prompt(
    await clack.select({
      message: "Skill source trust policy:",
      options: [
        { label: "Allow all sources", value: "allow_all" as const },
        { label: "Restrict to trusted sources", value: "restricted" as const },
      ],
    }),
  );

  let trust: TrustConfig | undefined;
  if (trustMode === "allow_all") {
    trust = { allow_all: true, github_orgs: [], github_repos: [], git_domains: [] };
  } else {
    const sourcesInput = prompt(
      await clack.text({
        message: "Trusted GitHub sources (comma-separated, or leave blank):",
        placeholder: "e.g. getsentry, getsentry/skills",
        defaultValue: "",
      }),
    );

    const entries = sourcesInput.split(",").map((x) => x.trim()).filter(Boolean);
    const github_orgs = entries.filter((e) => !e.includes("/"));
    const github_repos = entries.filter((e) => e.includes("/"));

    trust = { allow_all: false, github_orgs, github_repos, git_domains: [] };
  }

  await runInit({
    scope,
    force,
    agents: selectedAgents,
    trust,
  });

  const gitDir = scope.scope === "project" ? findGitDir(scope.root) : undefined;

  // Offer git post-merge hook (project scope only)
  if (scope.scope === "project" && gitDir) {
    const setupHook = prompt(
      await clack.confirm({
        message: "Set up a git hook to auto-run `npx @sentry/dotagents --project install` on pull?",
        initialValue: false,
      }),
    );

    if (setupHook) {
      try {
        const result = await installPostMergeHook(gitDir);
        if (result === "created") {
          clack.log.success("Installed post-merge hook.");
        } else if (result === "updated") {
          clack.log.success("Updated managed post-merge hook for project scope.");
        } else {
          clack.log.info("Post-merge hook already configured.");
        }
      } catch {
        clack.log.warn("Could not install post-merge hook. You can set it up manually later.");
      }
    }
  }

  clack.outro(`You're all set! Run \`${commandPrefix(scope)} add\` to add more skills.`);
}

export default async function init(args: string[], context: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      agents: { type: "string" },
    },
    strict: true,
  });

  const { scope } = context;

  try {
    if (scope.scope === "project") {
      const gitDir = findGitDir(scope.root);
      if (gitDir && await updateManagedPostMergeHook(gitDir)) {
        if (process.stdout.isTTY) {
          clack.log.success("Updated managed post-merge hook for project scope.");
        } else {
          console.log(chalk.green("Updated managed post-merge hook for project scope."));
        }
      }
    }

    // Interactive mode: TTY with no --agents flag
    if (process.stdout.isTTY && values["agents"] === undefined) {
      await runInteractiveInit(scope, values["force"]);
      return;
    }

    const agents = values["agents"]
      ? values["agents"].split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    await runInit({ scope, force: values["force"], agents });
  } catch (err) {
    if (err instanceof CancelledError) {return;}
    if (err instanceof TrustError) {
      console.error(chalk.red(formatTrustError(err, context.scope)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof GitError) {
      console.error(chalk.red(formatGitError(err, context.scope)));
      process.exitCode = 1;
      return;
    }
    if (err instanceof InitError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
