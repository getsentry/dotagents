import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUpdate, UpdateError } from "./update.js";
import { runInstall } from "./install.js";
import { exec } from "../../utils/exec.js";
import { loadLockfile } from "../../lockfile/loader.js";

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

    await expect(runUpdate({ projectRoot })).rejects.toThrow(UpdateError);
  });

  it("reports no updates when nothing changed", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ projectRoot });

    // Update with no changes to repo — should be up to date
    // Force cache refresh by setting TTL to 0
    const updated = await runUpdate({ projectRoot });
    expect(updated).toHaveLength(0);
  });

  it("detects and applies updates when repo changes", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ projectRoot });

    const lockBefore = await loadLockfile(join(projectRoot, "agents.lock"));
    const commitBefore = (lockBefore!.skills["pdf"] as { commit: string }).commit;

    // Make a change in the repo
    await writeFile(join(repoDir, "pdf", "extra.md"), "new content");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update pdf"], { cwd: repoDir });

    // Delete cache to force re-clone (simulating TTL expiry)
    await rm(stateDir, { recursive: true, force: true });

    const updated = await runUpdate({ projectRoot });
    expect(updated).toHaveLength(1);
    expect(updated[0]!.name).toBe("pdf");

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
    await runInstall({ projectRoot });

    // Change repo
    await writeFile(join(repoDir, "pdf", "extra.md"), "changed");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update"], { cwd: repoDir });

    await rm(stateDir, { recursive: true, force: true });

    // Update only pdf
    const updated = await runUpdate({ projectRoot, skillName: "pdf" });
    // Both changed since they come from the same repo and re-resolved
    expect(updated.some((u) => u.name === "pdf")).toBe(true);
  });

  it("excludes in-place skills from gitignore after update", async () => {
    // Install a regular git skill
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    await runInstall({ projectRoot });

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

    await runUpdate({ projectRoot });

    const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
    expect(gitignore).toContain("/skills/pdf/");
    expect(gitignore).not.toContain("/skills/local-skill/");
  });
});
