import { join } from "node:path";
import { homedir } from "node:os";

export type Scope = "project" | "user";

export interface ScopeRoot {
  scope: Scope;
  /** Project root or ~/.agents */
  root: string;
  /** .agents/ directory (same as root for user scope) */
  agentsDir: string;
  /** agents.toml path */
  configPath: string;
  /** agents.lock path */
  lockPath: string;
  /** skills/ directory */
  skillsDir: string;
}

/**
 * Resolve paths for the given scope.
 *
 * Project scope: paths relative to process.cwd() (or provided projectRoot).
 * User scope: paths rooted at ~/.agents/ (or DOTAGENTS_HOME override for testing).
 */
export function resolveScope(scope: Scope, projectRoot?: string): ScopeRoot {
  if (scope === "user") {
    const home = process.env["DOTAGENTS_HOME"] ?? join(homedir(), ".agents");
    return {
      scope: "user",
      root: home,
      agentsDir: home,
      configPath: join(home, "agents.toml"),
      lockPath: join(home, "agents.lock"),
      skillsDir: join(home, "skills"),
    };
  }

  const root = projectRoot ?? process.cwd();
  const agentsDir = join(root, ".agents");
  return {
    scope: "project",
    root,
    agentsDir,
    configPath: join(root, "agents.toml"),
    lockPath: join(root, "agents.lock"),
    skillsDir: join(agentsDir, "skills"),
  };
}
