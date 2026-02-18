import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSkill, resolveWildcardSkills } from "./resolver.js";
import { exec } from "../utils/exec.js";

/**
 * Integration tests that use real git operations.
 * These create local git repos to test the full resolve pipeline.
 */
describe("resolveSkill integration", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-resolve-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    await mkdir(stateDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    // Point cache to temp dir
    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Create a local git repo that looks like a skill repository
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    // Create a skill at the root level
    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "pdf", "SKILL.md"),
      `---
name: pdf
description: PDF processing skill
---

# PDF Processing
`,
    );

    // Create a skill in skills/ directory
    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      `---
name: review
description: Code review skill
---

# Review
`,
    );

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("resolves a local path: source", async () => {
    // Create skill inside project root
    const skillDir = join(projectRoot, "local-skills", "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: my-skill
description: A local skill
---
`,
    );

    const result = await resolveSkill(
      "my-skill",
      { source: "path:local-skills/my-skill" },
      { projectRoot },
    );

    expect(result.type).toBe("local");
    expect(result.skillDir).toBe(skillDir);
  });

  it("resolves a git: source with skill discovery", async () => {
    const result = await resolveSkill(
      "pdf",
      { source: `git:${repoDir}` },
      { projectRoot },
    );

    expect(result.type).toBe("git");
    if (result.type === "git") {
      expect(result.resolvedUrl).toBe(repoDir);
      expect(result.resolvedPath).toBe("pdf");
      expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("resolves a git: source for skill in skills/ directory", async () => {
    const result = await resolveSkill(
      "review",
      { source: `git:${repoDir}` },
      { projectRoot },
    );

    expect(result.type).toBe("git");
    if (result.type === "git") {
      expect(result.resolvedPath).toBe("skills/review");
    }
  });

  it("resolves with explicit path override", async () => {
    const result = await resolveSkill(
      "pdf",
      { source: `git:${repoDir}`, path: "pdf" },
      { projectRoot },
    );

    expect(result.type).toBe("git");
    if (result.type === "git") {
      expect(result.resolvedPath).toBe("pdf");
    }
  });

  it("throws ResolveError when skill not found in repo", async () => {
    await expect(
      resolveSkill(
        "nonexistent",
        { source: `git:${repoDir}` },
        { projectRoot },
      ),
    ).rejects.toThrow(/not found/);
  });

  it("caches repos and reuses them", async () => {
    // First resolve — clones
    const result1 = await resolveSkill(
      "pdf",
      { source: `git:${repoDir}` },
      { projectRoot },
    );

    // Second resolve — should reuse cache (same commit)
    const result2 = await resolveSkill(
      "review",
      { source: `git:${repoDir}` },
      { projectRoot },
    );

    expect(result1.type).toBe("git");
    expect(result2.type).toBe("git");
    if (result1.type === "git" && result2.type === "git") {
      expect(result1.commit).toBe(result2.commit);
    }
  });
});

describe("resolveWildcardSkills integration", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-wildcard-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    await mkdir(stateDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Create a local git repo with multiple skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(
      join(repoDir, "pdf", "SKILL.md"),
      `---\nname: pdf\ndescription: PDF skill\n---\n`,
    );

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      `---\nname: review\ndescription: Review skill\n---\n`,
    );

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("discovers all skills from a git source", async () => {
    const results = await resolveWildcardSkills(
      { source: `git:${repoDir}`, exclude: [] },
      { projectRoot },
    );

    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(["pdf", "review"]);
    expect(results.every((r) => r.resolved.type === "git")).toBe(true);
  });

  it("filters excluded skills", async () => {
    const results = await resolveWildcardSkills(
      { source: `git:${repoDir}`, exclude: ["review"] },
      { projectRoot },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("pdf");
  });

  it("returns empty array when all skills excluded", async () => {
    const results = await resolveWildcardSkills(
      { source: `git:${repoDir}`, exclude: ["pdf", "review"] },
      { projectRoot },
    );

    expect(results).toHaveLength(0);
  });

  it("discovers skills from a local source", async () => {
    // Create a local skills directory inside projectRoot
    const localSkills = join(projectRoot, "local-repo");
    await mkdir(join(localSkills, "my-skill"), { recursive: true });
    await writeFile(
      join(localSkills, "my-skill", "SKILL.md"),
      `---\nname: my-skill\ndescription: A local skill\n---\n`,
    );

    const results = await resolveWildcardSkills(
      { source: `path:local-repo`, exclude: [] },
      { projectRoot },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("my-skill");
    expect(results[0]!.resolved.type).toBe("local");
  });

  it("each resolved skill has correct commit and path", async () => {
    const results = await resolveWildcardSkills(
      { source: `git:${repoDir}`, exclude: [] },
      { projectRoot },
    );

    const pdf = results.find((r) => r.name === "pdf")!;
    expect(pdf.resolved.type).toBe("git");
    if (pdf.resolved.type === "git") {
      expect(pdf.resolved.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(pdf.resolved.resolvedPath).toBe("pdf");
    }

    const review = results.find((r) => r.name === "review")!;
    if (review.resolved.type === "git") {
      expect(review.resolved.resolvedPath).toBe("skills/review");
    }
  });
});
