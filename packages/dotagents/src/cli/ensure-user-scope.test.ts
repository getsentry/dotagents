import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureUserScopeBootstrapped } from "./ensure-user-scope.js";
import { allAgentIds } from "../agents/registry.js";
import type { ScopeRoot } from "../scope.js";

describe("ensureUserScopeBootstrapped", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-scope-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function userScope(home: string): ScopeRoot {
    return {
      scope: "user",
      root: home,
      agentsDir: home,
      configPath: join(home, "agents.toml"),
      lockPath: join(home, "agents.lock"),
      skillsDir: join(home, "skills"),
    };
  }

  it("creates agents.toml and skills/ when user scope is uninitialized", async () => {
    const scope = userScope(tmpDir);
    await ensureUserScopeBootstrapped(scope);

    expect(existsSync(scope.configPath)).toBe(true);
    expect(existsSync(scope.skillsDir)).toBe(true);

    const content = await readFile(scope.configPath, "utf-8");
    expect(content).toContain("version = 1");

    // Should include all known agents
    for (const id of allAgentIds()) {
      expect(content).toContain(`"${id}"`);
    }
  });

  it("prints a message when bootstrapping", async () => {
    const scope = userScope(tmpDir);
    await ensureUserScopeBootstrapped(scope);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Initialized"),
    );
  });

  it("is a no-op when agents.toml already exists", async () => {
    const scope = userScope(tmpDir);

    // Bootstrap once
    await ensureUserScopeBootstrapped(scope);
    const content = await readFile(scope.configPath, "utf-8");

    // Reset mock to track second call
    vi.mocked(console.error).mockClear();

    // Bootstrap again — should be a no-op
    await ensureUserScopeBootstrapped(scope);
    const contentAfter = await readFile(scope.configPath, "utf-8");

    expect(contentAfter).toBe(content);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is a no-op for project scope", async () => {
    const scope: ScopeRoot = {
      scope: "project",
      root: tmpDir,
      agentsDir: join(tmpDir, ".agents"),
      configPath: join(tmpDir, "agents.toml"),
      lockPath: join(tmpDir, "agents.lock"),
      skillsDir: join(tmpDir, ".agents", "skills"),
    };

    await ensureUserScopeBootstrapped(scope);

    expect(existsSync(scope.configPath)).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });
});
