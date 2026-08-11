import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import list, { runList, runPluginList } from "./list.js";
import { writeLockfile } from "../../lockfile/writer.js";
import { resolveScope } from "../../scope.js";

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---
`;

describe("runList", () => {
  let tmpDir: string;
  let projectRoot: string;
  let cwd: string;

  beforeEach(async () => {
    cwd = process.cwd();
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-list-"));
    projectRoot = join(tmpDir, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
  });

  afterEach(async () => {
    process.chdir(cwd);
    vi.restoreAllMocks();
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

  it("reports ok when skill is installed and locked", async () => {
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
        },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
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

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
        },
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/review",
        },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name).toSorted()).toEqual(["pdf", "review"]);
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

    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        pdf: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "pdf",
        },
        review: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/review",
        },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("pdf");
  });

  it("reports plugin status from installed bundles and lockfile entries", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[plugins]]
name = "missing-tools"
source = "org/missing"

[[plugins]]
name = "ok-tools"
source = "org/ok"

[[plugins]]
name = "unlocked-tools"
source = "org/unlocked"
`,
    );
    await mkdir(join(projectRoot, ".agents", "plugins", "ok-tools"), { recursive: true });
    await mkdir(join(projectRoot, ".agents", "plugins", "unlocked-tools"), { recursive: true });
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {},
      plugins: {
        "ok-tools": {
          source: "org/ok",
          resolved_url: "https://github.com/org/ok.git",
          resolved_path: ".",
        },
      },
    });

    const results = await runPluginList({ scope: resolveScope("project", projectRoot) });

    expect(results).toEqual([
      { name: "missing-tools", source: "org/missing", status: "missing" },
      { name: "ok-tools", source: "org/ok", status: "ok" },
      { name: "unlocked-tools", source: "org/unlocked", status: "unlocked" },
    ]);
  });

  it("prints JSON with skill and plugin sections", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1

[[skills]]
name = "pdf"
source = "org/repo"

[[plugins]]
name = "review-tools"
source = "org/plugins"
`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(projectRoot);

    await list(["--json"], { scope: resolveScope("project", projectRoot) });

    const printed = log.mock.calls[0]?.[0];
    expect(JSON.parse(String(printed))).toEqual({
      skills: [
        { name: "pdf", source: "org/repo", status: "missing" },
      ],
      plugins: [
        { name: "review-tools", source: "org/plugins", status: "missing" },
      ],
    });
  });

  it("wildcard path scope is respected in list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "org/repo"\npath = "skills/engineering"\n`,
    );
    for (const name of ["deploy", "notes"]) {
      const skillDir = join(projectRoot, ".agents", "skills", name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), SKILL_MD(name));
    }
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        deploy: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/engineering/deploy",
        },
        notes: {
          source: "org/repo",
          resolved_url: "https://github.com/org/repo.git",
          resolved_path: "skills/productivity/notes",
        },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });

    expect(results.map((result) => result.name)).toEqual(["deploy"]);
  });

  it("retains legacy wildcard entries without resolved paths in list", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "path:local-skills"\npath = "engineering"\n`,
    );
    const skillDir = join(projectRoot, ".agents", "skills", "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), SKILL_MD("review"));
    await writeLockfile(join(projectRoot, "agents.lock"), {
      version: 1,
      skills: {
        review: { source: "path:local-skills" },
      },
    });

    const results = await runList({ scope: resolveScope("project", projectRoot) });

    expect(results.map((result) => result.name)).toEqual(["review"]);
  });
});
