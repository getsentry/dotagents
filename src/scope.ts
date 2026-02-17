import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Walk up from `dir` looking for a `.git` directory. */
export function isInsideGitRepo(dir: string): boolean {
  let current = resolve(dir);
  const root = dirname(current) === current ? current : undefined;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current || parent === root) return false;
    current = parent;
  }
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Resolve scope when the user did NOT pass `--user`.
 *
 * - If `agents.toml` exists at `projectRoot` → project scope.
 * - If we're not inside a git repo → user scope (with a notice).
 * - Otherwise (in a repo, no agents.toml) → throw with a helpful message.
 */
export function resolveDefaultScope(projectRoot: string): ScopeRoot {
  if (existsSync(join(projectRoot, "agents.toml"))) {
    return resolveScope("project", projectRoot);
  }

  if (!isInsideGitRepo(projectRoot)) {
    console.error("No project found, using user scope (~/.agents/)");
    return resolveScope("user");
  }

  throw new ScopeError(
    "No agents.toml found. Run 'dotagents init' to set up this project, or use --user for user scope.",
  );
}
