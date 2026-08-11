import { existsSync, readFileSync, statSync } from "node:fs";
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
  /** plugins/ directory */
  pluginsDir: string;
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
      pluginsDir: join(home, "plugins"),
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
    pluginsDir: join(agentsDir, "plugins"),
  };
}

/** Walk up from `dir` looking for a `.git` directory. */
export function isInsideGitRepo(dir: string): boolean {
  return findGitRoot(dir) !== undefined;
}

/** Walk up from `dir` and return the directory containing `.git`. */
export function findGitRoot(dir: string): string | undefined {
  let current = resolve(dir);

  while (true) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      if (statSync(gitPath).isDirectory()) {return current;}
      return findGitDir(current) ? current : undefined;
    }
    const parent = dirname(current);
    if (parent === current) {return undefined;}
    current = parent;
  }
}

/** Walk up from `dir` and return the `.git` directory path, or undefined.
 *  Handles worktrees/submodules where `.git` is a file pointing to the real git dir.
 *  For worktrees, resolves to the common git directory (where hooks are shared). */
export function findGitDir(dir: string): string | undefined {
  let current = resolve(dir);
  const root = dirname(current) === current ? current : undefined;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const gitPath = join(current, ".git");
    if (existsSync(gitPath)) {
      // In worktrees/submodules, .git is a file containing "gitdir: <path>"
      if (statSync(gitPath).isFile()) {
        const content = readFileSync(gitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s+(.+)$/);
        if (match?.[1]) {
          const target = resolve(current, match[1]);
          if (!existsSync(target)) {return undefined;}
          return resolveCommonGitDir(target);
        }
        return undefined;
      }
      return gitPath;
    }
    const parent = dirname(current);
    if (parent === current || parent === root) {return undefined;}
    current = parent;
  }
}

/** Resolve the common git directory from a worktree-specific git dir.
 *  Worktree git dirs contain a `commondir` file pointing to the shared .git. */
function resolveCommonGitDir(gitDir: string): string {
  const commondirPath = join(gitDir, "commondir");
  if (existsSync(commondirPath)) {
    const rel = readFileSync(commondirPath, "utf-8").trim();
    const common = resolve(gitDir, rel);
    if (existsSync(common)) {return common;}
  }
  return gitDir;
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/** Resolve explicit project scope without falling back to global state. */
export function resolveProjectScope(
  projectRoot: string,
  options: { requireConfig?: boolean } = {},
): ScopeRoot {
  const root = findGitRoot(projectRoot) ?? resolve(projectRoot);
  if (options.requireConfig !== false && !existsSync(join(root, "agents.toml"))) {
    throw new ScopeError(
      "No agents.toml found. Run 'npx @sentry/dotagents --project init' to set up this project.",
    );
  }
  return resolveScope("project", root);
}
