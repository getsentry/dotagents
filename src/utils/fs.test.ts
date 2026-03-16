import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { copyDir } from "./fs.js";

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
});
