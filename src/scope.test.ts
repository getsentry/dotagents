import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { resolveScope, isInsideGitRepo, resolveDefaultScope, ScopeError } from "./scope.js";

describe("resolveScope", () => {
  afterEach(() => {
    delete process.env["DOTAGENTS_HOME"];
  });

  it("project scope uses projectRoot", () => {
    const s = resolveScope("project", "/tmp/my-project");
    expect(s.scope).toBe("project");
    expect(s.root).toBe("/tmp/my-project");
    expect(s.agentsDir).toBe("/tmp/my-project/.agents");
    expect(s.configPath).toBe("/tmp/my-project/agents.toml");
    expect(s.lockPath).toBe("/tmp/my-project/agents.lock");
    expect(s.skillsDir).toBe("/tmp/my-project/.agents/skills");
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
    expect(s.skillsDir).toBe("/tmp/fake-home/skills");
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
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
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
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    // No .git directory created
    expect(isInsideGitRepo(tempDir)).toBe(false);
  });
});

describe("resolveDefaultScope", () => {
  let tempDir: string;

  afterEach(() => {
    delete process.env["DOTAGENTS_HOME"];
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns project scope when agents.toml exists", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
    writeFileSync(join(tempDir, "agents.toml"), "");
    const s = resolveDefaultScope(tempDir);
    expect(s.scope).toBe("project");
    expect(s.root).toBe(tempDir);
  });

  it("falls back to user scope when not in a git repo", () => {
    tempDir = mkdtempSync(join(tmpdir(), "scope-test-"));
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
