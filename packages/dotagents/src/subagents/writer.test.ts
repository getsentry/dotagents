import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseTOML } from "smol-toml";
import {
  projectSubagentResolver,
  pruneSubagentConfigs,
  reconcileSubagentConfigs,
  verifySubagentConfigs,
  writeSubagentConfigs,
} from "./writer.js";
import { DOTAGENTS_SUBAGENT_MARKER } from "./format.js";
import type { SubagentDeclaration } from "./types.js";

const SUBAGENT: SubagentDeclaration = {
  name: "code-reviewer",
  description: "Review code for correctness and missing tests.",
  instructions: "Review the current diff and return findings.",
};

const OTHER_SUBAGENT: SubagentDeclaration = {
  name: "test-writer",
  description: "Write focused tests.",
  instructions: "Add regression coverage for the current change.",
};

describe("writeSubagentConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-subagents-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("writes Claude markdown subagents", async () => {
    const result = await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(1);

    const content = await readFile(join(dir, ".claude", "agents", "code-reviewer.md"), "utf-8");
    expect(content).toContain(DOTAGENTS_SUBAGENT_MARKER);
    expect(content).toContain('name: "code-reviewer"');
    expect(content).toContain('description: "Review code for correctness and missing tests."');
    expect(content).toContain("Review the current diff and return findings.");
  });

  it("writes Cursor markdown subagents", async () => {
    await writeSubagentConfigs(["cursor"], [SUBAGENT], projectSubagentResolver(dir));

    const content = await readFile(join(dir, ".cursor", "agents", "code-reviewer.md"), "utf-8");
    expect(content).toContain('name: "code-reviewer"');
    expect(content).toContain('description: "Review code for correctness and missing tests."');
    expect(content).toContain("Review the current diff and return findings.");
  });

  it("writes Codex TOML subagents", async () => {
    await writeSubagentConfigs(["codex"], [SUBAGENT], projectSubagentResolver(dir));

    const raw = await readFile(join(dir, ".codex", "agents", "code-reviewer.toml"), "utf-8");
    expect(raw).toContain(DOTAGENTS_SUBAGENT_MARKER);

    const content = parseTOML(raw) as Record<string, unknown>;
    expect(content["name"]).toBe("code-reviewer");
    expect(content["description"]).toBe("Review code for correctness and missing tests.");
    expect(content["developer_instructions"]).toBe("Review the current diff and return findings.");
  });

  it("preserves native Codex fields only for the Codex target", async () => {
    await writeSubagentConfigs(
      ["codex", "claude"],
      [{
        ...SUBAGENT,
        instructions: "Portable instructions.",
        native: {
          codex: [
            "# upstream comment",
            'name = "code_reviewer"',
            'description = "Review code for correctness and missing tests."',
            'developer_instructions = "Native Codex instructions."',
            'sandbox_mode = "read-only"',
            "",
          ].join("\n"),
        },
      }],
      projectSubagentResolver(dir),
    );

    const codexRaw = await readFile(join(dir, ".codex", "agents", "code-reviewer.toml"), "utf-8");
    const codex = parseTOML(codexRaw) as Record<string, unknown>;
    expect(codex["developer_instructions"]).toBe("Native Codex instructions.");
    expect(codex["sandbox_mode"]).toBe("read-only");
    expect(codexRaw).toContain("# upstream comment");

    const claude = await readFile(join(dir, ".claude", "agents", "code-reviewer.md"), "utf-8");
    expect(claude).toContain("Portable instructions.");
    expect(claude).not.toContain("sandbox_mode");
  });

  it("writes OpenCode markdown subagents", async () => {
    await writeSubagentConfigs(["opencode"], [SUBAGENT], projectSubagentResolver(dir));

    const content = await readFile(join(dir, ".opencode", "agents", "code-reviewer.md"), "utf-8");
    expect(content).toContain(DOTAGENTS_SUBAGENT_MARKER);
    expect(content).toContain('description: "Review code for correctness and missing tests."');
    expect(content).toContain('mode: "subagent"');
    expect(content).toContain("Review the current diff and return findings.");
  });

  it("marks native OpenCode markdown without frontmatter", async () => {
    const result = await writeSubagentConfigs(
      ["opencode"],
      [{
        ...SUBAGENT,
        native: {
          opencode: "Review the current diff using native OpenCode markdown.\n",
        },
      }],
      projectSubagentResolver(dir),
    );

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(1);

    const content = await readFile(join(dir, ".opencode", "agents", "code-reviewer.md"), "utf-8");
    expect(content).toBe(`---
# ${DOTAGENTS_SUBAGENT_MARKER}
---

Review the current diff using native OpenCode markdown.
`);
  });

  it("preserves native markdown fields only for the matching markdown target", async () => {
    await writeSubagentConfigs(
      ["claude", "cursor"],
      [{
        ...SUBAGENT,
        native: {
          claude: [
            "---",
            "name: code-reviewer",
            "description: Review code for correctness and missing tests.",
            "tools: Read, Grep",
            "---",
            "",
            "Native Claude instructions.",
            "",
          ].join("\n"),
        },
      }],
      projectSubagentResolver(dir),
    );

    const claude = await readFile(join(dir, ".claude", "agents", "code-reviewer.md"), "utf-8");
    const cursor = await readFile(join(dir, ".cursor", "agents", "code-reviewer.md"), "utf-8");
    expect(claude).toContain("tools: Read, Grep");
    expect(claude).toContain("Native Claude instructions.");
    expect(cursor).not.toContain("tools");
    expect(cursor).toContain("Review the current diff and return findings.");
  });

  it("marks native markdown that has a BOM and spaced frontmatter opener", async () => {
    const result = await writeSubagentConfigs(
      ["claude"],
      [{
        ...SUBAGENT,
        native: {
          claude: "\uFEFF--- \nname: code-reviewer\ndescription: Review code.\n---\n\nNative instructions.\n",
        },
      }],
      projectSubagentResolver(dir),
    );

    expect(result.warnings).toEqual([]);
    expect(result.written).toBe(1);

    const content = await readFile(join(dir, ".claude", "agents", "code-reviewer.md"), "utf-8");
    expect(content).toContain(DOTAGENTS_SUBAGENT_MARKER);
    expect(content).toContain("Native instructions.");
  });

  it("respects explicit targets", async () => {
    await writeSubagentConfigs(
      ["claude", "codex"],
      [{ ...SUBAGENT, targets: ["codex"] }],
      projectSubagentResolver(dir),
    );

    expect(existsSync(join(dir, ".codex", "agents", "code-reviewer.toml"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "agents", "code-reviewer.md"))).toBe(false);
  });

  it("treats empty targets as all configured agents", async () => {
    await writeSubagentConfigs(
      ["claude", "codex"],
      [{ ...SUBAGENT, targets: [] }],
      projectSubagentResolver(dir),
    );

    expect(existsSync(join(dir, ".claude", "agents", "code-reviewer.md"))).toBe(true);
    expect(existsSync(join(dir, ".codex", "agents", "code-reviewer.toml"))).toBe(true);
  });

  it("warns when a target is not configured", async () => {
    const result = await writeSubagentConfigs(
      ["claude"],
      [{ ...SUBAGENT, targets: ["codex"] }],
      projectSubagentResolver(dir),
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("not listed in agents");
  });

  it("warns for unsupported agents", async () => {
    const result = await writeSubagentConfigs(["vscode"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("does not support custom subagents");
  });

  it("does not overwrite unmanaged files", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "code-reviewer.md"), "hand-written", "utf-8");

    const result = await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.warnings).toHaveLength(1);
    expect(result.written).toBe(0);
    expect(await readFile(join(targetDir, "code-reviewer.md"), "utf-8")).toBe("hand-written");
  });

  it("does not create duplicate unmanaged Claude identities", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(targetDir, "reviewer.md"),
      `---
name: code-reviewer
description: Hand-written reviewer.
---

Hand-written instructions.
`,
      "utf-8",
    );

    const result = await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("identity conflicts with unmanaged file");
    expect(result.written).toBe(0);
    expect(existsSync(join(targetDir, "code-reviewer.md"))).toBe(false);
  });

  it("preserves desired managed files when an unmanaged identity conflict exists", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const managedPath = join(targetDir, "code-reviewer.md");
    const unmanagedPath = join(targetDir, "reviewer.md");
    await writeFile(
      managedPath,
      `---
# ${DOTAGENTS_SUBAGENT_MARKER}
name: "code-reviewer"
description: "Managed reviewer."
---

Managed instructions.
`,
      "utf-8",
    );
    await writeFile(
      unmanagedPath,
      `---
name: code-reviewer
description: Hand-written reviewer.
---

Hand-written instructions.
`,
      "utf-8",
    );

    const result = await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));
    const pruned = await pruneSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("identity conflicts with unmanaged file");
    expect(pruned).toEqual([]);
    expect(existsSync(managedPath)).toBe(true);
    expect(existsSync(unmanagedPath)).toBe(true);
  });

  it("does not create duplicate unmanaged Codex identities", async () => {
    const targetDir = join(dir, ".codex", "agents");
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(targetDir, "reviewer.toml"),
      [
        'name = "code_reviewer"',
        'description = "Hand-written reviewer."',
        'developer_instructions = "Hand-written instructions."',
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await writeSubagentConfigs(
      ["codex"],
      [{
        ...SUBAGENT,
        native: {
          codex: [
            'name = "code_reviewer"',
            'description = "Review code for correctness and missing tests."',
            'developer_instructions = "Native Codex instructions."',
            "",
          ].join("\n"),
        },
      }],
      projectSubagentResolver(dir),
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("identity conflicts with unmanaged file");
    expect(result.written).toBe(0);
    expect(existsSync(join(targetDir, "code-reviewer.toml"))).toBe(false);
  });

  it("does not overwrite unmanaged Codex files that mention the marker outside the header", async () => {
    const targetDir = join(dir, ".codex", "agents");
    await mkdir(targetDir, { recursive: true });
    const filePath = join(targetDir, "code-reviewer.toml");
    const content = [
      'name = "code-reviewer"',
      'description = "Hand-written reviewer."',
      `developer_instructions = "Mentions ${DOTAGENTS_SUBAGENT_MARKER}"`,
      "",
    ].join("\n");
    await writeFile(filePath, content, "utf-8");

    const result = await writeSubagentConfigs(["codex"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("not managed by dotagents");
    expect(result.written).toBe(0);
    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("prunes stale dotagents-managed files", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "old-reviewer.md");
    await writeFile(
      stalePath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "old-reviewer"\n---\n`,
      "utf-8",
    );

    await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));
    const pruned = await pruneSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(pruned).toEqual([stalePath]);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(targetDir, "code-reviewer.md"))).toBe(true);
  });

  it("does not prune markdown files that start with a TOML-style marker", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "old-reviewer.md");
    await writeFile(
      stalePath,
      `# ${DOTAGENTS_SUBAGENT_MARKER}
---
name: "old-reviewer"
---
`,
      "utf-8",
    );

    const pruned = await pruneSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(pruned).toEqual([]);
    expect(existsSync(stalePath)).toBe(true);
  });

  it("does not prune managed files for runtimes not listed in agents", async () => {
    const targetDir = join(dir, ".codex", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "code-reviewer.toml");
    await writeFile(
      stalePath,
      `# ${DOTAGENTS_SUBAGENT_MARKER}\nname = "code-reviewer"\n`,
      "utf-8",
    );

    await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));
    const pruned = await pruneSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(pruned).toEqual([]);
    expect(existsSync(stalePath)).toBe(true);
  });

  it("does not read desired files while pruning stale files", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const desiredPath = join(targetDir, "code-reviewer.md");
    const stalePath = join(targetDir, "old-reviewer.md");
    await writeFile(
      desiredPath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "code-reviewer"\n---\n`,
      "utf-8",
    );
    await writeFile(
      stalePath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "old-reviewer"\n---\n`,
      "utf-8",
    );

    await chmod(desiredPath, 0o000);
    try {
      const pruned = await pruneSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

      expect(pruned).toEqual([stalePath]);
      expect(existsSync(desiredPath)).toBe(true);
      expect(existsSync(stalePath)).toBe(false);
    } finally {
      await chmod(desiredPath, 0o600);
    }
  });

  it("does not prune Codex files that mention the marker outside the header", async () => {
    const targetDir = join(dir, ".codex", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "old-reviewer.toml");
    await writeFile(
      stalePath,
      [
        'name = "old-reviewer"',
        'description = "Old reviewer."',
        `developer_instructions = "Mentions ${DOTAGENTS_SUBAGENT_MARKER}"`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const pruned = await pruneSubagentConfigs(["codex"], [SUBAGENT], projectSubagentResolver(dir));

    expect(pruned).toEqual([]);
    expect(existsSync(stalePath)).toBe(true);
  });

  it("prunes managed files when no subagents remain", async () => {
    const targetDir = join(dir, ".opencode", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "code-reviewer.md");
    await writeFile(
      stalePath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\ndescription: "old"\n---\n`,
      "utf-8",
    );

    await writeSubagentConfigs(["opencode"], [], projectSubagentResolver(dir));
    const pruned = await pruneSubagentConfigs(["opencode"], [], projectSubagentResolver(dir));

    expect(pruned).toEqual([stalePath]);
    expect(existsSync(stalePath)).toBe(false);
  });

  it("preserves declared-but-unloaded subagent files while pruning other stale files", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const declaredPath = join(targetDir, "code-reviewer.md");
    const stalePath = join(targetDir, "old-reviewer.md");
    await writeFile(
      declaredPath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "code-reviewer"\n---\n`,
      "utf-8",
    );
    await writeFile(
      stalePath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "old-reviewer"\n---\n`,
      "utf-8",
    );

    await writeSubagentConfigs(
      ["claude"],
      [],
      projectSubagentResolver(dir),
    );
    const pruned = await pruneSubagentConfigs(
      ["claude"],
      [{ name: "code-reviewer" }],
      projectSubagentResolver(dir),
    );

    expect(pruned).toEqual([stalePath]);
    expect(existsSync(declaredPath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);
  });
});

describe("verifySubagentConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-subagents-verify-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns no issues when configs match", async () => {
    await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    const issues = await verifySubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));
    expect(issues).toEqual([]);
  });

  it("reports missing configs", async () => {
    const issues = await verifySubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("missing");
  });

  it("reports unmanaged existing configs", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "code-reviewer.md"), "hand-written", "utf-8");

    const issues = await verifySubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("not managed by dotagents");
  });

  it("reports unmanaged identity conflicts", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(targetDir, "reviewer.md"),
      `---
name: code-reviewer
description: Hand-written reviewer.
---

Hand-written instructions.
`,
      "utf-8",
    );

    const issues = await verifySubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("identity conflicts with unmanaged file");
  });
});

describe("reconcileSubagentConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-subagents-reconcile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("inspects missing and conflicting configs without mutation", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const unmanagedPath = join(targetDir, "reviewer.md");
    await writeFile(
      unmanagedPath,
      `---\nname: code-reviewer\ndescription: Hand-written reviewer.\n---\n`,
      "utf-8",
    );

    const result = await reconcileSubagentConfigs(
      ["claude"],
      [SUBAGENT, OTHER_SUBAGENT],
      projectSubagentResolver(dir),
      { mode: "inspect" },
    );

    expect(result.issues.map(({ issue }) => issue)).toEqual([
      `Subagent config identity conflicts with unmanaged file: ${unmanagedPath}`,
      `Subagent config missing: ${join(targetDir, "test-writer.md")}`,
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.written).toBe(0);
    expect(result.pruned).toEqual([]);
    expect(existsSync(join(targetDir, "test-writer.md"))).toBe(false);
    expect(await readFile(unmanagedPath, "utf-8")).toContain("Hand-written reviewer");
  });

  it("applies desired writes and prunes while protecting declared unloaded files", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const declaredPath = join(targetDir, "failed-reviewer.md");
    const stalePath = join(targetDir, "old-reviewer.md");
    const managed = (name: string) =>
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "${name}"\n---\n`;
    await writeFile(declaredPath, managed("failed-reviewer"), "utf-8");
    await writeFile(stalePath, managed("old-reviewer"), "utf-8");

    const result = await reconcileSubagentConfigs(
      ["claude"],
      [SUBAGENT],
      projectSubagentResolver(dir),
      {
        mode: "apply",
        retainedSubagents: [SUBAGENT, { name: "failed-reviewer" }],
      },
    );

    expect(result.written).toBe(1);
    expect(result.pruned).toEqual([stalePath]);
    expect(existsSync(join(targetDir, "code-reviewer.md"))).toBe(true);
    expect(existsSync(declaredPath)).toBe(true);
    expect(existsSync(stalePath)).toBe(false);
  });

  it("reports unsupported targets without creating runtime state", async () => {
    const result = await reconcileSubagentConfigs(
      ["vscode"],
      [SUBAGENT],
      projectSubagentResolver(dir),
      { mode: "apply" },
    );

    expect(result.issues).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain("does not support custom subagents");
    expect(result.written).toBe(0);
    expect(result.pruned).toEqual([]);
    expect(existsSync(join(dir, ".vscode"))).toBe(false);
  });

  it("finishes inspection before writing any runtime files", async () => {
    const resolver = (agentId: string, spec: { projectDir: string }) => {
      if (agentId === "codex") {throw new Error("failed to resolve codex target");}
      return { dirPath: join(dir, spec.projectDir) };
    };

    await expect(reconcileSubagentConfigs(
      ["claude", "codex"],
      [{ ...SUBAGENT, targets: ["claude", "codex"] }],
      resolver,
      { mode: "apply" },
    )).rejects.toThrow("failed to resolve codex target");

    expect(existsSync(join(dir, ".claude", "agents", "code-reviewer.md"))).toBe(false);
  });

  it("reports unreadable configs during inspection and fails during apply", async () => {
    // Put a directory at the config path: existsSync still passes, but readFile
    // fails with EISDIR on every platform. chmod(0o000) would be POSIX-only —
    // Windows ignores the mode, reads the file, and lands on the "not managed"
    // branch instead of the read-failure one this test is about.
    const filePath = join(dir, ".claude", "agents", "code-reviewer.md");
    await mkdir(filePath, { recursive: true });

    const inspected = await reconcileSubagentConfigs(
      ["claude"],
      [SUBAGENT],
      projectSubagentResolver(dir),
      { mode: "inspect" },
    );
    expect(inspected.issues[0]!.issue).toContain("Failed to read");

    await expect(reconcileSubagentConfigs(
      ["claude"],
      [SUBAGENT],
      projectSubagentResolver(dir),
      { mode: "apply" },
    )).rejects.toThrow();
  });
});
