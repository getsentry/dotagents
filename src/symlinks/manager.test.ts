import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  symlink,
  writeFile,
  lstat,
  readlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSkillsSymlink, verifySymlinks } from "./manager.js";
import { exec } from "../utils/exec.js";

describe("symlinks", () => {
  let dir: string;
  let agentsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
    agentsDir = join(dir, ".agents");
    await mkdir(join(agentsDir, "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  describe("ensureSkillsSymlink", () => {
    it("creates symlink when target dir does not exist", async () => {
      const targetDir = join(dir, ".claude");
      const result = await ensureSkillsSymlink(agentsDir, targetDir);

      expect(result.created).toBe(true);
      expect(result.migrated).toEqual([]);

      const stat = await lstat(join(targetDir, "skills"));
      expect(stat.isSymbolicLink()).toBe(true);

      const linkTarget = await readlink(join(targetDir, "skills"));
      expect(linkTarget).toBe("../.agents/skills");
    });

    it("creates symlink when target dir exists but skills/ does not", async () => {
      const targetDir = join(dir, ".claude");
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, "settings.json"), "{}");

      const result = await ensureSkillsSymlink(agentsDir, targetDir);
      expect(result.created).toBe(true);

      // settings.json should still be there
      const entries = await readdir(targetDir);
      expect(entries).toContain("settings.json");
      expect(entries).toContain("skills");
    });

    it("is idempotent when symlink already correct", async () => {
      const targetDir = join(dir, ".claude");
      await ensureSkillsSymlink(agentsDir, targetDir);
      const result = await ensureSkillsSymlink(agentsDir, targetDir);
      expect(result.created).toBe(false);
    });

    it("replaces wrong symlink", async () => {
      const targetDir = join(dir, ".claude");
      await mkdir(targetDir, { recursive: true });

      // Create a wrong symlink
      await symlink("/wrong/target", join(targetDir, "skills"));

      const result = await ensureSkillsSymlink(agentsDir, targetDir);
      expect(result.created).toBe(true);

      const linkTarget = await readlink(join(targetDir, "skills"));
      expect(linkTarget).toBe("../.agents/skills");
    });

    it("migrates existing real directory", async () => {
      const targetDir = join(dir, ".claude");
      const realSkillsDir = join(targetDir, "skills");
      await mkdir(join(realSkillsDir, "my-local-skill"), { recursive: true });
      await writeFile(
        join(realSkillsDir, "my-local-skill", "SKILL.md"),
        "---\nname: test\n---\n",
      );

      const result = await ensureSkillsSymlink(agentsDir, targetDir);
      expect(result.created).toBe(true);
      expect(result.migrated).toContain("my-local-skill");

      // Verify the skill was moved to .agents/skills/
      const agentsEntries = await readdir(join(agentsDir, "skills"));
      expect(agentsEntries).toContain("my-local-skill");

      // Verify symlink is now in place
      const stat = await lstat(join(targetDir, "skills"));
      expect(stat.isSymbolicLink()).toBe(true);
    });

    it("removes migrated files from git index", async () => {
      // Initialize a git repo in the temp dir
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@test.com"], {
        cwd: dir,
      });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });

      // Create a real skills directory with a committed file
      const targetDir = join(dir, ".claude");
      const realSkillsDir = join(targetDir, "skills");
      await mkdir(join(realSkillsDir, "my-skill"), { recursive: true });
      await writeFile(
        join(realSkillsDir, "my-skill", "SKILL.md"),
        "---\nname: test\n---\n",
      );

      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "initial"], { cwd: dir });

      // Verify file is tracked before migration
      const { stdout: before } = await exec(
        "git",
        ["ls-files", ".claude/skills/"],
        { cwd: dir },
      );
      expect(before.trim()).toContain("my-skill/SKILL.md");

      // Run the symlink migration
      const result = await ensureSkillsSymlink(agentsDir, targetDir);
      expect(result.created).toBe(true);
      expect(result.migrated).toContain("my-skill");

      // Verify file is no longer in git index
      const { stdout: after } = await exec(
        "git",
        ["ls-files", ".claude/skills/"],
        { cwd: dir },
      );
      expect(after.trim()).toBe("");

      // Verify the skill was moved to .agents/skills/
      const agentsEntries = await readdir(join(agentsDir, "skills"));
      expect(agentsEntries).toContain("my-skill");
    });
  });

  describe("verifySymlinks", () => {
    it("returns no issues when all symlinks correct", async () => {
      const targetDir = join(dir, ".claude");
      await ensureSkillsSymlink(agentsDir, targetDir);

      const issues = await verifySymlinks(agentsDir, [targetDir]);
      expect(issues).toEqual([]);
    });

    it("reports missing symlink", async () => {
      const targetDir = join(dir, ".claude");
      const issues = await verifySymlinks(agentsDir, [targetDir]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.issue).toContain("does not exist");
    });

    it("reports non-symlink directory", async () => {
      const targetDir = join(dir, ".claude");
      await mkdir(join(targetDir, "skills"), { recursive: true });

      const issues = await verifySymlinks(agentsDir, [targetDir]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.issue).toContain("not a symlink");
    });
  });
});
