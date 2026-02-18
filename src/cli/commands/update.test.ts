import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUpdate, UpdateError } from "./update.js";
import { runInstall } from "./install.js";
import { exec } from "../../utils/exec.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { resolveScope } from "../../scope.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runUpdate", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-update-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });

    // Create a local git repo
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("throws when no lockfile exists", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    await expect(runUpdate({ scope: resolveScope("project", projectRoot) })).rejects.toThrow(UpdateError);
  });

  it("reports no updates when nothing changed", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    // Update with no changes to repo — should be up to date
    const result = await runUpdate({ scope: resolveScope("project", projectRoot) });
    expect(result.updated).toHaveLength(0);
  });

  it("detects and applies updates when repo changes", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    const lockBefore = await loadLockfile(join(projectRoot, "agents.lock"));
    const commitBefore = (lockBefore!.skills["pdf"] as { commit: string }).commit;

    // Make a change in the repo
    await writeFile(join(repoDir, "pdf", "extra.md"), "new content");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update pdf"], { cwd: repoDir });

    // Delete cache to force re-clone (simulating TTL expiry)
    await rm(stateDir, { recursive: true, force: true });

    const result = await runUpdate({ scope: resolveScope("project", projectRoot) });
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]!.name).toBe("pdf");

    // Lockfile should have new commit
    const lockAfter = await loadLockfile(join(projectRoot, "agents.lock"));
    const commitAfter = (lockAfter!.skills["pdf"] as { commit: string }).commit;
    expect(commitAfter).not.toBe(commitBefore);
  });

  it("updates only the specified skill", async () => {
    // Add two skills
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add review"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    // Change repo
    await writeFile(join(repoDir, "pdf", "extra.md"), "changed");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update"], { cwd: repoDir });

    await rm(stateDir, { recursive: true, force: true });

    // Update only pdf
    const result = await runUpdate({ scope: resolveScope("project", projectRoot), skillName: "pdf" });
    // Both changed since they come from the same repo and re-resolved
    expect(result.updated.some((u) => u.name === "pdf")).toBe(true);
  });

  it("excludes in-place skills from gitignore after update", async () => {
    // Install a regular git skill
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    // Simulate an adopted orphan alongside the git skill
    const inPlaceDir = join(projectRoot, ".agents", "skills", "local-skill");
    await mkdir(inPlaceDir, { recursive: true });
    await writeFile(join(inPlaceDir, "SKILL.md"), SKILL_MD("local-skill"));

    // Add in-place skill to config
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "local-skill"\nsource = "path:.agents/skills/local-skill"\n`,
    );

    // Make a change in the repo so update has something to do
    await writeFile(join(repoDir, "pdf", "extra.md"), "changed");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "change pdf"], { cwd: repoDir });
    await rm(stateDir, { recursive: true, force: true });

    await runUpdate({ scope: resolveScope("project", projectRoot) });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/skills/pdf/");
    expect(gitignore).not.toContain("/skills/local-skill/");
  });

  it("detects new skills added upstream for wildcard source", async () => {
    // Install with wildcard (pdf + review exist)
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    // Add a new skill to the repo
    await mkdir(join(repoDir, "new-skill"), { recursive: true });
    await writeFile(join(repoDir, "new-skill", "SKILL.md"), SKILL_MD("new-skill"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add new-skill"], { cwd: repoDir });

    // Delete cache to force re-clone
    await rm(stateDir, { recursive: true, force: true });

    const result = await runUpdate({ scope: resolveScope("project", projectRoot) });
    // new-skill should appear as a new entry
    expect(result.updated.some((u) => u.name === "new-skill")).toBe(true);

    // Verify it's in the lockfile
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["new-skill"]).toBeDefined();
  });

  it("removes skills deleted upstream for wildcard source", async () => {
    // Add a second skill, install with wildcard
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add review"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    // Verify both are in lockfile
    let lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["pdf"]).toBeDefined();
    expect(lockfile!.skills["review"]).toBeDefined();

    // Remove "review" from the repo
    await rm(join(repoDir, "skills", "review"), { recursive: true });
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "remove review"], { cwd: repoDir });

    await rm(stateDir, { recursive: true, force: true });

    await runUpdate({ scope: resolveScope("project", projectRoot) });

    // "review" should be removed from lockfile
    lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["review"]).toBeUndefined();
    expect(lockfile!.skills["pdf"]).toBeDefined();

    // Directory should be cleaned up
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(projectRoot, ".agents", "skills", "review"))).toBe(false);
  });

  it("updates wildcard source group when targeting a specific wildcard-sourced skill", async () => {
    // Install with wildcard
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add review"], { cwd: repoDir });

    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ scope: resolveScope("project", projectRoot) });

    // Make a change to the repo
    await writeFile(join(repoDir, "pdf", "extra.md"), "updated");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update"], { cwd: repoDir });

    await rm(stateDir, { recursive: true, force: true });

    // Update targeting "pdf" specifically — should update the entire wildcard group
    const result = await runUpdate({
      scope: resolveScope("project", projectRoot),
      skillName: "pdf",
    });

    // Both pdf and review should be updated (same commit for the group)
    expect(result.updated.some((u) => u.name === "pdf")).toBe(true);
    expect(result.updated.some((u) => u.name === "review")).toBe(true);
  });
});
