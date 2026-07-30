import { describe, it, expect, afterEach, vi } from "vitest";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import {
  resolveScope,
  isInsideGitRepo,
  findGitDir,
  findGitRoot,
  resolveDefaultScope,
  ScopeError,
} from "./scope.js";

describe("resolveScope", () => {
  afterEach(() => {
    delete process.env["DOTAGENTS_HOME"];
  });

  it("project scope uses projectRoot", () => {
    // Derived paths come from path.join, so build the expectations the same
    // way — hardcoded "/" literals only hold on POSIX.
    const root = "/tmp/my-project";
    const s = resolveScope("project", root);
    expect(s.scope).toBe("project");
    expect(s.root).toBe(root);
    expect(s.agentsDir).toBe(join(root, ".agents"));
    expect(s.configPath).toBe(join(root, "agents.toml"));
    expect(s.lockPath).toBe(join(root, "agents.lock"));
    expect(s.skillsDir).toBe(join(root, ".agents", "skills"));
  });

  it("user scope uses ~/.agents by default", () => {
    const s = resolveScope("user");
    const expected = join(homedir(), ".agents");
    expect(s.scope).toBe("user");
    expect(s.root).toBe(expected);
    expect(s.agentsDir).toBe(expected);
    expect(s.configPath).toBe(join(expected, "agents.toml"));
    expect(s.lockPath).toBe(join(expected, "agents.lock"));
    expect(s.skillsDir).toBe(join(expected, "skills"));
  });

  it("user scope respects DOTAGENTS_HOME override", () => {
    process.env["DOTAGENTS_HOME"] = "/tmp/fake-home";
    const s = resolveScope("user");
    expect(s.root).toBe("/tmp/fake-home");
    expect(s.agentsDir).toBe("/tmp/fake-home");
    expect(s.skillsDir).toBe(join("/tmp/fake-home", "skills"));
  });

  it("user scope: agentsDir equals root (flat layout)", () => {
    process.env["DOTAGENTS_HOME"] = "/tmp/user-agents";
    const s = resolveScope("user");
    expect(s.agentsDir).toBe(s.root);
  });

  it("project scope defaults to cwd when no projectRoot given", () => {
    const s = resolveScope("project");
    expect(s.root).toBe(process.cwd());
  });
});

describe("isInsideGitRepo", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {rmSync(tempDir, { recursive: true, force: true });}
  });

  it("returns true when .git exists in dir", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    mkdirSync(join(tempDir, ".git"));
    expect(isInsideGitRepo(tempDir)).toBe(true);
  });

  it("returns true when .git exists in a parent", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    mkdirSync(join(tempDir, ".git"));
    const child = join(tempDir, "sub", "deep");
    mkdirSync(child, { recursive: true });
    expect(isInsideGitRepo(child)).toBe(true);
  });

  it("returns false when no .git in any parent", () => {
    tempDir = mkNonGitTempDir();
    // No .git directory created
    expect(isInsideGitRepo(tempDir)).toBe(false);
  });
});

describe("findGitDir", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {rmSync(tempDir, { recursive: true, force: true });}
  });

  it("returns .git directory path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    mkdirSync(join(tempDir, ".git"));
    expect(findGitDir(tempDir)).toBe(join(tempDir, ".git"));
  });

  it("resolves .git file (submodule) to real git dir", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    const realGitDir = join(tempDir, "real-git-dir");
    mkdirSync(realGitDir);
    writeFileSync(join(tempDir, ".git"), `gitdir: ${realGitDir}\n`);
    expect(findGitDir(tempDir)).toBe(realGitDir);
  });

  it("resolves worktree .git file to common git dir", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    // Simulate: main-repo/.git/worktrees/my-wt/ with commondir pointing to main .git
    const mainGitDir = join(tempDir, "main-repo", ".git");
    const worktreeGitDir = join(mainGitDir, "worktrees", "my-wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");

    const worktreeDir = join(tempDir, "my-worktree");
    mkdirSync(worktreeDir);
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    expect(findGitDir(worktreeDir)).toBe(mainGitDir);
  });

  it("returns undefined for .git file with invalid gitdir target", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    writeFileSync(join(tempDir, ".git"), "gitdir: /nonexistent/path\n");
    expect(findGitDir(tempDir)).toBeUndefined();
  });

  it("returns undefined when no .git exists", () => {
    tempDir = mkNonGitTempDir();
    expect(findGitDir(tempDir)).toBeUndefined();
  });
});

describe("findGitRoot", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {rmSync(tempDir, { recursive: true, force: true });}
  });

  it("returns the repository root from a nested directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    mkdirSync(join(tempDir, ".git"));
    const child = join(tempDir, "packages", "app");
    mkdirSync(child, { recursive: true });

    expect(findGitRoot(child)).toBe(tempDir);
  });

  it("returns a worktree root with a valid .git file", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    const gitDir = join(tempDir, "git-dir");
    const worktree = join(tempDir, "worktree");
    mkdirSync(gitDir);
    mkdirSync(join(worktree, "nested"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    expect(findGitRoot(join(worktree, "nested"))).toBe(worktree);
  });
});

describe("resolveDefaultScope", () => {
  let tempDir: string;

  afterEach(() => {
    delete process.env["DOTAGENTS_HOME"];
    if (tempDir) {rmSync(tempDir, { recursive: true, force: true });}
  });

  it("returns project scope when agents.toml exists", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    writeFileSync(join(tempDir, "agents.toml"), "");
    const s = resolveDefaultScope(tempDir);
    expect(s.scope).toBe("project");
    expect(s.root).toBe(tempDir);
  });

  it("resolves project scope from a nested repository directory", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    mkdirSync(join(tempDir, ".git"));
    writeFileSync(join(tempDir, "agents.toml"), "");
    const child = join(tempDir, "packages", "app");
    mkdirSync(child, { recursive: true });

    const s = resolveDefaultScope(child);

    expect(s.scope).toBe("project");
    expect(s.root).toBe(tempDir);
  });

  it("falls back to user scope when not in a git repo", () => {
    tempDir = mkNonGitTempDir();
    process.env["DOTAGENTS_HOME"] = join(tempDir, "user-home");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = resolveDefaultScope(tempDir);
    expect(s.scope).toBe("user");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("user scope"));
    spy.mockRestore();
  });

  it("throws ScopeError when in a git repo but no agents.toml", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    mkdirSync(join(tempDir, ".git"));
    expect(() => resolveDefaultScope(tempDir)).toThrow(ScopeError);
    expect(() => resolveDefaultScope(tempDir)).toThrow(/dotagents init/);
  });
});

function mkNonGitTempDir(): string {
  for (const base of tempBases()) {
    const dir = mkdtempSync(join(base, "scope-test-"));
    if (!hasGitParent(dir)) {
      return dir;
    }
    rmSync(dir, { recursive: true, force: true });
  }

  throw new Error("Could not create a temporary directory outside a git repository");
}

function tempBases(): string[] {
  return [tmpdir(), "/var/tmp", "/dev/shm"].filter((base) => existsSync(base));
}

function hasGitParent(dir: string): boolean {
  let current = resolve(dir);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
