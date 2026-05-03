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

  it("finds skill in a caller-supplied scan dir (.agents/skills/)", async () => {
    await mkdir(join(repoDir, ".agents", "skills", "lint"), { recursive: true });
    await writeFile(
      join(repoDir, ".agents", "skills", "lint", "SKILL.md"),
      SKILL_MD("lint"),
    );

    const result = await discoverSkill(repoDir, "lint", {
      scanDirs: [".agents/skills"],
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(".agents/skills/lint");
  });

  it("finds skill in a caller-supplied scan dir (.claude/skills/)", async () => {
    await mkdir(join(repoDir, ".claude", "skills", "commit"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, ".claude", "skills", "commit", "SKILL.md"),
      SKILL_MD("commit"),
    );

    const result = await discoverSkill(repoDir, "commit", {
      scanDirs: [".claude/skills"],
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(".claude/skills/commit");
  });

  it("does not scan .agents/skills/ by default (host convention)", async () => {
    await mkdir(join(repoDir, ".agents", "skills", "lint"), { recursive: true });
    await writeFile(
      join(repoDir, ".agents", "skills", "lint", "SKILL.md"),
      SKILL_MD("lint"),
    );

    const result = await discoverSkill(repoDir, "lint");
    expect(result).toBeNull();
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

  it("prefers higher-priority scan dir frontmatter match over lower-priority dir name match", async () => {
    // Root-level: ./chat/SKILL.md with name: "chat-sdk" (frontmatter match)
    await mkdir(join(repoDir, "chat"), { recursive: true });
    await writeFile(join(repoDir, "chat", "SKILL.md"), SKILL_MD("chat-sdk"));
    // skills/: skills/chat-sdk/SKILL.md (dir name match, but lower priority scan dir)
    await mkdir(join(repoDir, "skills", "chat-sdk"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "chat-sdk", "SKILL.md"),
      SKILL_MD("chat-sdk"),
    );

    const result = await discoverSkill(repoDir, "chat-sdk");
    // The root-level frontmatter match should win over the skills/ dir name match
    expect(result!.path).toBe("chat");
  });

  it("finds skill nested in category subdirectory (e.g. skills/.curated/pdf/)", async () => {
    await mkdir(join(repoDir, "skills", ".curated", "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", ".curated", "pdf", "SKILL.md"),
      SKILL_MD("pdf"),
    );

    const result = await discoverSkill(repoDir, "pdf");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("skills/.curated/pdf");
    expect(result!.meta.name).toBe("pdf");
  });

  it("finds skill nested multiple levels deep", async () => {
    await mkdir(join(repoDir, "skills", "org", "team", "deploy"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, "skills", "org", "team", "deploy", "SKILL.md"),
      SKILL_MD("deploy"),
    );

    const result = await discoverSkill(repoDir, "deploy");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("skills/org/team/deploy");
  });

  it("prefers direct match over nested match", async () => {
    // Direct: skills/pdf/SKILL.md
    await mkdir(join(repoDir, "skills", "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "pdf", "SKILL.md"),
      SKILL_MD("pdf"),
    );
    // Nested: skills/.curated/pdf/SKILL.md
    await mkdir(join(repoDir, "skills", ".curated", "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", ".curated", "pdf", "SKILL.md"),
      SKILL_MD("pdf"),
    );

    const result = await discoverSkill(repoDir, "pdf");
    expect(result!.path).toBe("skills/pdf");
  });

  it("finds skill by frontmatter name in nested category directory", async () => {
    await mkdir(join(repoDir, "skills", "experimental", "chat"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, "skills", "experimental", "chat", "SKILL.md"),
      SKILL_MD("chat-sdk"),
    );

    const result = await discoverSkill(repoDir, "chat-sdk");
    expect(result).not.toBeNull();
    expect(result!.path).toBe("skills/experimental/chat");
    expect(result!.meta.name).toBe("chat-sdk");
  });

  it("does not descend into skill directories", async () => {
    // A skill that has a subdirectory with another SKILL.md (e.g. scripts/sub/SKILL.md)
    // The inner one should NOT be discovered as a separate skill
    await mkdir(join(repoDir, "skills", "outer"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "outer", "SKILL.md"),
      SKILL_MD("outer"),
    );
    await mkdir(join(repoDir, "skills", "outer", "nested"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "outer", "nested", "SKILL.md"),
      SKILL_MD("nested"),
    );

    // Should not find "nested" since it's inside a skill directory
    const result = await discoverSkill(repoDir, "nested");
    expect(result).toBeNull();
  });

  it("finds skill at repo root (./SKILL.md)", async () => {
    await writeFile(join(repoDir, "SKILL.md"), SKILL_MD("glab"));

    const result = await discoverSkill(repoDir, "glab");
    expect(result).not.toBeNull();
    expect(result!.path).toBe(".");
    expect(result!.meta.name).toBe("glab");
  });

  it("prefers child directory over root SKILL.md with same name", async () => {
    await writeFile(join(repoDir, "SKILL.md"), SKILL_MD("pdf"));
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    const result = await discoverSkill(repoDir, "pdf");
    expect(result!.path).toBe("pdf");
  });

  it("finds root SKILL.md alongside child-dir skills with different names", async () => {
    await writeFile(join(repoDir, "SKILL.md"), SKILL_MD("root-skill"));
    await mkdir(join(repoDir, "other"), { recursive: true });
    await writeFile(join(repoDir, "other", "SKILL.md"), SKILL_MD("other"));

    const rootResult = await discoverSkill(repoDir, "root-skill");
    expect(rootResult).not.toBeNull();
    expect(rootResult!.path).toBe(".");

    const otherResult = await discoverSkill(repoDir, "other");
    expect(otherResult).not.toBeNull();
    expect(otherResult!.path).toBe("other");
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

  it("discovers skills in category subdirectories", async () => {
    // OpenAI-style: skills/.curated/pdf/, skills/.curated/sentry/
    await mkdir(join(repoDir, "skills", ".curated", "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", ".curated", "pdf", "SKILL.md"),
      SKILL_MD("pdf"),
    );
    await mkdir(join(repoDir, "skills", ".curated", "sentry"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", ".curated", "sentry", "SKILL.md"),
      SKILL_MD("sentry"),
    );
    // Also a direct skill alongside
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(3);
    const names = results.map((r) => r.meta.name).toSorted();
    expect(names).toEqual(["pdf", "review", "sentry"]);
    expect(results.find((r) => r.meta.name === "pdf")!.path).toBe(
      "skills/.curated/pdf",
    );
  });

  it("does not descend into skill directories when discovering all", async () => {
    await mkdir(join(repoDir, "skills", "outer"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "outer", "SKILL.md"),
      SKILL_MD("outer"),
    );
    await mkdir(join(repoDir, "skills", "outer", "nested"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "outer", "nested", "SKILL.md"),
      SKILL_MD("nested"),
    );

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.name).toBe("outer");
  });

  it("discovers root-level SKILL.md", async () => {
    await writeFile(join(repoDir, "SKILL.md"), SKILL_MD("glab"));

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(".");
    expect(results[0]!.meta.name).toBe("glab");
  });

  it("discovers root SKILL.md alongside child-dir skills", async () => {
    await writeFile(join(repoDir, "SKILL.md"), SKILL_MD("root-skill"));
    await mkdir(join(repoDir, "other"), { recursive: true });
    await writeFile(join(repoDir, "other", "SKILL.md"), SKILL_MD("other"));

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.meta.name).toSorted();
    expect(names).toEqual(["other", "root-skill"]);
  });

  it("child-dir skill shadows root SKILL.md with same name", async () => {
    await writeFile(join(repoDir, "SKILL.md"), SKILL_MD("pdf"));
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    const results = await discoverAllSkills(repoDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe("pdf");
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

const AGENT_MD = (name: string) => `---
name: ${name}
description: Agent ${name}
---
# ${name}
`;

describe("markerFile opt", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "dotagents-marker-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true });
  });

  it("default marker discovers SKILL.md but not AGENT.md", async () => {
    await mkdir(join(repoDir, "skills", "skill-a"), { recursive: true });
    await writeFile(join(repoDir, "skills", "skill-a", "SKILL.md"), SKILL_MD("skill-a"));
    await mkdir(join(repoDir, "skills", "agent-a"), { recursive: true });
    await writeFile(join(repoDir, "skills", "agent-a", "AGENT.md"), AGENT_MD("agent-a"));

    const results = await discoverAllSkills(repoDir);
    expect(results.map((r) => r.meta.name)).toEqual(["skill-a"]);
  });

  it("override marker discovers AGENT.md but not SKILL.md", async () => {
    await mkdir(join(repoDir, "agents", "skill-a"), { recursive: true });
    await writeFile(join(repoDir, "agents", "skill-a", "SKILL.md"), SKILL_MD("skill-a"));
    await mkdir(join(repoDir, "agents", "agent-a"), { recursive: true });
    await writeFile(join(repoDir, "agents", "agent-a", "AGENT.md"), AGENT_MD("agent-a"));

    const results = await discoverAllSkills(repoDir, {
      scanDirs: ["agents"],
      markerFile: "AGENT.md",
    });
    expect(results.map((r) => r.meta.name)).toEqual(["agent-a"]);
  });

  it("discoverSkill respects override marker", async () => {
    await mkdir(join(repoDir, "agents", "my-agent"), { recursive: true });
    await writeFile(join(repoDir, "agents", "my-agent", "AGENT.md"), AGENT_MD("my-agent"));

    const result = await discoverSkill(repoDir, "my-agent", {
      scanDirs: ["agents"],
      markerFile: "AGENT.md",
    });
    expect(result?.meta.name).toBe("my-agent");
  });

  it("marker opt does not affect marketplace discovery (which is SKILL-specific)", async () => {
    // Marketplace structure with SKILL.md
    await mkdir(join(repoDir, ".claude-plugin"), { recursive: true });
    await writeFile(join(repoDir, ".claude-plugin", "marketplace.json"), "{}");
    await mkdir(join(repoDir, "plugins", "p", "skills", "marketplace-skill"), {
      recursive: true,
    });
    await writeFile(
      join(repoDir, "plugins", "p", "skills", "marketplace-skill", "SKILL.md"),
      SKILL_MD("marketplace-skill"),
    );

    // Even with markerFile=AGENT.md, marketplace plugin scan still finds SKILL.md skills.
    const results = await discoverAllSkills(repoDir, { markerFile: "AGENT.md" });
    expect(results.map((r) => r.meta.name)).toContain("marketplace-skill");
  });
});
