import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import {
  projectHookResolver,
  reconcileHookConfigs,
  toHookDeclarations,
  verifyHookConfigs,
  writeHookConfigs,
} from "./hook-writer.js";
import type { HookDeclaration } from "./types.js";
import type { HookConfig } from "../config/schema.js";
import { isSerializedObject } from "@sentry/dotagents-lib";

const HOOKS: HookDeclaration[] = [
  { event: "PreToolUse", matcher: "Bash", command: ".agents/hooks/block-rm.sh" },
  { event: "Stop", command: ".agents/hooks/check-tests.sh" },
];

describe("toHookDeclarations", () => {
  it("converts HookConfig entries to HookDeclarations", () => {
    const configs: HookConfig[] = [
      { event: "PreToolUse", matcher: "Bash", command: ".agents/hooks/block-rm.sh" },
      { event: "Stop", command: ".agents/hooks/check-tests.sh" },
    ];
    const decls = toHookDeclarations(configs);
    expect(decls).toEqual(HOOKS);
  });

  it("omits matcher when not present", () => {
    const configs: HookConfig[] = [{ event: "Stop", command: "test.sh" }];
    const decls = toHookDeclarations(configs);
    expect(decls[0]).toEqual({ event: "Stop", command: "test.sh" });
    expect("matcher" in decls[0]!).toBe(false);
  });
});

describe("writeHookConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-hooks-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("preserves the legacy empty-input no-op", async () => {
    const filePath = join(dir, ".cursor", "hooks.json");
    const content = '{"version":1,"hooks":{"stop":[]}}';
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(filePath, content);

    const warnings = await writeHookConfigs(["cursor"], [], projectHookResolver(dir));
    expect(warnings).toEqual([]);
    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("writes claude .claude/settings.json", async () => {
    await writeHookConfigs(["claude"], HOOKS, projectHookResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf-8"));
    expect(content.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: ".agents/hooks/block-rm.sh" }] },
    ]);
    expect(content.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: ".agents/hooks/check-tests.sh" }] },
    ]);
  });

  it("writes cursor .cursor/hooks.json with version field", async () => {
    await writeHookConfigs(["cursor"], HOOKS, projectHookResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".cursor", "hooks.json"), "utf-8"));
    expect(content.version).toBe(1);
    expect(content.hooks.beforeShellExecution).toEqual([
      { command: ".agents/hooks/block-rm.sh" },
    ]);
    expect(content.hooks.beforeMCPExecution).toEqual([
      { command: ".agents/hooks/block-rm.sh" },
    ]);
    expect(content.hooks.stop).toEqual([
      { command: ".agents/hooks/check-tests.sh" },
    ]);
  });

  it("cursor drops matcher", async () => {
    await writeHookConfigs(["cursor"], HOOKS, projectHookResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".cursor", "hooks.json"), "utf-8"));
    if (!isSerializedObject(content) || !isSerializedObject(content["hooks"])) {
      throw new Error("expected serialized cursor hooks");
    }
    // Cursor hooks should not contain matcher
    for (const entries of Object.values(content["hooks"])) {
      if (!Array.isArray(entries)) {throw new Error("expected cursor hook entries");}
      for (const entry of entries) {
        expect(entry).not.toHaveProperty("matcher");
      }
    }
  });

  it("writes vscode to same .claude/settings.json as claude", async () => {
    await writeHookConfigs(["vscode"], HOOKS, projectHookResolver(dir));

    const content = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf-8"));
    expect(content.hooks.PreToolUse).toBeDefined();
  });

  it("deduplicates shared file between claude and vscode", async () => {
    await writeHookConfigs(["claude", "vscode"], HOOKS, projectHookResolver(dir));

    // Should only write once — both target .claude/settings.json
    const content = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf-8"));
    expect(content.hooks.PreToolUse).toHaveLength(1);
  });

  it("returns warnings for unsupported agents", async () => {
    const warnings = await writeHookConfigs(["codex", "opencode"], HOOKS, projectHookResolver(dir));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.agent).toBe("codex");
    expect(warnings[1]!.agent).toBe("opencode");
    expect(warnings[0]!.message).toContain("does not support");
  });

  it("writes supported agents and warns for unsupported ones", async () => {
    const warnings = await writeHookConfigs(["claude", "codex"], HOOKS, projectHookResolver(dir));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.agent).toBe("codex");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
  });

  it("merges into existing shared config file", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2),
      "utf-8",
    );

    await writeHookConfigs(["claude"], HOOKS, projectHookResolver(dir));

    const content = JSON.parse(await readFile(join(claudeDir, "settings.json"), "utf-8"));
    expect(content.permissions).toEqual({ allow: ["Read"] });
    expect(content.hooks).toBeDefined();
  });

  it("is idempotent", async () => {
    await writeHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    const first = await readFile(join(dir, ".claude", "settings.json"), "utf-8");

    await writeHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    const second = await readFile(join(dir, ".claude", "settings.json"), "utf-8");

    expect(first).toBe(second);
  });

  it("handles multiple agents including cursor", async () => {
    await writeHookConfigs(["claude", "cursor"], HOOKS, projectHookResolver(dir));

    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".cursor", "hooks.json"))).toBe(true);
  });
});

describe("verifyHookConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-hooks-verify-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("returns no issues when configs match", async () => {
    await writeHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    const issues = await verifyHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    expect(issues).toEqual([]);
  });

  it("reports missing config file", async () => {
    const issues = await verifyHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("missing");
  });

  it("skips unsupported agents without reporting issues", async () => {
    const issues = await verifyHookConfigs(["codex"], HOOKS, projectHookResolver(dir));
    expect(issues).toEqual([]);
  });

  it("preserves the legacy empty-input no-op", async () => {
    const filePath = join(dir, ".cursor", "hooks.json");
    const content = '{"version":1,"hooks":{"stop":[]}}';
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(filePath, content);

    const issues = await verifyHookConfigs(["claude"], [], projectHookResolver(dir));
    expect(issues).toEqual([]);
    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("reports missing hooks key", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({ permissions: {} }, null, 2),
      "utf-8",
    );

    const issues = await verifyHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.issue).toContain("drifted");
  });

  it("reports a non-object document instead of throwing", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.json"), "null\n");

    const issues = await verifyHookConfigs(["claude"], HOOKS, projectHookResolver(dir));
    expect(issues).toEqual([{
      agent: "claude",
      issue: `Failed to read hook config: ${join(claudeDir, "settings.json")}`,
    }]);
  });
});

describe("reconcileHookConfigs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-hooks-reconcile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("repairs shared hook drift while preserving unrelated settings", async () => {
    const filePath = join(dir, ".claude", "settings.json");
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "old.sh" }] }],
      },
    }));

    const inspected = await reconcileHookConfigs(
      ["claude"],
      HOOKS,
      projectHookResolver(dir),
      "inspect",
    );
    expect(inspected.issues).toEqual([{
      agent: "claude",
      issue: `Hook config drifted: ${filePath}`,
    }]);
    expect(inspected.written).toEqual([]);

    const applied = await reconcileHookConfigs(
      ["claude"],
      HOOKS,
      projectHookResolver(dir),
      "apply",
    );
    expect(applied.written).toEqual([filePath]);
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
      permissions: { allow: ["Read"] },
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: ".agents/hooks/block-rm.sh" }],
        }],
        Stop: [{ hooks: [{ type: "command", command: ".agents/hooks/check-tests.sh" }] }],
      },
    });
  });

  it("repairs Cursor event mapping and dedicated document fields", async () => {
    const filePath = join(dir, ".cursor", "hooks.json");
    await mkdir(join(dir, ".cursor"), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      version: 2,
      hooks: { beforeShellExecution: [{ command: "old.sh" }] },
    }));

    const result = await reconcileHookConfigs(
      ["cursor"],
      HOOKS,
      projectHookResolver(dir),
      "apply",
    );

    expect(result.written).toEqual([filePath]);
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: ".agents/hooks/block-rm.sh" }],
        beforeMCPExecution: [{ command: ".agents/hooks/block-rm.sh" }],
        stop: [{ command: ".agents/hooks/check-tests.sh" }],
      },
    });
  });

  it.each(["inspect", "apply"] as const)(
    "leaves an existing shared hook root unchanged in %s mode when no hooks are declared",
    async (mode) => {
      const filePath = join(dir, ".claude", "settings.json");
      await mkdir(join(dir, ".claude"), { recursive: true });
      const content = JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "project-owned.sh" }] }] },
      });
      await writeFile(filePath, content);

      const result = await reconcileHookConfigs(
        ["claude", "vscode"],
        [],
        projectHookResolver(dir),
        mode,
      );

      expect(result).toEqual({ issues: [], warnings: [], written: [], removed: [] });
      expect(await readFile(filePath, "utf-8")).toBe(content);
    },
  );

  it("leaves an existing dedicated Cursor hook file unchanged when no hooks are declared", async () => {
    const filePath = join(dir, ".cursor", "hooks.json");
    await mkdir(join(dir, ".cursor"), { recursive: true });
    const content = JSON.stringify({ version: 1, hooks: { stop: [{ command: "project-owned.sh" }] } });
    await writeFile(filePath, content);

    const result = await reconcileHookConfigs(
      ["cursor"],
      [],
      projectHookResolver(dir),
      "apply",
    );

    expect(result).toEqual({ issues: [], warnings: [], written: [], removed: [] });
    expect(await readFile(filePath, "utf-8")).toBe(content);
  });

  it("returns unsupported-agent warnings separately from drift", async () => {
    const result = await reconcileHookConfigs(
      ["claude", "codex"],
      HOOKS,
      projectHookResolver(dir),
      "inspect",
    );

    expect(result.issues).toEqual([{
      agent: "claude",
      issue: `Hook config missing: ${join(dir, ".claude", "settings.json")}`,
    }]);
    expect(result.warnings).toEqual([{
      agent: "codex",
      message: 'Agent "Codex" does not support hooks',
    }]);
  });
});
