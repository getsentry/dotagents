import { resolveScope } from "../../scope.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import init, { runInit, InitError, installPostMergeHook } from "./init.js";
import { loadConfig } from "../../config/loader.js";

vi.mock("./install.js", () => ({
  runInstall: vi.fn().mockResolvedValue({
    installed: [],
    installedPlugins: [],
    pruned: [],
    prunedPlugins: [],
    mcpWarnings: [],
    hookWarnings: [],
    subagentWarnings: [],
    pluginWarnings: [],
  }),
}));

describe("runInit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-init-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("creates a complete default project", async () => {
    await runInit({ scope: resolveScope("project", dir) });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.version).toBe(1);
    expect(config.skills).toHaveLength(1);
    const skill = config.skills[0]!;
    expect(skill.name).toBe("dotagents");
    expect(skill.source).toBe("getsentry/dotagents");
    expect(existsSync(join(dir, ".agents", "skills"))).toBe(true);
    expect(existsSync(join(dir, ".agents", ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("initializes the repository root when run from a subdirectory", async () => {
    await mkdir(join(dir, ".git"));
    const child = join(dir, "packages", "app");
    await mkdir(child, { recursive: true });
    const cwd = process.cwd();

    try {
      process.chdir(child);
      await init(["--agents", "claude"], { scope: resolveScope("project", dir) });
    } finally {
      process.chdir(cwd);
    }

    expect(existsSync(join(dir, "agents.toml"))).toBe(true);
    expect(existsSync(join(child, "agents.toml"))).toBe(false);
  });

  it("omits bootstrap skill when skills: [] is passed", async () => {
    await runInit({ scope: resolveScope("project", dir), skills: [] });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.skills).toEqual([]);
  });

  it("throws InitError if agents.toml exists without --force", async () => {
    await writeFile(join(dir, "agents.toml"), "version = 1\n");

    await expect(runInit({ scope: resolveScope("project", dir) })).rejects.toThrow(InitError);
    await expect(runInit({ scope: resolveScope("project", dir) })).rejects.toThrow(
      "agents.toml already exists",
    );
  });

  it("overwrites agents.toml with --force", async () => {
    await writeFile(join(dir, "agents.toml"), "garbage content");

    await runInit({ scope: resolveScope("project", dir), force: true });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.version).toBe(1);
  });

  it("is idempotent with --force", async () => {
    await runInit({ scope: resolveScope("project", dir) });
    await runInit({ scope: resolveScope("project", dir), force: true });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.version).toBe(1);
    expect(existsSync(join(dir, ".agents", "skills"))).toBe(true);
  });

  it("preserves existing .agents/skills/ contents", async () => {
    await mkdir(join(dir, ".agents", "skills", "my-skill"), { recursive: true });
    await writeFile(join(dir, ".agents", "skills", "my-skill", "SKILL.md"), "# test");

    await runInit({ scope: resolveScope("project", dir) });

    const entries = await readdir(join(dir, ".agents", "skills"));
    expect(entries).toContain("my-skill");
  });

  it("writes agents field when --agents is provided", async () => {
    await runInit({ scope: resolveScope("project", dir), agents: ["claude", "cursor"] });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.agents).toEqual(["claude", "cursor"]);
  });

  it("accepts plugin-only Pi and Grok targets", async () => {
    await runInit({ scope: resolveScope("project", dir), agents: ["pi", "grok"] });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.agents).toEqual(["pi", "grok"]);
  });

  it("creates agent-specific symlinks when --agents is provided (cursor shares .claude)", async () => {
    await runInit({ scope: resolveScope("project", dir), agents: ["claude", "cursor"] });

    const claudeStat = await lstat(join(dir, ".claude", "skills"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
    // Cursor shares .claude/skills — no .cursor/skills symlink created
    await expect(lstat(join(dir, ".cursor", "skills"))).rejects.toThrow();
  });

  it("rejects unknown agent IDs", async () => {
    await expect(
      runInit({ scope: resolveScope("project", dir), agents: ["claude", "emacs"] }),
    ).rejects.toThrow(InitError);
    await expect(
      runInit({ scope: resolveScope("project", dir), agents: ["emacs"] }),
    ).rejects.toThrow(/Unknown agent/);
  });

  it("adds agents.lock and .agents/.gitignore to root .gitignore", async () => {
    await runInit({ scope: resolveScope("project", dir) });

    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("agents.lock");
    expect(content).toContain(".agents/.gitignore");
  });

  it("appends to existing root .gitignore", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

    await runInit({ scope: resolveScope("project", dir) });

    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain("agents.lock");
    expect(content).toContain(".agents/.gitignore");
  });

  it("writes trust section when trust option is provided", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      trust: { allow_all: false, github_orgs: ["my-org"], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_orgs).toEqual(["my-org"]);
  });

  it("writes allow_all trust when specified", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      trust: { allow_all: true, github_orgs: [], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.allow_all).toBe(true);
  });

  it("auto-whitelists getsentry/dotagents in restricted trust", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      trust: { allow_all: false, github_orgs: ["my-org"], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_repos).toContain("getsentry/dotagents");
  });

  it("does not duplicate whitelist when getsentry org already trusted", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      trust: { allow_all: false, github_orgs: ["getsentry"], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_repos).not.toContain("getsentry/dotagents");
  });

  it("does not duplicate whitelist when repo already listed", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      trust: {
        allow_all: false,
        github_orgs: [],
        github_repos: ["getsentry/dotagents"],
        git_domains: [],
      },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_repos).toEqual(["getsentry/dotagents"]);
  });

  it("does not whitelist when trust is allow_all", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      trust: { allow_all: true, github_orgs: [], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_repos).toEqual([]);
  });

  it("does not whitelist when skills opt out of bootstrap", async () => {
    await runInit({
      scope: resolveScope("project", dir),
      skills: [],
      trust: { allow_all: false, github_orgs: ["my-org"], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_repos).not.toContain("getsentry/dotagents");
  });

  it("generated config has no pin field", async () => {
    await runInit({ scope: resolveScope("project", dir), skills: [] });

    const raw = await readFile(join(dir, "agents.toml"), "utf-8");
    expect(raw).not.toContain("pin");
  });
});

describe("installPostMergeHook", () => {
  let dir: string;
  let gitDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-hook-test-"));
    gitDir = join(dir, ".git");
    await mkdir(gitDir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("creates post-merge hook with shebang", async () => {
    const result = await installPostMergeHook(gitDir);

    expect(result).toBe("created");
    const content = await readFile(join(gitDir, "hooks", "post-merge"), "utf-8");
    expect(content).toMatch(/^#!\/bin\/sh\n/);
    expect(content).toContain("dotagents --project install");
    expect(content).toContain("dotagents:post-merge");
  });

  it("makes hook executable", async () => {
    await installPostMergeHook(gitDir);

    const stat = await lstat(join(gitDir, "hooks", "post-merge"));
    // Check owner execute bit
    expect(stat.mode & 0o111).toBeTruthy();
  });

  it("appends to existing hook without duplicating shebang", async () => {
    const hooksDir = join(gitDir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, "post-merge"), "#!/bin/sh\necho 'existing'\n");

    const result = await installPostMergeHook(gitDir);

    expect(result).toBe("created");
    const content = await readFile(join(hooksDir, "post-merge"), "utf-8");
    expect(content).toContain("echo 'existing'");
    expect(content).toContain("dotagents --project install");
    // Only one shebang
    expect(content.match(/^#!\/bin\/sh/gm)).toHaveLength(1);
  });

  it("returns 'exists' if marker already present", async () => {
    await installPostMergeHook(gitDir);
    const result = await installPostMergeHook(gitDir);

    expect(result).toBe("exists");
  });

  it("is idempotent — does not duplicate snippet", async () => {
    await installPostMergeHook(gitDir);
    await installPostMergeHook(gitDir);

    const content = await readFile(join(gitDir, "hooks", "post-merge"), "utf-8");
    expect(content.match(/dotagents:post-merge/g)).toHaveLength(1);
  });

  it("includes npx fallback", async () => {
    await installPostMergeHook(gitDir);

    const content = await readFile(join(gitDir, "hooks", "post-merge"), "utf-8");
    expect(content).toContain("npx --yes @sentry/dotagents --project install");
  });
});

describe("init hook migration", () => {
  let dir: string;

  afterEach(async () => {
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("repairs a legacy managed hook even when config already exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-init-migration-"));
    const hookPath = join(dir, ".git", "hooks", "post-merge");
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    await writeFile(join(dir, "agents.toml"), "version = 1\n");
    await writeFile(
      hookPath,
      "#!/bin/sh\necho before\n# dotagents:post-merge\n  dotagents install\n  npx --yes @sentry/dotagents install\n# dotagents:end\necho after\n",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await init([], { scope: resolveScope("project", dir) });

    const hook = await readFile(hookPath, "utf-8");
    expect(hook).toContain("dotagents --project install");
    expect(hook).toMatch(/^#!\/bin\/sh\necho before\n/);
    expect(hook).toMatch(/# dotagents:end\necho after\n$/);
    expect(process.exitCode).toBe(1);
    error.mockRestore();
    log.mockRestore();
  });
});
