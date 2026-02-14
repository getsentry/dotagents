import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { generateDefaultConfig } from "../../config/writer.js";
import { updateAgentsGitignore } from "../../gitignore/writer.js";
import { ensureSkillsSymlink } from "../../symlinks/manager.js";
import { loadConfig } from "../../config/loader.js";
import { getAgent, allAgentIds } from "../../agents/registry.js";
import { parseArgs } from "node:util";

export interface InitOptions {
  force?: boolean;
  agents?: string[];
  projectRoot: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const { projectRoot, force, agents } = opts;
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

  await writeFile(configPath, generateDefaultConfig(agents), "utf-8");
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
  const agents = values["agents"]
    ? values["agents"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    await runInit({ projectRoot: resolve("."), force: values["force"], agents });
  } catch (err) {
    if (err instanceof InitError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
