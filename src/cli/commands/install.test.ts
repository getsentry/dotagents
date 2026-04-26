import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInstall, InstallError } from "./install.js";
import { exec } from "../../utils/exec.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { resolveScope } from "../../scope.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`;

describe("runInstall", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-install-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Set up project
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await writeFile(join(repoDir, "pdf", "prompt.md"), "Process PDFs");

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("installs a skill from a git source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");

    // Skill directory should exist
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "prompt.md"))).toBe(true);
  });

  it("creates agents.lock after install", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.skills["pdf"]!.source).toBeDefined();
    // resolved_commit is informational, should be present for git skills
    expect("resolved_commit" in lockfile!.skills["pdf"]!).toBe(true);
    expect("integrity" in lockfile!.skills["pdf"]!).toBe(false);
  });

  it("installs multiple skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(2);
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("regenerates .agents/.gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(
      join(projectRoot, ".agents", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("/skills/pdf/");
  });

  it("handles empty skills list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(0);
  });

  it("writes MCP configs even with no skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[mcp]]\nname = "github"\ncommand = "npx"\nargs = ["-y", "@mcp/server-github"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const mcp = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.github).toBeDefined();

    // Agent symlinks should also be created
    const stat = await lstat(join(projectRoot, ".claude", "skills"));
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it("fails with --frozen when no lockfile exists", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runInstall({ scope, frozen: true }),
    ).rejects.toThrow(InstallError);
  });

  it("frozen mode passes when lockfile matches", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install to create lockfile
    await runInstall({ scope });

    // Second install with --frozen
    const result = await runInstall({ scope, frozen: true });
    expect(result.installed).toContain("pdf");
  });

  it("creates agent-specific symlinks (cursor shares .claude)", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude", "cursor"]\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const claudeStat = await lstat(join(projectRoot, ".claude", "skills"));
    expect(claudeStat.isSymbolicLink()).toBe(true);
    // Cursor shares .claude/skills — no .cursor/skills symlink created
    await expect(access(join(projectRoot, ".cursor", "skills"))).rejects.toThrow();
  });

  it("writes MCP configs for declared agents", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[mcp]]\nname = "github"\ncommand = "npx"\nargs = ["-y", "@mcp/server-github"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const mcp = JSON.parse(await readFile(join(projectRoot, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.github).toBeDefined();
    expect(mcp.mcpServers.github.command).toBe("npx");
  });

  it("writes hook configs for declared agents", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ".agents/hooks/block-rm.sh"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.hookWarnings).toHaveLength(0);

    const settings = JSON.parse(await readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: ".agents/hooks/block-rm.sh" }] },
    ]);
  });

  it("returns hook warnings for unsupported agents", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["codex"]\n\n[[hooks]]\nevent = "Stop"\ncommand = "check.sh"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.hookWarnings).toHaveLength(1);
    expect(result.hookWarnings[0]!.agent).toBe("codex");
  });

  it("skips copy for in-place path skill", async () => {
    // Pre-install the skill directory (simulating an adopted orphan)
    const skillDir = join(projectRoot, ".agents", "skills", "local-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("local-skill"));

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "local-skill"\nsource = "path:.agents/skills/local-skill"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("local-skill");

    // Lockfile should have source only
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["local-skill"]).toBeDefined();
    expect(lockfile!.skills["local-skill"]!.source).toBe("path:.agents/skills/local-skill");
  });

  it("excludes in-place skills from gitignore", async () => {
    // Pre-install the in-place skill
    const skillDir = join(projectRoot, ".agents", "skills", "local-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("local-skill"));

    // Also have a sourced skill
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "local-skill"\nsource = "path:.agents/skills/local-skill"\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    // Sourced skill should be gitignored
    expect(gitignore).toContain("/skills/pdf/");
    // In-place skill should NOT be gitignored
    expect(gitignore).not.toContain("/skills/local-skill/");
  });

  it("installs all skills from a wildcard entry", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    // Should discover and install both "pdf" and "review"
    expect(result.installed).toContain("pdf");
    expect(result.installed).toContain("review");
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("wildcard respects exclude list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["review"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");
    expect(result.installed).not.toContain("review");
  });

  it("explicit entry wins over wildcard for same skill", async () => {
    // Explicit "pdf" entry + wildcard from same repo
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    // "pdf" appears once (from explicit), "review" from wildcard
    const pdfCount = result.installed.filter((n) => n === "pdf").length;
    expect(pdfCount).toBe(1);
    expect(result.installed).toContain("review");
  });

  it("wildcard creates lockfile with all discovered skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.skills["review"]).toBeDefined();
  });

  it("frozen mode works with wildcard lockfile", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    // First install to create lockfile
    await runInstall({ scope });

    // Second install with --frozen
    const result = await runInstall({ scope, frozen: true });
    expect(result.installed).toContain("pdf");
    expect(result.installed).toContain("review");
  });

  it("wildcard-expanded skills are gitignored", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/skills/pdf/");
    expect(gitignore).toContain("/skills/review/");
  });

  it("errors on name conflict between two wildcard sources", async () => {
    // Create a second repo that also has a "pdf" skill
    const repoDir2 = join(tmpDir, "repo2");
    await mkdir(repoDir2, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir2 });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir2 });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir2 });
    await mkdir(join(repoDir2, "pdf"), { recursive: true });
    await writeFile(join(repoDir2, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: repoDir2 });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir2 });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir2}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/found in both wildcard sources/);
  });

  it("prunes stale wildcard skills on re-install", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install — gets both "pdf" and "review"
    const first = await runInstall({ scope });
    expect(first.installed).toContain("pdf");
    expect(first.installed).toContain("review");
    expect(first.pruned).toHaveLength(0);

    // Remove "review" from upstream repo
    await exec("git", ["rm", "-rf", "skills/review"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "remove review"], { cwd: repoDir });

    // Re-install — should fetch latest without needing --force or cache bust
    const second = await runInstall({ scope });
    expect(second.installed).toContain("pdf");
    expect(second.installed).not.toContain("review");
    expect(second.pruned).toContain("review");

    // Skill directory should be gone
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
    // pdf should still be intact
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);

    // Lockfile should not contain review
    const lock = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lock!.skills["review"]).toBeUndefined();
    expect(lock!.skills["pdf"]).toBeDefined();
  });

  it("does not prune skills whose source does not match a wildcard", async () => {
    // Create a second repo with a "helper" skill
    const repoDir2 = join(tmpDir, "repo2");
    await mkdir(repoDir2, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir2 });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir2 });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir2 });
    await mkdir(join(repoDir2, "helper"), { recursive: true });
    await writeFile(join(repoDir2, "helper", "SKILL.md"), SKILL_MD("helper"));
    await exec("git", ["add", "."], { cwd: repoDir2 });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir2 });

    // Install explicit "helper" from repo2 + wildcard from repo1
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "helper"\nsource = "git:${repoDir2}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Remove "helper" from agents.toml (keep wildcard only)
    // Also remove "review" from upstream so it gets pruned
    await exec("git", ["rm", "-rf", "skills/review"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "remove review"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const result = await runInstall({ scope });

    // "review" was from the wildcard source and was removed upstream — should be pruned
    expect(result.pruned).toContain("review");
    // "helper" was explicit from a different source — should NOT be pruned
    expect(result.pruned).not.toContain("helper");
    // helper's directory should still exist on disk
    expect(existsSync(join(projectRoot, ".agents", "skills", "helper", "SKILL.md"))).toBe(true);
  });

  it("prunes skills added to wildcard exclude list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install — gets both
    await runInstall({ scope });
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);

    // Add "review" to the exclude list
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["review"]\n`,
    );

    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");
    expect(result.installed).not.toContain("review");
    expect(result.pruned).toContain("review");

    // Directory should be gone
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
  });

  it("does not prune in frozen mode", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install — gets both "pdf" and "review"
    await runInstall({ scope });

    // Add "review" to the exclude list
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["review"]\n`,
    );

    // Frozen install should NOT prune (would create disk/lockfile inconsistency)
    const result = await runInstall({ scope, frozen: true });
    expect(result.pruned).toHaveLength(0);
    // Directory should still exist
    expect(existsSync(join(projectRoot, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("wildcard with all skills excluded installs nothing from that source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\nexclude = ["pdf", "review"]\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toHaveLength(0);
  });

  it("frozen mode fails when skill missing from lockfile", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Add review to config but lockfile still has only pdf
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    await expect(runInstall({ scope, frozen: true })).rejects.toThrow(InstallError);
  });

  it("does not auto-create root .gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Only init creates .gitignore — install should not
    expect(existsSync(join(projectRoot, ".gitignore"))).toBe(false);
  });

  it("picks up upstream skill changes without --force", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);

    // First install
    const first = await runInstall({ scope });
    expect(first.installed).toContain("pdf");

    const original = await readFile(
      join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"),
      "utf-8",
    );

    // Update the skill upstream
    await writeFile(join(repoDir, "pdf", "SKILL.md"), `${SKILL_MD("pdf")}\nupdated content`);
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update pdf skill"], { cwd: repoDir });

    // Re-install — should pick up the change without --force or cache bust
    await runInstall({ scope });

    const updated = await readFile(
      join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"),
      "utf-8",
    );
    expect(updated).toContain("updated content");
    expect(updated).not.toBe(original);
  });

  it("minimum_release_age resolves to an older commit when HEAD is too new", async () => {
    // Create an old commit (backdated) then a new one
    await exec("git", ["rm", "-rf", "pdf", "skills"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "clear"], { cwd: repoDir });

    // Create the old commit with a backdated author date
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "old commit", "--date", "2020-01-01T00:00:00"], {
      cwd: repoDir,
      env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00" },
    });

    const { stdout: oldSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });

    // Create a brand new commit (today)
    await writeFile(join(repoDir, "pdf", "SKILL.md"), `${SKILL_MD("pdf")}\nupdated`);
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "new commit"], { cwd: repoDir });

    const { stdout: newSha } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    expect(oldSha.trim()).not.toBe(newSha.trim());

    // Install with minimum_release_age = 1 — should skip the brand-new commit and use the old one
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["pdf"]!).toBeDefined();
    // Should have resolved to the old commit, not HEAD
    const locked = lockfile!.skills["pdf"]! as { resolved_commit?: string };
    expect(locked.resolved_commit).toBe(oldSha.trim());
  });

  it("minimum_release_age throws when repo is younger than threshold", async () => {
    // All commits in repoDir are recent (created in beforeEach)
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/minimum_release_age/);
  });

  it("minimum_release_age rejects pinned skills that are too new", async () => {
    const { stdout: sha } = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\nref = "${sha.trim()}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/minimum_release_age/);
  });

  it("minimum_release_age_exclude bypasses age gate for matching sources", async () => {
    // All commits are recent, but the source is excluded — should install fine
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\nminimum_release_age_exclude = ["git:${repoDir}"]\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runInstall({ scope });
    expect(result.installed).toContain("pdf");
  });

  it("minimum_release_age_exclude with org pattern bypasses age gate", async () => {
    // Use a GitHub-style source with an org exclude
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nminimum_release_age = 9999\nminimum_release_age_exclude = ["myorg"]\n\n[[skills]]\nname = "pdf"\nsource = "myorg/skills"\n`,
    );

    // This will fail to clone (myorg/skills doesn't exist), but it should fail
    // at clone time, not at the age gate — proving the exclude is working.
    const scope = resolveScope("project", projectRoot);
    await expect(runInstall({ scope })).rejects.toThrow(/clone|resolve/i);
  });
});
