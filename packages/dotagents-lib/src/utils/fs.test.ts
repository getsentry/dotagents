import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { copyDir, isOutsideRoot } from "./fs.js";

describe("copyDir", () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), "dotagents-copydir-src-"));
    destDir = join(await mkdtemp(join(tmpdir(), "dotagents-copydir-")), "dest");
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true });
    await rm(destDir, { recursive: true, force: true });
  });

  it("excludes .git but copies other dotfiles", async () => {
    await mkdir(join(srcDir, ".git", "objects"), { recursive: true });
    await writeFile(join(srcDir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(join(srcDir, "SKILL.md"), "# skill");
    await mkdir(join(srcDir, ".github"), { recursive: true });
    await writeFile(join(srcDir, ".github", "README.md"), "# readme");

    await copyDir(srcDir, destDir);

    expect(existsSync(join(destDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(destDir, ".github", "README.md"))).toBe(true);
    expect(existsSync(join(destDir, ".git"))).toBe(false);
  });

  it("can preserve relative symlinks verbatim", async () => {
    await mkdir(join(srcDir, "linked"), { recursive: true });
    await writeFile(join(srcDir, "linked", "file.txt"), "linked");
    await symlink("linked", join(srcDir, "alias"));

    await copyDir(srcDir, destDir, { verbatimSymlinks: true });

    expect(await readlink(join(destDir, "alias"))).toBe("linked");
    expect(existsSync(join(destDir, "alias", "file.txt"))).toBe(true);
  });
});

describe("isOutsideRoot", () => {
  it("accepts Windows paths inside the root", () => {
    expect(isOutsideRoot("C:\\project", "C:\\project\\.agents\\skills\\review", win32)).toBe(false);
    expect(isOutsideRoot("C:\\project", "C:\\project", win32)).toBe(false);
  });

  it("rejects Windows paths outside the root", () => {
    expect(isOutsideRoot("C:\\project", "C:\\other", win32)).toBe(true);
    expect(isOutsideRoot("C:\\project", "C:\\project-evil", win32)).toBe(true);
    expect(isOutsideRoot("C:\\project", "D:\\project\\skills", win32)).toBe(true);
  });

  it("handles POSIX paths", () => {
    expect(isOutsideRoot("/project", "/project/.agents/skills/review", posix)).toBe(false);
    expect(isOutsideRoot("/project", "/project-evil", posix)).toBe(true);
    expect(isOutsideRoot("/project", "/", posix)).toBe(true);
  });
});
