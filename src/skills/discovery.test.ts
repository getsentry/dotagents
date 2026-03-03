import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkill, discoverAllSkills } from "./discovery.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`;

describe("discoverSkill", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "dotagents-discover-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true });
  });

  it("finds skill at root level (<name>/SKILL.md)", async () => {
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    const result = await discoverSkill(repoDir, "pdf");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("pdf");
    expect(result!.meta.name).toBe("pdf");
  });

  it("finds skill in skills/ directory", async () => {
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    const result = await discoverSkill(repoDir, "review");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("skills/review");
  });

  it("finds skill in .agents/skills/ directory", async () => {
    await mkdir(join(repoDir, ".agents", "skills", "lint"), { recursive: true });
    await writeFile(
      join(repoDir, ".agents", "skills", "lint", "SKILL.md"),
      SKILL_MD("lint"),
    );

    const result = await discoverSkill(repoDir, "lint");
    expect(result).not.toBeNull();
    expect(result!.path).toBe(".agents/skills/lint");
  });

  it("finds skill in .claude/skills/ directory", async () => {
    await mkdir(join(repoDir, ".claude", "skills", "commit"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, ".claude", "skills", "commit", "SKILL.md"),
      SKILL_MD("commit"),
    );

    const result = await discoverSkill(repoDir, "commit");
    expect(result).not.toBeNull();
    expect(result!.path).toBe(".claude/skills/commit");
  });

  it("prefers root-level over skills/ directory", async () => {
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await mkdir(join(repoDir, "skills", "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "pdf", "SKILL.md"),
      SKILL_MD("pdf"),
    );

    const result = await discoverSkill(repoDir, "pdf");
    expect(result!.path).toBe("pdf");
  });

  it("finds skill by frontmatter name when directory name differs", async () => {
    // e.g. vercel/chat has skills/chat/SKILL.md with name: "chat-sdk"
    await mkdir(join(repoDir, "skills", "chat"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "chat", "SKILL.md"),
      SKILL_MD("chat-sdk"),
    );

    const result = await discoverSkill(repoDir, "chat-sdk");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("skills/chat");
    expect(result!.meta.name).toBe("chat-sdk");
  });

  it("prefers directory name match over frontmatter name match", async () => {
    // Direct directory match should win over scanning
    await mkdir(join(repoDir, "skills", "my-skill"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "my-skill", "SKILL.md"),
      SKILL_MD("my-skill"),
    );
    // Another dir with frontmatter name matching but different dir name
    await mkdir(join(repoDir, "skills", "other"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "other", "SKILL.md"),
      SKILL_MD("my-skill"),
    );

    const result = await discoverSkill(repoDir, "my-skill");
    expect(result!.path).toBe("skills/my-skill");
  });

  it("returns null when skill not found", async () => {
    const result = await discoverSkill(repoDir, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("discoverAllSkills", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "dotagents-discover-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true });
  });

  it("discovers skills across multiple directories", async () => {
    // Root-level skill
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    // skills/ skill
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.meta.name).toSorted();
    expect(names).toEqual(["pdf", "review"]);
  });

  it("returns empty array for repo with no skills", async () => {
    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(0);
  });

  it("skips directories without SKILL.md", async () => {
    await mkdir(join(repoDir, "not-a-skill"), { recursive: true });
    await writeFile(join(repoDir, "not-a-skill", "README.md"), "# Not a skill");

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(0);
  });

  it("discovers skills in marketplace format", async () => {
    // .claude-plugin must exist (marker for marketplace repos)
    await mkdir(join(repoDir, ".claude-plugin"), { recursive: true });
    // plugins/<plugin>/skills/<skill>/SKILL.md
    await mkdir(
      join(repoDir, "plugins", "my-plugin", "skills", "find-bugs"),
      { recursive: true },
    );
    await writeFile(
      join(repoDir, "plugins", "my-plugin", "skills", "find-bugs", "SKILL.md"),
      SKILL_MD("find-bugs"),
    );
    await mkdir(
      join(repoDir, "plugins", "my-plugin", "skills", "code-review"),
      { recursive: true },
    );
    await writeFile(
      join(repoDir, "plugins", "my-plugin", "skills", "code-review", "SKILL.md"),
      SKILL_MD("code-review"),
    );

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.meta.name).toSorted();
    expect(names).toEqual(["code-review", "find-bugs"]);
    expect(results.find((r) => r.meta.name === "find-bugs")!.path).toBe(
      "plugins/my-plugin/skills/find-bugs",
    );
  });
});
