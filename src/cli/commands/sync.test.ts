import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSync } from "./sync.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { loadLockfile } from "../../lockfile/loader.js";
import { loadConfig } from "../../config/loader.js";
import { hashDirectory } from "../../utils/hash.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runSync", () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-sync-"));
    projectRoot = join(tmpDir, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("adopts orphaned skill into agents.toml and agents.lock", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const orphanDir = join(projectRoot, ".agents", "skills", "orphan");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "SKILL.md"), SKILL_MD("orphan"));

    const result = await runSync({ projectRoot });

    // Should be adopted, not reported as an issue
    expect(result.adopted).toEqual(["orphan"]);
    expect(result.issues).toHaveLength(0);

    // agents.toml should now declare the skill with path: source
    const config = await loadConfig(join(projectRoot, "agents.toml"));
    const skill = config.skills.find((s) => s.name === "orphan");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("path:.agents/skills/orphan");

    // agents.lock should have integrity for the skill
    const lockfile = await loadLockfile(join(projectRoot, "agents.lock"));
    expect(lockfile).not.toBeNull();
    expect(lockfile!.skills["orphan"]).toBeDefined();
    expect(lockfile!.skills["orphan"]!.integrity).toMatch(/^sha256-/);
    expect(lockfile!.skills["orphan"]!.source).toBe("path:.agents/skills/orphan");
  });

  it("adopts multiple orphans in one sync", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    for (const name of ["alpha", "beta"]) {
      const dir = join(projectRoot, ".agents", "skills", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), SKILL_MD(name));
    }

    const result = await runSync({ projectRoot });
    expect(result.adopted).toHaveLength(2);
    expect(result.adopted).toContain("alpha");
    expect(result.adopted).toContain("beta");

    const config = await loadConfig(join(projectRoot, "agents.toml"));
    expect(config.skills).toHaveLength(2);
  });

  it("adopted skill does not appear as orphan issue", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const orphanDir = join(projectRoot, ".agents", "skills", "stray");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "SKILL.md"), SKILL_MD("stray"));

    const result = await runSync({ projectRoot });
    expect(result.adopted).toContain("stray");
    expect(result.issues).toHaveLength(0);
  });

  it("detects missing skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );

    const result = await runSync({ projectRoot });
    const missingIssues = result.issues.filter((i) => i.type === "missing");
    expect(missingIssues).toHaveLength(1);
    expect(missingIssues[0]!.name).toBe("pdf");
  });

  it("detects modified skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );
    const skillDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("pdf"));

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
          commit: "a".repeat(40),
          integrity: "sha256-stale",
        },
      },
    });

    const result = await runSync({ projectRoot });
    const modifiedIssues = result.issues.filter((i) => i.type === "modified");
    expect(modifiedIssues).toHaveLength(1);
  });

  it("reports no issues when everything is in sync", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );
    const skillDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("pdf"));

    const integrity = await hashDirectory(skillDir);
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
          commit: "a".repeat(40),
          integrity,
        },
      },
    });

    const result = await runSync({ projectRoot });
    expect(result.issues).toHaveLength(0);
  });

  it("repairs broken symlinks", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[symlinks]\ntargets = [".claude"]\n`,
    );

    // Create .claude dir without the symlink
    await mkdir(join(projectRoot, ".claude"), { recursive: true });

    const result = await runSync({ projectRoot });
    expect(result.symlinksRepaired).toBe(1);
  });

  it("regenerates gitignore", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );

    const result = await runSync({ projectRoot });
    expect(result.gitignoreUpdated).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const gitignore = await readFile(
      join(projectRoot, ".agents", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("/skills/pdf/");
  });

  it("repairs missing MCP configs", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[mcp]]\nname = "github"\ncommand = "npx"\nargs = ["-y", "@mcp/server-github"]\n`,
    );

    const result = await runSync({ projectRoot });
    expect(result.mcpRepaired).toBeGreaterThan(0);

    // Verify config was created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(projectRoot, ".mcp.json"))).toBe(true);
  });

  it("repairs agent-specific symlinks", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n`,
    );

    // .claude dir exists but no symlink
    await mkdir(join(projectRoot, ".claude"), { recursive: true });

    const result = await runSync({ projectRoot });
    expect(result.symlinksRepaired).toBe(1);
  });

  it("repairs missing hook configs", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\ncommand = ".agents/hooks/block-rm.sh"\n`,
    );

    const result = await runSync({ projectRoot });
    expect(result.hooksRepaired).toBeGreaterThan(0);

    // Verify config was created
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(projectRoot, ".claude", "settings.json"))).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(await readFile(join(projectRoot, ".claude", "settings.json"), "utf-8"));
    expect(settings.hooks.PreToolUse).toBeDefined();
  });

  it("reports no hook issues when configs are present", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\nagents = ["claude"]\n\n[[hooks]]\nevent = "Stop"\ncommand = "check.sh"\n`,
    );

    // First sync to create the config
    await runSync({ projectRoot });

    // Second sync should find everything in order
    const result = await runSync({ projectRoot });
    expect(result.hooksRepaired).toBe(0);
    expect(result.issues.filter((i) => i.type === "hooks")).toHaveLength(0);
  });
});
