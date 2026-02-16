import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { runInit, InitError } from "./init.js";
import { loadConfig } from "../../config/loader.js";

describe("runInit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-init-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("creates agents.toml in project root", async () => {
    await runInit({ projectRoot: dir });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.version).toBe(1);
    expect(config.skills).toEqual([]);
  });

  it("creates .agents/skills/ directory", async () => {
    await runInit({ projectRoot: dir });

    const stat = await lstat(join(dir, ".agents", "skills"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("does not create .agents/.gitignore with default config (gitignore = false)", async () => {
    await runInit({ projectRoot: dir });

    expect(existsSync(join(dir, ".agents", ".gitignore"))).toBe(false);
  });

  it("throws InitError if agents.toml exists without --force", async () => {
    await writeFile(join(dir, "agents.toml"), "version = 1\n");

    await expect(runInit({ projectRoot: dir })).rejects.toThrow(InitError);
    await expect(runInit({ projectRoot: dir })).rejects.toThrow(
      "agents.toml already exists",
    );
  });

  it("overwrites agents.toml with --force", async () => {
    await writeFile(join(dir, "agents.toml"), "garbage content");

    await runInit({ projectRoot: dir, force: true });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.version).toBe(1);
  });

  it("is idempotent with --force", async () => {
    await runInit({ projectRoot: dir });
    await runInit({ projectRoot: dir, force: true });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.version).toBe(1);
    expect(existsSync(join(dir, ".agents", "skills"))).toBe(true);
  });

  it("does not create symlinks with default config", async () => {
    await runInit({ projectRoot: dir });

    // Default config has no symlinks configured, so .claude should not exist
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  it("creates all expected files and directories", async () => {
    await runInit({ projectRoot: dir });

    expect(existsSync(join(dir, "agents.toml"))).toBe(true);
    expect(existsSync(join(dir, ".agents"))).toBe(true);
    expect(existsSync(join(dir, ".agents", "skills"))).toBe(true);
    // Default config has gitignore = false, so no .gitignore is created
    expect(existsSync(join(dir, ".agents", ".gitignore"))).toBe(false);
  });

  it("preserves existing .agents/skills/ contents", async () => {
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(dir, ".agents", "skills", "my-skill"), { recursive: true });
    await wf(join(dir, ".agents", "skills", "my-skill", "SKILL.md"), "# test");

    await runInit({ projectRoot: dir });

    const entries = await readdir(join(dir, ".agents", "skills"));
    expect(entries).toContain("my-skill");
  });

  it("writes agents field when --agents is provided", async () => {
    await runInit({ projectRoot: dir, agents: ["claude", "cursor"] });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.agents).toEqual(["claude", "cursor"]);
  });

  it("creates agent-specific symlinks when --agents is provided", async () => {
    await runInit({ projectRoot: dir, agents: ["claude", "cursor"] });

    const claudeStat = await lstat(join(dir, ".claude", "skills"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
    const cursorStat = await lstat(join(dir, ".cursor", "skills"));
    expect(cursorStat.isSymbolicLink()).toBe(true);
  });

  it("rejects unknown agent IDs", async () => {
    await expect(
      runInit({ projectRoot: dir, agents: ["claude", "emacs"] }),
    ).rejects.toThrow(InitError);
    await expect(
      runInit({ projectRoot: dir, agents: ["emacs"] }),
    ).rejects.toThrow(/Unknown agent/);
  });

  it("creates .agents/.gitignore when gitignore option is true", async () => {
    await runInit({ projectRoot: dir, gitignore: true });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.gitignore).toBe(true);
    expect(existsSync(join(dir, ".agents", ".gitignore"))).toBe(true);
  });

  it("writes trust section when trust option is provided", async () => {
    await runInit({
      projectRoot: dir,
      trust: { allow_all: false, github_orgs: ["my-org"], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.github_orgs).toEqual(["my-org"]);
  });

  it("writes allow_all trust when specified", async () => {
    await runInit({
      projectRoot: dir,
      trust: { allow_all: true, github_orgs: [], github_repos: [], git_domains: [] },
    });

    const config = await loadConfig(join(dir, "agents.toml"));
    expect(config.trust?.allow_all).toBe(true);
  });
});
