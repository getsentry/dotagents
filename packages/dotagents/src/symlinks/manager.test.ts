import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  symlink,
  writeFile,
  lstat,
  readFile,
  readlink,
  readdir,
  realpath,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSkillsSymlink, verifySymlinks } from "./manager.js";
import * as dotagentsLib from "@sentry/dotagents-lib";

describe("symlinks", () => {
  let dir: string;
  let agentsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
    agentsDir = join(dir, ".agents");
    await mkdir(join(agentsDir, "skills"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

    it("does not replace canonical skills when the target aliases the agents directory", async () => {
      const targetDir = join(dir, "agents-alias");
      const skillDir = join(agentsDir, "skills", "keep-me");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "keep me");
      await symlink(agentsDir, targetDir, process.platform === "win32" ? "junction" : "dir");

      const result = await ensureSkillsSymlink(agentsDir, targetDir);

      expect(result).toEqual({ created: false, migrated: [] });
      expect((await lstat(join(agentsDir, "skills"))).isDirectory()).toBe(true);
      expect(await readFile(join(skillDir, "SKILL.md"), "utf-8")).toBe("keep me");
    });

    it("creates a valid link when the target home is a deeper symlink alias", async () => {
      const physicalTargetDir = join(dir, "copilot-home");
      const targetDir = join(dir, "deep", "nested", "copilot-alias");
      await mkdir(physicalTargetDir, { recursive: true });
      await mkdir(join(dir, "deep", "nested"), { recursive: true });
      await symlink(
        physicalTargetDir,
        targetDir,
        process.platform === "win32" ? "junction" : "dir",
      );

      const result = await ensureSkillsSymlink(agentsDir, targetDir);

      expect(result).toEqual({ created: true, migrated: [] });
      expect(await realpath(join(targetDir, "skills"))).toBe(
        await realpath(join(agentsDir, "skills")),
      );
      expect(await verifySymlinks(agentsDir, [targetDir])).toEqual([]);
    });

    it("rejects a Copilot home that aliases the canonical skills target", async () => {
      const externalSkills = join(dir, "external-skills");
      const canonicalSkills = join(agentsDir, "skills");
      await rm(canonicalSkills, { recursive: true });
      await mkdir(externalSkills, { recursive: true });
      await symlink(
        externalSkills,
        canonicalSkills,
        process.platform === "win32" ? "junction" : "dir",
      );

      await expect(ensureSkillsSymlink(agentsDir, externalSkills)).rejects.toThrow(
        "paths overlap",
      );

      expect((await lstat(canonicalSkills)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(externalSkills, "skills"))).toBe(false);
    });

    it.each(["source-inside-link", "link-inside-source"] as const)(
      "rejects overlapping skills paths before changing state: %s",
      async (layout) => {
        const copilotHome = join(dir, "copilot-home");
        const nestedAgentsDir = layout === "source-inside-link"
          ? join(copilotHome, "skills")
          : agentsDir;
        const targetDir = layout === "source-inside-link"
          ? copilotHome
          : join(agentsDir, "skills");
        const sourceSkills = join(nestedAgentsDir, "skills");
        await mkdir(join(sourceSkills, "keep-me"), { recursive: true });
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(nestedAgentsDir, "agents.toml"), "keep config");
        await writeFile(join(sourceSkills, "keep-me", "SKILL.md"), "keep skill");

        await expect(ensureSkillsSymlink(nestedAgentsDir, targetDir)).rejects.toThrow(
          "paths overlap",
        );

        expect(await readFile(join(nestedAgentsDir, "agents.toml"), "utf-8")).toBe("keep config");
        expect(await readFile(join(sourceSkills, "keep-me", "SKILL.md"), "utf-8")).toBe("keep skill");
        expect((await lstat(sourceSkills)).isDirectory()).toBe(true);
      },
    );

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

    it("fails before moving or deleting skills when migration names conflict", async () => {
      const targetDir = join(dir, ".copilot");
      const nativeSkills = join(targetDir, "skills");
      const canonicalSkills = join(agentsDir, "skills");
      await mkdir(join(nativeSkills, "unique"), { recursive: true });
      await mkdir(join(nativeSkills, "shared"), { recursive: true });
      await mkdir(join(canonicalSkills, "shared"), { recursive: true });
      await writeFile(join(nativeSkills, "unique", "SKILL.md"), "native unique");
      await writeFile(join(nativeSkills, "shared", "SKILL.md"), "native shared");
      await writeFile(join(canonicalSkills, "shared", "SKILL.md"), "canonical shared");

      await expect(ensureSkillsSymlink(agentsDir, targetDir)).rejects.toThrow(
        "these entries already exist",
      );

      expect((await lstat(nativeSkills)).isDirectory()).toBe(true);
      expect(await readFile(join(nativeSkills, "unique", "SKILL.md"), "utf-8")).toBe("native unique");
      expect(await readFile(join(nativeSkills, "shared", "SKILL.md"), "utf-8")).toBe("native shared");
      expect(await readFile(join(canonicalSkills, "shared", "SKILL.md"), "utf-8")).toBe("canonical shared");
      expect(existsSync(join(canonicalSkills, "unique"))).toBe(false);
    });

    it("preserves a native skill added while migration is finishing", async () => {
      const targetDir = join(dir, ".copilot");
      const nativeSkills = join(targetDir, "skills");
      const canonicalSkills = join(agentsDir, "skills");
      await mkdir(join(nativeSkills, "initial"), { recursive: true });
      await writeFile(join(nativeSkills, "initial", "SKILL.md"), "initial");

      let releaseGit!: () => void;
      let markGitStarted!: () => void;
      const gitBlocked = new Promise<void>((resolve) => {releaseGit = resolve;});
      const gitStarted = new Promise<void>((resolve) => {markGitStarted = resolve;});
      vi.spyOn(dotagentsLib, "exec").mockImplementation(async () => {
        markGitStarted();
        await gitBlocked;
        return { stdout: "", stderr: "" };
      });

      const migration = ensureSkillsSymlink(agentsDir, targetDir);
      await gitStarted;
      await mkdir(join(nativeSkills, "late"), { recursive: true });
      await writeFile(join(nativeSkills, "late", "SKILL.md"), "late");
      releaseGit();

      await expect(migration).rejects.toMatchObject({ code: "ENOTEMPTY" });
      expect((await lstat(nativeSkills)).isDirectory()).toBe(true);
      expect(await readFile(join(nativeSkills, "late", "SKILL.md"), "utf-8")).toBe("late");
      expect(await readFile(join(canonicalSkills, "initial", "SKILL.md"), "utf-8")).toBe("initial");
      expect(existsSync(join(canonicalSkills, "late"))).toBe(false);
    });

    it("removes migrated files from git index", async () => {
      // Initialize a git repo in the temp dir
      await dotagentsLib.exec("git", ["init"], { cwd: dir });
      await dotagentsLib.exec("git", ["config", "user.email", "test@test.com"], {
        cwd: dir,
      });
      await dotagentsLib.exec("git", ["config", "user.name", "Test"], { cwd: dir });
      await dotagentsLib.exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

      // Create a real skills directory with a committed file
      const targetDir = join(dir, ".claude");
      const realSkillsDir = join(targetDir, "skills");
      await mkdir(join(realSkillsDir, "my-skill"), { recursive: true });
      await writeFile(
        join(realSkillsDir, "my-skill", "SKILL.md"),
        "---\nname: test\n---\n",
      );

      await dotagentsLib.exec("git", ["add", "."], { cwd: dir });
      await dotagentsLib.exec("git", ["commit", "-m", "initial"], { cwd: dir });

      // Verify file is tracked before migration
      const { stdout: before } = await dotagentsLib.exec(
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
      const { stdout: after } = await dotagentsLib.exec(
        "git",
        ["ls-files", ".claude/skills/"],
        { cwd: dir },
      );
      expect(after.trim()).toBe("");

      // Verify the skill was moved to .agents/skills/
      const agentsEntries = await readdir(join(agentsDir, "skills"));
      expect(agentsEntries).toContain("my-skill");
    }, 30_000);
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
