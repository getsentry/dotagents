import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSkillLinks, moveEntry } from "./per-skill.js";

async function skill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

async function crossDevice(): Promise<void> {
  throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
}

describe("per-skill moves", () => {
  let root: string;
  let agentsDir: string;
  let claudeDir: string;
  let shared: string;
  let local: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-per-skill-move-"));
    agentsDir = join(root, ".agents");
    claudeDir = join(root, ".claude");
    shared = join(agentsDir, "skills");
    local = join(claudeDir, "skills");
    await skill(shared, "review");
    await skill(join(shared, "synced", "account"), "pdf");
    await mkdir(claudeDir, { recursive: true });
    await symlink(shared, local);
  });

  afterEach(async () => {
    await chmod(shared, 0o755);
    await rm(root, { recursive: true, force: true });
  });

  it("stops without moving anything when rename fails with EXDEV", async () => {
    await expect(moveEntry(join(shared, "synced"), join(root, "moved"), crossDevice)).rejects.toThrow(/different file systems/);

    expect(existsSync(join(shared, "synced", "account", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "moved"))).toBe(false);
  });

  it("finishes a conversion that stopped before the new directory took the link's place", async () => {
    const staging = join(claudeDir, ".skills.dotagents-staging");
    await mkdir(staging);
    await rename(join(shared, "synced"), join(staging, "synced"));

    const result = await ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set() });

    expect(result.convertedDirectoryLink).toBe(true);
    expect((await lstat(local)).isDirectory()).toBe(true);
    expect(existsSync(join(local, "synced", "account", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(local, "review", "SKILL.md"))).toBe(true);
    expect(existsSync(staging)).toBe(false);
  });

  it("puts the new directory in place when the link was already removed", async () => {
    const staging = join(claudeDir, ".skills.dotagents-staging");
    await mkdir(staging);
    await rename(join(shared, "synced"), join(staging, "synced"));
    await rm(local);

    await ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set() });

    expect(existsSync(join(local, "synced", "account", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(local, "review", "SKILL.md"))).toBe(true);
  });

  it("keeps a synced link whose target is unavailable", async () => {
    await rm(local);
    await mkdir(local);
    await symlink(join(root, "unmounted", "synced"), join(local, "synced"));

    const result = await ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set() });

    expect(await readlink(join(local, "synced"))).toBe(join(root, "unmounted", "synced"));
    expect(result.setAside.map((entry) => entry.name)).toEqual(["synced"]);
  });

  it("keeps the directory link when the conversion fails", async () => {
    // Moving synced/ out of a read-only shared directory fails after the link was removed.
    await chmod(shared, 0o555);

    await expect(ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set() })).rejects.toThrow();

    expect((await lstat(local)).isSymbolicLink()).toBe(true);
    expect(await readlink(local)).toBe(shared);
    expect(existsSync(join(local, "synced", "account", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(local, "review", "SKILL.md"))).toBe(true);
  });
});
