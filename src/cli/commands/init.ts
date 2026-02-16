import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { generateDefaultConfig } from "../../config/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { ensureSkillsSymlink } from "../../symlinks/manager.js";
import { loadConfig } from "../../config/loader.js";
import { getAgent, allAgentIds, allAgents } from "../../agents/registry.js";
import { parseArgs } from "node:util";
import type { TrustConfig } from "../../config/schema.js";

export interface InitOptions {
  force?: boolean;
  agents?: string[];
  gitignore?: boolean;
  trust?: TrustConfig;
  projectRoot: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const { projectRoot, force, agents, gitignore, trust } = opts;
  const configPath = join(projectRoot, "agents.toml");
  const agentsDir = join(projectRoot, ".agents");
  const skillsDir = join(agentsDir, "skills");

  if (existsSync(configPath) && !force) {
    throw new InitError("agents.toml already exists. Use --force to overwrite.");
  }

  // Validate agent IDs before writing config
  const validIds = allAgentIds();
  if (agents) {
    const unknown = agents.filter((id) => !validIds.includes(id));
    if (unknown.length > 0) {
      throw new InitError(
        `Unknown agent(s): ${unknown.join(", ")}. Valid agents: ${validIds.join(", ")}`,
      );
    }
  }

  await writeFile(configPath, generateDefaultConfig({ agents, gitignore, trust }), "utf-8");
  await mkdir(skillsDir, { recursive: true });

  // Set up gitignore and symlinks based on config
  const config = await loadConfig(configPath);
  await updateAgentsGitignore(agentsDir, config.gitignore, []);
  const targets = config.symlinks?.targets ?? [];
  const symlinkResults: { target: string; created: boolean; migrated: string[] }[] = [];

  for (const target of targets) {
    const targetDir = join(projectRoot, target);
    const result = await ensureSkillsSymlink(agentsDir, targetDir);
    symlinkResults.push({ target, ...result });
  }

  // Create agent-specific symlinks (dedup with legacy targets and across agents)
  const seenParentDirs = new Set(targets);
  for (const agentId of config.agents) {
    const agent = getAgent(agentId);
    if (!agent) continue;
    if (seenParentDirs.has(agent.skillsParentDir)) continue;
    seenParentDirs.add(agent.skillsParentDir);
    const targetDir = join(projectRoot, agent.skillsParentDir);
    const result = await ensureSkillsSymlink(agentsDir, targetDir);
    symlinkResults.push({ target: agent.skillsParentDir, ...result });
  }

  return printSummary(config.gitignore, symlinkResults);
}

function printSummary(
  gitignore: boolean,
  symlinks: { target: string; created: boolean; migrated: string[] }[],
): void {
  console.log(chalk.green("Created agents.toml"));
  console.log(chalk.green("Created .agents/skills/"));
  if (gitignore) {
    console.log(chalk.green("Created .agents/.gitignore"));
  }

  for (const s of symlinks) {
    if (s.created) {
      console.log(chalk.green(`Created symlink: ${s.target}/skills/ → .agents/skills/`));
    }
    if (s.migrated.length > 0) {
      console.log(
        chalk.yellow(
          `Migrated ${s.migrated.length} skill(s) from ${s.target}/skills/ to .agents/skills/`,
        ),
      );
    }
  }

  console.log(
    `\n${chalk.bold("Next steps:")}\n  1. Add skills: dotagents add @anthropics/pdf-processing\n  2. Install: dotagents install`,
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

async function runInteractiveInit(projectRoot: string, force?: boolean): Promise<void> {
  const clack = await import("@clack/prompts");

  function cancelled(): never {
    clack.outro("Setup cancelled.");
    // eslint-disable-next-line no-restricted-syntax
    throw new CancelledError();
  }

  function prompt<T>(result: T | symbol): T {
    if (clack.isCancel(result)) cancelled();
    return result;
  }

  clack.intro(BANNER);

  const selectedAgents = prompt(
    await clack.multiselect({
      message: "Which agents do you use?",
      options: allAgents().map((a) => ({ label: a.displayName, value: a.id })),
      required: false,
    }),
  );

  const gitignore = prompt(
    await clack.confirm({
      message: "Manage a .gitignore inside .agents/?",
      initialValue: false,
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
    projectRoot,
    force,
    agents: selectedAgents.length > 0 ? selectedAgents : undefined,
    gitignore,
    trust,
  });

  clack.outro("You're all set! Run `dotagents add` to install your first skill.");
}

export default async function init(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      agents: { type: "string" },
    },
    strict: true,
  });

  const { resolve } = await import("node:path");
  const projectRoot = resolve(".");

  try {
    // Interactive mode: TTY with no --agents flag
    if (process.stdout.isTTY && values["agents"] === undefined) {
      await runInteractiveInit(projectRoot, values["force"]);
      return;
    }

    const agents = values["agents"]
      ? values["agents"].split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    await runInit({ projectRoot, force: values["force"], agents });
  } catch (err) {
    if (err instanceof CancelledError) return;
    if (err instanceof InitError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
