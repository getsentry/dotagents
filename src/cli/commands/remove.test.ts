import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRemove, RemoveError, WildcardSkillRemoveError } from "./remove.js";
import { runInstall } from "./install.js";
import { exec } from "../../utils/exec.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { loadConfig } from "../../config/loader.js";
import { resolveScope } from "../../scope.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runRemove", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-remove-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(join(repoDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("removes an explicit skill entry", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    await runRemove({ scope, skillName: "pdf" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills.find((s) => s.name === "pdf")).toBeUndefined();
    expect(existsSync(join(projectRoot, ".agents", "skills", "pdf"))).toBe(false);

    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile!.skills["pdf"]).toBeUndefined();
  });

  it("throws RemoveError for skill not in config", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    const scope = resolveScope("project", projectRoot);

    await expect(runRemove({ scope, skillName: "nonexistent" })).rejects.toThrow(RemoveError);
  });

  it("throws WildcardSkillRemoveError for wildcard-sourced skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Trying to remove "pdf" which is wildcard-sourced
    await expect(runRemove({ scope, skillName: "pdf" })).rejects.toThrow(WildcardSkillRemoveError);
  });

  it("WildcardSkillRemoveError carries the source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    try {
      await runRemove({ scope, skillName: "pdf" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WildcardSkillRemoveError);
      expect((err as WildcardSkillRemoveError).source).toBe(`git:${repoDir}`);
    }
  });

  it("removes explicit entry even when wildcard exists for same source", async () => {
    // Explicit "pdf" + wildcard from same repo
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );
    const scope = resolveScope("project", projectRoot);
    await runInstall({ scope });

    // Removing "pdf" should remove the explicit entry, not trigger wildcard error
    await runRemove({ scope, skillName: "pdf" });

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills.find((s) => s.name === "pdf")).toBeUndefined();
    // Wildcard entry should still exist
    expect(config.skills.some((s) => s.name === "*")).toBe(true);
  });
});
