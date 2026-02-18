import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runList } from "./list.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { hashDirectory } from "../../utils/hash.js";
import { resolveScope } from "../../scope.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runList", () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-list-"));
    projectRoot = join(tmpDir, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("returns empty array when no skills declared", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      "version = 1\n",
    );
    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(0);
  });

  it("reports missing skill when not installed", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );
    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("missing");
  });

  it("reports unlocked skill when no lockfile", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );
    // Install the skill directory but no lockfile
    const skillDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("pdf"));

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("unlocked");
  });

  it("reports ok when integrity matches", async () => {
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

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.commit).toBe("aaaaaaaa");
  });

  it("reports modified when integrity differs", async () => {
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

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("modified");
  });

  it("sorts results by name", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "z-skill"\nsource = "org/z"\n\n[[skills]]\nname = "a-skill"\nsource = "org/a"\n`,
    );
    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results[0]!.name).toBe("a-skill");
    expect(results[1]!.name).toBe("z-skill");
  });

  it("lists wildcard-expanded skills from lockfile", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "org/repo"\n`,
    );

    // Create installed skill directories
    const pdfDir = join(projectRoot, ".agents", "skills", "pdf");
    const reviewDir = join(projectRoot, ".agents", "skills", "review");
    await mkdir(pdfDir, { recursive: true });
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(pdfDir, "SKILL.md"), SKILL_MD("pdf"));
    await writeFile(join(reviewDir, "SKILL.md"), SKILL_MD("review"));

    const pdfIntegrity = await hashDirectory(pdfDir);
    const reviewIntegrity = await hashDirectory(reviewDir);

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
          commit: "a".repeat(40),
          integrity: pdfIntegrity,
        },
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/review",
          commit: "a".repeat(40),
          integrity: reviewIntegrity,
        },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name).sort()).toEqual(["pdf", "review"]);
    // Both should be marked as wildcard
    expect(results.every((r) => r.wildcard === "org/repo")).toBe(true);
  });

  it("wildcard exclude is respected in list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "org/repo"\nexclude = ["review"]\n`,
    );

    const pdfDir = join(projectRoot, ".agents", "skills", "pdf");
    await mkdir(pdfDir, { recursive: true });
    await writeFile(join(pdfDir, "SKILL.md"), SKILL_MD("pdf"));
    const pdfIntegrity = await hashDirectory(pdfDir);

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
          commit: "a".repeat(40),
          integrity: pdfIntegrity,
        },
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/review",
          commit: "a".repeat(40),
          integrity: "sha256-whatever",
        },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("pdf");
  });
});
