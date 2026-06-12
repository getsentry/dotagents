import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InstalledSubagentWriteError,
  loadInstalledSubagents,
  pruneInstalledSubagents,
  resolveSubagent,
  writeInstalledSubagents,
} from "./subagent-store.js";
import { DOTAGENTS_SUBAGENT_MARKER, markManagedMarkdownSubagent } from "./definitions/helpers.js";
import type { SubagentConfig } from "../config/schema.js";

const SUBAGENT_MD = (name: string) => `---
name: ${name}
description: Review code for correctness.
---

Review the current diff.
`;

function subagentConfig(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    name: "code-reviewer",
    source: "path:repo",
    ...overrides,
  };
}

describe("resolveSubagent", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-subagent-store-"));
    repoDir = join(tmpDir, "repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("discovers subagents by frontmatter name", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await writeFile(join(repoDir, "agents", "reviewer.md"), SUBAGENT_MD("code-reviewer"));

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.name).toBe("code-reviewer");
    expect(resolved.subagent.description).toBe("Review code for correctness.");
  });

  it("does not implicitly discover root markdown files", async () => {
    await writeFile(join(repoDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await expect(
      resolveSubagent(subagentConfig(), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow('Subagent "code-reviewer" not found in path:repo.');
  });

  it("imports root markdown only when path is explicit", async () => {
    await writeFile(join(repoDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    const resolved = await resolveSubagent(subagentConfig({ path: "code-reviewer.md" }), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.resolvedPath).toBeUndefined();
    expect(resolved.subagent.name).toBe("code-reviewer");
  });

  it("does not classify TOML under another native runtime directory as Codex", async () => {
    await mkdir(join(repoDir, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, ".claude", "agents", "code-reviewer.toml"),
      [
        'name = "code_reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Review the current diff."',
        "",
      ].join("\n"),
    );

    await expect(
      resolveSubagent(subagentConfig({ path: ".claude/agents/code-reviewer.toml" }), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow('Unsupported claude subagent file extension ".toml"');
  });

  it("imports Codex TOML subagents as portable declarations with native content", async () => {
    await mkdir(join(repoDir, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, ".codex", "agents", "code-reviewer.toml"),
      [
        'name = "code_reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Review the current diff."',
        'sandbox_mode = "read-only"',
        "",
      ].join("\n"),
    );

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.name).toBe("code-reviewer");
    expect(resolved.subagent.instructions).toBe("Review the current diff.");
    expect(resolved.subagent.native?.codex).toContain('sandbox_mode = "read-only"');
    expect(resolved.subagent.native?.codex).toContain('name = "code_reviewer"');
  });

  it("discovers Codex TOML subagents by native name when it is portable", async () => {
    await mkdir(join(repoDir, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, ".codex", "agents", "reviewer.toml"),
      [
        'name = "code-reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Review the current diff."',
        "",
      ].join("\n"),
    );

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.name).toBe("code-reviewer");
    expect(resolved.subagent.native?.codex).toContain('name = "code-reviewer"');
  });

  it("imports OpenCode markdown subagents using the filename as the name", async () => {
    await mkdir(join(repoDir, ".opencode", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, ".opencode", "agents", "code-reviewer.md"),
      `---
name: other-reviewer
description: Review code for correctness.
mode: subagent
permission:
  edit: deny
---

Review the current diff.
`,
    );

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.name).toBe("code-reviewer");
    expect(resolved.subagent.native?.opencode).toContain("mode: subagent");
    expect(resolved.subagent.native?.opencode).toContain("permission:");
    expect(resolved.subagent.native?.opencode).toContain("name: other-reviewer");
  });

  it("imports Cursor markdown subagents using the filename when name is omitted", async () => {
    await mkdir(join(repoDir, ".cursor", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, ".cursor", "agents", "code-reviewer.md"),
      `---
description: Review code for correctness.
model: inherit
---

Review the current diff.
`,
    );

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.name).toBe("code-reviewer");
    expect(resolved.subagent.native?.cursor).toContain("model: inherit");
  });

  it("merges native subagent artifacts for the same portable declaration", async () => {
    await mkdir(join(repoDir, ".claude", "agents"), { recursive: true });
    await mkdir(join(repoDir, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, ".claude", "agents", "code-reviewer.md"),
      `---
name: code-reviewer
description: Review code for correctness.
tools: Read, Grep
---

Review the current diff for Claude.
`,
    );
    await writeFile(
      join(repoDir, ".codex", "agents", "code-reviewer.toml"),
      [
        'name = "code_reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Review the current diff for Codex."',
        'sandbox_mode = "read-only"',
        "",
      ].join("\n"),
    );

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.instructions).toBe("Review the current diff for Claude.");
    expect(resolved.subagent.native?.claude).toContain("tools: Read, Grep");
    expect(resolved.subagent.native?.codex).toContain('sandbox_mode = "read-only"');
  });

  it("merges a portable declaration with matching native artifacts", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await mkdir(join(repoDir, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(repoDir, "agents", "code-reviewer.md"),
      SUBAGENT_MD("code-reviewer"),
    );
    await writeFile(
      join(repoDir, ".codex", "agents", "code-reviewer.toml"),
      [
        'name = "code_reviewer"',
        'description = "Review code for correctness."',
        'developer_instructions = "Review the current diff for Codex."',
        'sandbox_mode = "read-only"',
        "",
      ].join("\n"),
    );

    const resolved = await resolveSubagent(subagentConfig(), {
      stateDir: join(tmpDir, "state"),
      projectRoot: tmpDir,
    });

    expect(resolved.subagent.instructions).toBe("Review the current diff.");
    expect(resolved.subagent.native?.codex).toContain('sandbox_mode = "read-only"');
  });

  it("rejects explicit paths whose frontmatter name differs from agents.toml", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await writeFile(join(repoDir, "agents", "reviewer.md"), SUBAGENT_MD("other-reviewer"));

    await expect(
      resolveSubagent(subagentConfig({ path: "agents/reviewer.md" }), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow(
      'Subagent "agents/reviewer.md" declares name "other-reviewer", but agents.toml requested "code-reviewer".',
    );
  });

  it("rejects filename matches whose frontmatter name differs from agents.toml", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await writeFile(join(repoDir, "agents", "code-reviewer.md"), SUBAGENT_MD("other-reviewer"));

    await expect(
      resolveSubagent(subagentConfig(), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow(
      'Subagent "agents/code-reviewer.md" declares name "other-reviewer", but agents.toml requested "code-reviewer".',
    );
  });

  it("rejects filename matches with invalid frontmatter", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await writeFile(join(repoDir, "agents", "code-reviewer.md"), "# No frontmatter\n");

    await expect(
      resolveSubagent(subagentConfig(), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow("No YAML frontmatter");
  });

  it("rejects ambiguous metadata matches in the same scan directory", async () => {
    await mkdir(join(repoDir, "agents", "a"), { recursive: true });
    await mkdir(join(repoDir, "agents", "b"), { recursive: true });
    await writeFile(join(repoDir, "agents", "a", "reviewer.md"), SUBAGENT_MD("code-reviewer"));
    await writeFile(join(repoDir, "agents", "b", "reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await expect(
      resolveSubagent(subagentConfig(), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow(
      'Ambiguous metadata matches for subagent "code-reviewer" in agents',
    );
  });

  it("rejects ambiguous portable matches across scan directories", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await mkdir(join(repoDir, ".agents", "agents"), { recursive: true });
    await writeFile(join(repoDir, "agents", "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));
    await writeFile(join(repoDir, ".agents", "agents", "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    await expect(
      resolveSubagent(subagentConfig(), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow(
      'Ambiguous portable matches for subagent "code-reviewer": agents/code-reviewer.md, .agents/agents/code-reviewer.md',
    );
  });

  it("rejects invalid frontmatter names", async () => {
    await mkdir(join(repoDir, "agents"), { recursive: true });
    await writeFile(join(repoDir, "agents", "code-reviewer.md"), SUBAGENT_MD("CodeReviewer"));

    await expect(
      resolveSubagent(subagentConfig({ path: "agents/code-reviewer.md" }), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow(
      'Invalid subagent name "CodeReviewer"',
    );
  });

  it("rejects explicit paths outside the source directory", async () => {
    await expect(
      resolveSubagent(subagentConfig({ path: "../outside.md" }), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow("Subagent path resolves outside source: ../outside.md");
  });

  it("rejects HTTPS well-known sources", async () => {
    await expect(
      resolveSubagent(subagentConfig({ source: "https://example.com" }), {
        stateDir: join(tmpDir, "state"),
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow("HTTPS well-known sources are not supported for subagents");
  });

  it("reports installed subagents whose frontmatter name does not match config", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, "code-reviewer.md"),
      markManagedMarkdownSubagent(SUBAGENT_MD("other-reviewer")),
    );

    const result = await loadInstalledSubagents(installedDir, [subagentConfig()]);

    expect(result.subagents).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.issue).toContain(
      'declares name "other-reviewer", but agents.toml requested "code-reviewer"',
    );
  });

  it("reports unmanaged installed subagents without loading them", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    await writeFile(join(installedDir, "code-reviewer.md"), SUBAGENT_MD("code-reviewer"));

    const result = await loadInstalledSubagents(installedDir, [subagentConfig()]);

    expect(result.subagents).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.issue).toContain("not managed by dotagents");
  });
});

describe("writeInstalledSubagents", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-subagent-store-write-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("does not create an empty install directory when there are no subagents", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");

    const written = await writeInstalledSubagents(installedDir, []);

    expect(written).toEqual([]);
    expect(existsSync(installedDir)).toBe(false);
  });

  it("prunes stale managed files when there are no subagents", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await writeInstalledSubagents(installedDir, [{
      name: "code-reviewer",
      description: "Review code for correctness.",
      instructions: "Review the current diff.",
    }]);

    await pruneInstalledSubagents(installedDir, []);

    expect(existsSync(join(installedDir, "code-reviewer.md"))).toBe(false);
  });

  it("does not prune stale managed files while writing", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await writeInstalledSubagents(installedDir, [{
      name: "code-reviewer",
      description: "Review code for correctness.",
      instructions: "Review the current diff.",
    }]);

    await writeInstalledSubagents(installedDir, []);

    expect(existsSync(join(installedDir, "code-reviewer.md"))).toBe(true);
  });

  it("does not prune files that mention the marker outside the managed header", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const filePath = join(installedDir, "notes.md");
    await writeFile(
      filePath,
      `---
name: notes
---

The phrase ${DOTAGENTS_SUBAGENT_MARKER} appears in instructions.
`,
      "utf-8",
    );

    await pruneInstalledSubagents(installedDir, []);

    expect(existsSync(filePath)).toBe(true);
  });

  it("does not prune markdown files that start with a TOML-style marker", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const filePath = join(installedDir, "notes.md");
    await writeFile(
      filePath,
      `# ${DOTAGENTS_SUBAGENT_MARKER}
---
name: notes
---

Review the current diff.
`,
      "utf-8",
    );

    await pruneInstalledSubagents(installedDir, []);

    expect(existsSync(filePath)).toBe(true);
  });

  it("rejects unmanaged installed files without overwriting them", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const filePath = join(installedDir, "code-reviewer.md");
    await writeFile(filePath, "hand-written subagent\n", "utf-8");

    await expect(writeInstalledSubagents(installedDir, [{
      name: "code-reviewer",
      description: "Review code for correctness.",
      instructions: "Review the current diff.",
    }])).rejects.toThrow(InstalledSubagentWriteError);

    expect(await readFile(filePath, "utf-8")).toBe("hand-written subagent\n");
  });

  it("preflights unmanaged conflicts before updating any installed files", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await writeInstalledSubagents(installedDir, [{
      name: "alpha",
      description: "Alpha reviewer.",
      instructions: "Original alpha instructions.",
    }]);
    const alphaPath = join(installedDir, "alpha.md");
    const originalAlpha = await readFile(alphaPath, "utf-8");
    const betaPath = join(installedDir, "beta.md");
    await writeFile(betaPath, "hand-written beta\n", "utf-8");

    await expect(writeInstalledSubagents(installedDir, [
      {
        name: "alpha",
        description: "Alpha reviewer.",
        instructions: "Updated alpha instructions.",
      },
      {
        name: "beta",
        description: "Beta reviewer.",
        instructions: "Beta instructions.",
      },
    ])).rejects.toThrow(InstalledSubagentWriteError);

    expect(await readFile(alphaPath, "utf-8")).toBe(originalAlpha);
    expect(await readFile(betaPath, "utf-8")).toBe("hand-written beta\n");
  });

  it("rejects files that mention the marker outside the managed header", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const filePath = join(installedDir, "code-reviewer.md");
    const content = `---
name: code-reviewer
---

The phrase ${DOTAGENTS_SUBAGENT_MARKER} appears in instructions.
`;
    await writeFile(filePath, content, "utf-8");

    await expect(writeInstalledSubagents(installedDir, [{
      name: "code-reviewer",
      description: "Review code for correctness.",
      instructions: "Review the current diff.",
    }])).rejects.toThrow(InstalledSubagentWriteError);

    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("rejects markdown files that start with a TOML-style marker", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await mkdir(installedDir, { recursive: true });
    const filePath = join(installedDir, "code-reviewer.md");
    const content = `# ${DOTAGENTS_SUBAGENT_MARKER}
---
name: code-reviewer
---

Review the current diff.
`;
    await writeFile(filePath, content, "utf-8");

    await expect(writeInstalledSubagents(installedDir, [{
      name: "code-reviewer",
      description: "Review code for correctness.",
      instructions: "Review the current diff.",
    }])).rejects.toThrow(InstalledSubagentWriteError);

    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("roundtrips native overlays through the installed portable markdown", async () => {
    const installedDir = join(tmpDir, ".agents", "agents");
    await writeInstalledSubagents(installedDir, [{
      name: "code-reviewer",
      description: "Review code for correctness.",
      instructions: "Review the current diff.",
      native: {
        codex: [
          'name = "code_reviewer"',
          'description = "Review code for correctness."',
          'developer_instructions = "Review the current diff."',
          'sandbox_mode = "read-only"',
          "",
        ].join("\n"),
      },
    }]);

    const result = await loadInstalledSubagents(installedDir, [subagentConfig()]);

    expect(result.issues).toEqual([]);
    expect(result.subagents[0]!.native?.codex).toContain('sandbox_mode = "read-only"');
    expect(result.subagents[0]!.native?.codex).toContain('name = "code_reviewer"');
  });
});
