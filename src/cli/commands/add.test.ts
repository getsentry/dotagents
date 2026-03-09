import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import add, { runAdd, AddError } from "./add.js";
import { exec } from "../../utils/exec.js";
import { resolveScope } from "../../scope.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`;

describe("runAdd", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-add-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Set up project
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await writeFile(join(repoDir, "pdf", "prompt.md"), "Process PDFs");

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    await mkdir(join(repoDir, "skills", "commit"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "commit", "SKILL.md"),
      SKILL_MD("commit"),
    );

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("adds a single skill via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf"],
    });

    expect(result).toBe("pdf");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
  });

  it("adds multiple skills via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf", "review"],
    });

    expect(result).toEqual(["pdf", "review"]);

    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
    expect(toml).toContain('name = "review"');
  });

  it("throws when a skill is not found", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["nonexistent"],
      }),
    ).rejects.toThrow(AddError);
  });

  it("throws when one of multiple skills is not found (fails fast)", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["pdf", "nonexistent"],
      }),
    ).rejects.toThrow(AddError);

    // "pdf" should NOT have been partially added
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).not.toContain('name = "pdf"');
  });

  it("throws when a skill already exists in config", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["pdf"],
      }),
    ).rejects.toThrow(AddError);
  });

  it("skips existing skills and adds the rest when adding multiple", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["review", "pdf"],
    });

    // Only "review" should be added; "pdf" was skipped
    expect(result).toEqual(["review"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "review"');
  });

  it("throws when all specified skills already exist", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["pdf", "review"],
      }),
    ).rejects.toThrow(AddError);
  });

  it("throws when --all is used with names", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["pdf"],
        all: true,
      }),
    ).rejects.toThrow(AddError);
  });

  it("treats shorthand and expanded GitLab sources as the same wildcard", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\ndefaultRepositorySource = "gitlab"\n\n[[skills]]\nname = "*"\nsource = "getsentry/skills"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: "getsentry/skills",
        all: true,
      }),
    ).rejects.toThrow(
      'A wildcard entry for "getsentry/skills" already exists in agents.toml.',
    );
  });

  it("auto-selects when repo has a single skill", async () => {
    // Create a repo with only one skill
    const singleRepo = join(tmpDir, "single-repo");
    await mkdir(singleRepo, { recursive: true });
    await exec("git", ["init"], { cwd: singleRepo });
    await exec("git", ["config", "user.email", "test@test.com"], {
      cwd: singleRepo,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: singleRepo });
    await mkdir(join(singleRepo, "only-skill"), { recursive: true });
    await writeFile(
      join(singleRepo, "only-skill", "SKILL.md"),
      SKILL_MD("only-skill"),
    );
    await exec("git", ["add", "."], { cwd: singleRepo });
    await exec("git", ["commit", "-m", "initial"], { cwd: singleRepo });

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${singleRepo}`,
      interactive: false,
    });

    expect(result).toBe("only-skill");
  });

  it("throws in non-interactive mode with multiple skills and no names", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        interactive: false,
      }),
    ).rejects.toThrow(/Multiple skills found/);
  });
});

describe("runAdd (local sources)", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let localSkillsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-add-local-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Set up project with a local skills directory inside it
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    // Create a local directory with multiple skills (inside project root)
    localSkillsDir = join(projectRoot, "local-skills");
    await mkdir(join(localSkillsDir, "pdf"), { recursive: true });
    await writeFile(join(localSkillsDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(localSkillsDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(localSkillsDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    await mkdir(join(localSkillsDir, "skills", "commit"), { recursive: true });
    await writeFile(
      join(localSkillsDir, "skills", "commit", "SKILL.md"),
      SKILL_MD("commit"),
    );
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("adds a single local skill without names (reads root SKILL.md)", async () => {
    // Create a single-skill local directory with SKILL.md at root
    const singleSkillDir = join(projectRoot, "my-skill");
    await mkdir(singleSkillDir, { recursive: true });
    await writeFile(join(singleSkillDir, "SKILL.md"), SKILL_MD("my-skill"));

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: "path:my-skill",
    });

    expect(result).toBe("my-skill");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "my-skill"');
  });

  it("adds a single local skill via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: "path:local-skills",
      names: ["pdf"],
    });

    expect(result).toBe("pdf");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
  });

  it("adds multiple local skills via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: "path:local-skills",
      names: ["pdf", "review"],
    });

    expect(result).toEqual(["pdf", "review"]);

    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
    expect(toml).toContain('name = "review"');
  });

  it("throws when a local skill is not found", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: "path:local-skills",
        names: ["nonexistent"],
      }),
    ).rejects.toThrow(AddError);
  });

  it("throws when one of multiple local skills is not found (fails fast)", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: "path:local-skills",
        names: ["pdf", "nonexistent"],
      }),
    ).rejects.toThrow(AddError);

    // "pdf" should NOT have been partially added
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).not.toContain('name = "pdf"');
  });

  it("skips existing local skills and adds the rest when adding multiple", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "path:local-skills"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: "path:local-skills",
      names: ["review", "pdf"],
    });

    // Only "review" should be added; "pdf" was skipped
    expect(result).toEqual(["review"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "review"');
  });

  it("throws when all specified local skills already exist", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "path:local-skills"\n\n[[skills]]\nname = "review"\nsource = "path:local-skills"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: "path:local-skills",
        names: ["pdf", "review"],
      }),
    ).rejects.toThrow(AddError);
  });
});

describe("add() CLI parsing", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-add-cli-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;
    originalExitCode = process.exitCode;

    // Set up project
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    process.exitCode = originalExitCode;
    await rm(tmpDir, { recursive: true });
  });

  it("passes positional skill names to runAdd", async () => {
    // We test the full CLI add() by running it against a real project dir
    // The project root must be the cwd for resolveDefaultScope
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add([`git:${repoDir}`, "pdf", "review"]);
      expect(process.exitCode).toBeUndefined();

      const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
      expect(toml).toContain('name = "pdf"');
      expect(toml).toContain('name = "review"');
    } finally {
      process.chdir(origCwd);
    }
  });

  it("passes repeated --skill flags to runAdd", async () => {
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add([`git:${repoDir}`, "--skill", "pdf", "--skill", "review"]);
      expect(process.exitCode).toBeUndefined();

      const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
      expect(toml).toContain('name = "pdf"');
      expect(toml).toContain('name = "review"');
    } finally {
      process.chdir(origCwd);
    }
  });

  it("errors when mixing positional names and --skill flags", async () => {
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add([`git:${repoDir}`, "pdf", "--skill", "review"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(origCwd);
    }
  });
});
