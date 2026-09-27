import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSkillLinks, pruneSkillLinks, unlinkSkill, verifySkillLinks } from "./per-skill.js";

const NO_MANAGED = { managedNames: new Set<string>() };

async function skill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

describe("ensureSkillLinks", () => {
  let root: string;
  let agentsDir: string;
  let claudeDir: string;
  let shared: string;
  let local: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-per-skill-"));
    agentsDir = join(root, ".agents");
    claudeDir = join(root, ".claude");
    shared = join(agentsDir, "skills");
    local = join(claudeDir, "skills");
    await mkdir(shared, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("links each shared skill into a real client directory", async () => {
    await skill(shared, "review");

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.linked).toEqual(["review"]);
    expect((await lstat(local)).isSymbolicLink()).toBe(false);
    expect(await readlink(join(local, "review"))).toBe(join("..", "..", ".agents", "skills", "review"));
    expect(await readFile(join(local, "review", "SKILL.md"), "utf-8")).toContain("name: review");
  });

  it("replaces a whole-directory link and moves client-owned entries back", async () => {
    await skill(shared, "review");
    await skill(join(shared, "synced", "bucket"), "pdf");
    await skill(join(shared, ".trash"), "old");
    await mkdir(claudeDir, { recursive: true });
    await symlink("../.agents/skills", local);

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.convertedDirectoryLink).toBe(true);
    expect(result.linked).toEqual(["review"]);
    expect(existsSync(join(local, "synced", "bucket", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(local, ".trash", "old", "SKILL.md"))).toBe(true);
    expect(existsSync(join(shared, "synced"))).toBe(false);
    expect(existsSync(join(shared, ".trash"))).toBe(false);
  });

  it("moves a skill the client created into the shared directory and links it back", async () => {
    await skill(local, "made-in-claude");
    await skill(join(local, "synced", "bucket"), "pdf");

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.adopted).toEqual(["made-in-claude"]);
    expect(existsSync(join(shared, "made-in-claude", "SKILL.md"))).toBe(true);
    expect((await lstat(join(local, "made-in-claude"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(local, "synced"))).isDirectory()).toBe(true);
    expect(existsSync(join(shared, "synced"))).toBe(false);
  });

  it("leaves both copies alone when a name exists on both sides", async () => {
    await skill(shared, "review");
    await skill(local, "review");

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.conflicts).toEqual(["review"]);
    expect((await lstat(join(local, "review"))).isDirectory()).toBe(true);
  });

  it("removes links to deleted shared skills but keeps links it does not own", async () => {
    await skill(shared, "gone");
    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);
    await rm(join(shared, "gone"), { recursive: true });
    await skill(join(root, "elsewhere"), "mine");
    await symlink(join(root, "elsewhere", "mine"), join(local, "mine"));

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.pruned).toEqual(["gone"]);
    expect(existsSync(join(local, "mine", "SKILL.md"))).toBe(true);
  });

  it("moves client-owned entries back after a run that stopped once the directory link was gone", async () => {
    await skill(shared, "review");
    await skill(join(shared, "synced", "bucket"), "pdf");
    await mkdir(local, { recursive: true });

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.convertedDirectoryLink).toBe(false);
    expect(existsSync(join(local, "synced", "bucket", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(shared, "synced"))).toBe(false);
  });

  it("keeps a user link whose target is temporarily missing", async () => {
    await skill(shared, "review");
    await mkdir(local, { recursive: true });
    await symlink(join(root, "unmounted", "review"), join(local, "review"));

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.conflicts).toEqual(["review"]);
    expect(await readlink(join(local, "review"))).toBe(join(root, "unmounted", "review"));
  });

  it("keeps a client skills link it cannot resolve unless it names the shared directory", async () => {
    await mkdir(claudeDir, { recursive: true });
    await symlink(join(root, "unmounted-skills"), local);

    await expect(ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED)).rejects.toThrow(/cannot be resolved/);
    expect(await readlink(local)).toBe(join(root, "unmounted-skills"));
  });

  it("sets aside a client-owned entry the client already has, out of the shared directory", async () => {
    await skill(join(shared, "synced", "old"), "pdf");
    await skill(join(local, "synced", "new"), "pdf");

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.setAside).toEqual([{ name: "synced", path: expect.stringContaining(join(agentsDir, ".client-owned-backup", "synced-")) }]);
    expect(existsSync(join(shared, "synced"))).toBe(false);
    expect(existsSync(join(local, "synced", "new", "pdf", "SKILL.md"))).toBe(true);
    const backups = await readdir(join(agentsDir, ".client-owned-backup"));
    expect(backups).toHaveLength(1);
    expect(existsSync(join(agentsDir, ".client-owned-backup", backups[0]!, "synced", "old", "pdf", "SKILL.md"))).toBe(true);
  });

  it("reports a broken link to somewhere else as a conflict, not something ensureSkillLinks fixes", async () => {
    await skill(shared, "review");
    await mkdir(local, { recursive: true });
    await symlink(join(root, "unmounted", "review"), join(local, "review"));

    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([
      expect.objectContaining({ name: "review", kind: "conflict" }),
    ]);
    expect((await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED)).conflicts).toEqual(["review"]);
    expect(await readlink(join(local, "review"))).toBe(join(root, "unmounted", "review"));
  });

  it("keeps a user's alias link to a shared skill under another name", async () => {
    await skill(shared, "review");
    await mkdir(local, { recursive: true });
    // Use the physical path, as a user on macOS would get from the shell, so it resolves into shared/.
    const target = join(await realpath(shared), "review");
    await symlink(target, join(local, "alias"));

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.pruned).toEqual([]);
    expect(await readlink(join(local, "alias"))).toBe(target);
    expect(await pruneSkillLinks(agentsDir, claudeDir)).toEqual([]);
    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([]);
  });

  it("reports a file that takes a shared skill's name as a conflict", async () => {
    await skill(shared, "review");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "review"), "notes\n");

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.conflicts).toEqual(["review"]);
    expect(await readFile(join(local, "review"), "utf-8")).toBe("notes\n");
  });

  it("keeps an undeclared skill named synced in the shared directory", async () => {
    await skill(shared, "synced");

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result.conflicts).toEqual(["synced"]);
    expect(existsSync(join(shared, "synced", "SKILL.md"))).toBe(true);
    expect(existsSync(join(local, "synced"))).toBe(false);
    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([
      expect.objectContaining({ name: "synced", kind: "conflict" }),
    ]);
  });

  it("keeps a link to the shared skill written as an absolute path", async () => {
    await skill(shared, "review");
    await mkdir(local, { recursive: true });
    const target = join(await realpath(shared), "review");
    await symlink(target, join(local, "review"));

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result).toMatchObject({ linked: [], conflicts: [] });
    expect(await readlink(join(local, "review"))).toBe(target);
  });

  it("reports a client skill folder with a shared skill's name once", async () => {
    await skill(shared, "review");
    await skill(local, "review");

    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([
      expect.objectContaining({ name: "review", kind: "conflict", issue: expect.stringContaining("both exist") }),
    ]);
  });

  it("moves Claude Code's synced/ back even when a stale lock entry has that name", async () => {
    await skill(join(shared, "synced", "account"), "pdf");

    const result = await ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set(["synced"]) });

    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(local, "synced", "account", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(shared, "synced"))).toBe(false);
  });

  it("reports a skills link to another directory as a conflict", async () => {
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await symlink(join(root, "elsewhere"), local);

    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([
      expect.objectContaining({ name: "skills", kind: "conflict" }),
    ]);
  });

  it("only links when adopt is false", async () => {
    await skill(shared, "review");
    await skill(local, "draft");

    const result = await ensureSkillLinks(agentsDir, claudeDir, { ...NO_MANAGED, adopt: false });

    expect(result.adopted).toEqual([]);
    expect(result.linked).toEqual(["review"]);
    expect((await lstat(join(local, "draft"))).isDirectory()).toBe(true);
    expect(existsSync(join(shared, "draft"))).toBe(false);
  });

  it("leaves a client skill in place when dotagents manages that name", async () => {
    await skill(local, "reused");

    const result = await ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set(["reused"]) });

    expect(result.conflicts).toEqual(["reused"]);
    expect((await lstat(join(local, "reused"))).isDirectory()).toBe(true);
    expect(existsSync(join(shared, "reused"))).toBe(false);
    expect(await verifySkillLinks(agentsDir, claudeDir, { managedNames: new Set(["reused"]) })).toEqual([
      expect.objectContaining({ name: "reused", kind: "conflict", issue: expect.stringContaining("not installed") }),
    ]);
  });

  it("keeps a managed skill named like a client-owned entry in the shared directory", async () => {
    await skill(shared, "synced");

    const result = await ensureSkillLinks(agentsDir, claudeDir, { managedNames: new Set(["synced"]) });

    expect(result.conflicts).toEqual(["synced"]);
    expect(existsSync(join(shared, "synced", "SKILL.md"))).toBe(true);
    expect(existsSync(join(local, "synced"))).toBe(false);
    expect((await verifySkillLinks(agentsDir, claudeDir, { managedNames: new Set(["synced"]) }))[0]).toMatchObject({
      name: "synced",
      kind: "conflict",
    });
  });

  it("leaves other hidden entries in the shared directory alone", async () => {
    await mkdir(join(shared, ".cache"), { recursive: true });
    await mkdir(join(shared, ".dotagents-managed"), { recursive: true });

    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(existsSync(join(shared, ".cache"))).toBe(true);
    expect(existsSync(join(shared, ".dotagents-managed"))).toBe(true);
    expect(existsSync(join(local, ".cache"))).toBe(false);
  });

  it("removes a link whose shared entry lost its SKILL.md", async () => {
    await skill(shared, "review");
    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);
    await rm(join(shared, "review", "SKILL.md"));

    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([
      expect.objectContaining({ name: "review" }),
    ]);
    expect((await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED)).pruned).toEqual(["review"]);
    expect(existsSync(join(local, "review"))).toBe(false);
  });

  it("prunes only stale links into the shared directory", async () => {
    await skill(shared, "keep");
    await skill(shared, "gone");
    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);
    await rm(join(shared, "gone"), { recursive: true });
    await symlink(join(root, "elsewhere"), join(local, "mine"));

    expect(await pruneSkillLinks(agentsDir, claudeDir)).toEqual(["gone"]);
    expect(existsSync(join(local, "keep", "SKILL.md"))).toBe(true);
    expect(await readlink(join(local, "mine"))).toBe(join(root, "elsewhere"));
  });

  it("changes nothing on a second run", async () => {
    await skill(shared, "review");
    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    const result = await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(result).toEqual({ linked: [], adopted: [], pruned: [], conflicts: [], setAside: [], convertedDirectoryLink: false, stranded: [] });
  });

  it("unlinks one skill without touching links it does not own", async () => {
    await skill(shared, "review");
    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);
    await skill(join(root, "elsewhere"), "mine");
    await symlink(join(root, "elsewhere", "mine"), join(local, "mine"));

    expect(await unlinkSkill(agentsDir, claudeDir, "review")).toBe(true);
    expect(await unlinkSkill(agentsDir, claudeDir, "mine")).toBe(false);
    expect(existsSync(join(local, "review"))).toBe(false);
    expect(existsSync(join(local, "mine", "SKILL.md"))).toBe(true);
  });

  it("refuses to replace a skills link that points somewhere else", async () => {
    await mkdir(join(root, "other"), { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await symlink(join(root, "other"), local);

    await expect(ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED)).rejects.toThrow(/not to/);
    expect(await readlink(local)).toBe(join(root, "other"));
  });
});

describe("verifySkillLinks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-per-skill-verify-"));
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a whole-directory link, missing links, and unshared client skills", async () => {
    const agentsDir = join(root, ".agents");
    const claudeDir = join(root, ".claude");
    await skill(join(agentsDir, "skills"), "review");
    await mkdir(claudeDir, { recursive: true });
    await symlink("../.agents/skills", join(claudeDir, "skills"));
    expect((await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED))[0]?.issue).toMatch(/links the whole directory/);

    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);
    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([]);

    await skill(join(claudeDir, "skills"), "local-only");
    await rm(join(claudeDir, "skills", "review"));
    const issues = await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED);
    expect(issues.map((i) => i.name).toSorted()).toEqual(["local-only", "review"]);
  });

  it("accepts links to plugin skills, which are links themselves", async () => {
    const agentsDir = join(root, ".agents");
    const claudeDir = join(root, ".claude");
    await skill(join(agentsDir, "plugins", "tools", "skills"), "review");
    await symlink("../plugins/tools/skills/review", join(agentsDir, "skills", "review"));

    await ensureSkillLinks(agentsDir, claudeDir, NO_MANAGED);

    expect(existsSync(join(claudeDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(await verifySkillLinks(agentsDir, claudeDir, NO_MANAGED)).toEqual([]);
  });
});
