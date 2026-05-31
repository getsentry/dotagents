import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseTOML } from "smol-toml";
import {
  projectSubagentResolver,
  verifySubagentConfigs,
  writeSubagentConfigs,
} from "./subagent-writer.js";
import { DOTAGENTS_SUBAGENT_MARKER } from "./definitions/helpers.js";
import type { SubagentDeclaration } from "./types.js";

const SUBAGENT: SubagentDeclaration = {
  name: "code-reviewer",
  description: "Review code for correctness and missing tests.",
  instructions: "Review the current diff and return findings.",
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

  it("respects explicit targets", async () => {
    await writeSubagentConfigs(
      ["claude", "codex"],
      [{ ...SUBAGENT, targets: ["codex"] }],
      projectSubagentResolver(dir),
    );

    expect(existsSync(join(dir, ".codex", "agents", "code-reviewer.toml"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "agents", "code-reviewer.md"))).toBe(false);
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

  it("prunes stale dotagents-managed files", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "old-reviewer.md");
    await writeFile(
      stalePath,
      `---\n# ${DOTAGENTS_SUBAGENT_MARKER}\nname: "old-reviewer"\n---\n`,
      "utf-8",
    );

    const result = await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.pruned).toEqual([stalePath]);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(join(targetDir, "code-reviewer.md"))).toBe(true);
  });

  it("prunes managed files for runtimes no longer listed in agents", async () => {
    const targetDir = join(dir, ".codex", "agents");
    await mkdir(targetDir, { recursive: true });
    const stalePath = join(targetDir, "code-reviewer.toml");
    await writeFile(
      stalePath,
      `# ${DOTAGENTS_SUBAGENT_MARKER}\nname = "code-reviewer"\n`,
      "utf-8",
    );

    const result = await writeSubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(result.pruned).toEqual([stalePath]);
    expect(existsSync(stalePath)).toBe(false);
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

    const result = await writeSubagentConfigs(["opencode"], [], projectSubagentResolver(dir));

    expect(result.pruned).toEqual([stalePath]);
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

    const result = await writeSubagentConfigs(
      ["claude"],
      [],
      projectSubagentResolver(dir),
      { desiredSubagents: [{ name: "code-reviewer" }] },
    );

    expect(result.pruned).toEqual([stalePath]);
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

  it("reports missing configs as repairable", async () => {
    const issues = await verifySubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("missing");
    expect(issues[0]!.repairable).toBe(true);
  });

  it("reports unmanaged existing configs as not repairable", async () => {
    const targetDir = join(dir, ".claude", "agents");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "code-reviewer.md"), "hand-written", "utf-8");

    const issues = await verifySubagentConfigs(["claude"], [SUBAGENT], projectSubagentResolver(dir));

    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("not managed by dotagents");
    expect(issues[0]!.repairable).toBe(false);
  });

  it("reports unmanaged identity conflicts as not repairable", async () => {
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
    expect(issues[0]!.repairable).toBe(false);
  });
});
