import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSync } from "./sync.js";
import { writeLockfile } from "../../lockfile/writer.js";
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

  it("detects orphaned skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    // Orphan: installed but not in config
    const orphanDir = join(projectRoot, ".agents", "skills", "orphan");
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, "SKILL.md"), SKILL_MD("orphan"));

    const result = await runSync({ projectRoot });
    const orphanIssues = result.issues.filter((i) => i.type === "orphan");
    expect(orphanIssues).toHaveLength(1);
    expect(orphanIssues[0]!.name).toBe("orphan");
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
});
