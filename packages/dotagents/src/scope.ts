import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { hasErrorCode } from "./utils/type-guards.js";

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
  const agentsDir = resolveProjectPath(root, ".agents");
  return {
    scope: "project",
    root,
    agentsDir,
    configPath: resolveProjectPath(root, "agents.toml"),
    lockPath: resolveProjectPath(root, "agents.lock"),
    skillsDir: resolveProjectPath(root, ".agents/skills"),
    pluginsDir: resolveProjectPath(root, ".agents/plugins"),
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

/** Resolve a path while keeping project-scope reads and writes inside the project. */
export function resolveProjectPath(projectRoot: string, projectPath: string): string {
  const root = resolve(projectRoot);
  const target = resolve(root, projectPath);

  if (isOutside(root, target) || isOutside(physicalPath(root), physicalPath(target))) {
    throw new ScopeError(
      `Project path resolves outside the project root: ${projectPath}`,
    );
  }

  return isAbsolute(projectPath) ? target : join(projectRoot, projectPath);
}

function physicalPath(path: string): string {
  const target = resolve(path);
  let existing = target;

  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (err) {
      if (!hasErrorCode(err, "ENOENT") && !hasErrorCode(err, "ENOTDIR")) {
        throw new ScopeError(`Could not verify project path containment: ${path}`);
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new ScopeError(`Could not verify project path containment: ${path}`);
      }
      existing = parent;
    }
  }

  let physicalExisting: string;
  try {
    physicalExisting = realpathSync(existing);
  } catch {
    throw new ScopeError(
      `Project path resolves outside the project root or through an invalid symlink: ${path}`,
    );
  }
  return resolve(physicalExisting, relative(existing, target));
}

function isOutside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
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
