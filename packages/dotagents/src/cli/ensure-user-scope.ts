import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import chalk from "chalk";
import { generateDefaultConfig } from "../config/writer.js";
import { allAgentIds } from "../targets/registry.js";
import type { ScopeRoot } from "../scope.js";

/**
 * Auto-bootstrap user scope if agents.toml doesn't exist yet.
 *
 * For user scope, the intent is obvious — create ~/.agents/agents.toml
 * with sensible defaults so the user can immediately start adding skills
 * without a separate `dotagents init` step.
 */
export async function ensureUserScopeBootstrapped(scope: ScopeRoot): Promise<void> {
  if (scope.scope !== "user") {return;}
  if (existsSync(scope.configPath)) {return;}

  await mkdir(scope.skillsDir, { recursive: true });
  await writeFile(
    scope.configPath,
    generateDefaultConfig({ agents: allAgentIds() }),
    "utf-8",
  );
  console.error(chalk.dim("Initialized ~/.agents/agents.toml"));
}
