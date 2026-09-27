import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile, lstat, stat, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const SKILL_MD = `---
name: pdf
description: Test skill pdf
---

# pdf
`;

describe("runInstall user scope", () => {
  let tmpDir: string | undefined;
  const previousHome = process.env["HOME"];
  const previousDotagentsHome = process.env["DOTAGENTS_HOME"];
  const previousStateDir = process.env["DOTAGENTS_STATE_DIR"];
  const previousCopilotHome = process.env["COPILOT_HOME"];

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    if (previousDotagentsHome === undefined) {
      delete process.env["DOTAGENTS_HOME"];
    } else {
      process.env["DOTAGENTS_HOME"] = previousDotagentsHome;
    }
    if (previousStateDir === undefined) {
      delete process.env["DOTAGENTS_STATE_DIR"];
    } else {
      process.env["DOTAGENTS_STATE_DIR"] = previousStateDir;
    }
    if (previousCopilotHome === undefined) {
      delete process.env["COPILOT_HOME"];
    } else {
      process.env["COPILOT_HOME"] = previousCopilotHome;
    }
    vi.resetModules();

    if (tmpDir) {
      await rm(tmpDir, { recursive: true });
      tmpDir = undefined;
    }
  });

  it("installs a user-scope path skill and links it for each user agent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-install-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    const stateDir = join(tmpDir, "state");
    const copilotHome = join(tmpDir, "copilot");
    const sourceDir = join(dotagentsHome, "skill-source", "pdf");

    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = stateDir;
    process.env["COPILOT_HOME"] = copilotHome;
    vi.resetModules();

    const [{ runInstall }, { resolveScope }, { loadLockfile }] = await Promise.all([
      import("./install.js"),
      import("../../scope.js"),
      import("../../lockfile/loader.js"),
    ]);

    await mkdir(sourceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(copilotHome, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), SKILL_MD);
    await writeFile(
      join(homeDir, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          manual: { command: "manual" },
          fixture: { command: "old" },
        },
      }),
    );
    await writeFile(
      join(copilotHome, "mcp-config.json"),
      JSON.stringify({ mcpServers: { manual: { command: "manual" } } }),
    );
    const scope = resolveScope("user");
    await mkdir(scope.root, { recursive: true });
    await writeFile(
      scope.configPath,
      `version = 1
agents = ["claude", "copilot"]

[[skills]]
name = "pdf"
source = "path:skill-source/pdf"

[[mcp]]
name = "fixture"
command = "node"
args = ["server.js"]
`,
    );

    const result = await runInstall({ scope });

    expect(result.installed).toEqual(["pdf"]);
    expect(existsSync(join(scope.skillsDir, "pdf", "SKILL.md"))).toBe(true);
    expect(await readFile(join(scope.skillsDir, "pdf", "SKILL.md"), "utf-8")).toBe(SKILL_MD);

    // Claude Code keeps its own entries in ~/.claude/skills, so each shared skill is linked instead.
    const claudeSkills = join(homeDir, ".claude", "skills");
    expect((await lstat(claudeSkills)).isSymbolicLink()).toBe(false);
    expect(await readlink(join(claudeSkills, "pdf"))).toBe(
      relative(claudeSkills, join(scope.skillsDir, "pdf")),
    );

    expect(result.skillLinkWarnings).toEqual([]);

    const copilotSkillsLink = join(copilotHome, "skills");
    expect((await lstat(copilotSkillsLink)).isSymbolicLink()).toBe(true);
    expect(await readlink(copilotSkillsLink)).toBe(relative(copilotHome, scope.skillsDir));

    expect(JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"))).toEqual({
      theme: "dark",
      mcpServers: {
        manual: { command: "manual" },
        fixture: { command: "node", args: ["server.js"] },
      },
    });
    expect(JSON.parse(await readFile(join(copilotHome, "mcp-config.json"), "utf-8"))).toEqual({
      mcpServers: {
        manual: { command: "manual" },
        fixture: { command: "node", args: ["server.js"] },
      },
    });
    if (process.platform !== "win32") {
      expect((await stat(join(copilotHome, "mcp-config.json"))).mode & 0o777).toBe(0o600);
    }

    const mcpPath = join(homeDir, ".claude.json");
    const beforeEmptyInstall = await readFile(mcpPath, "utf-8");
    await writeFile(
      scope.configPath,
      `version = 1
agents = ["claude", "copilot"]

[[skills]]
name = "pdf"
source = "path:skill-source/pdf"
`,
    );
    await runInstall({ scope });
    expect(await readFile(mcpPath, "utf-8")).toBe(beforeEmptyInstall);

    const lockfile = await loadLockfile(scope.lockPath);
    expect(lockfile!.skills["pdf"]).toEqual({ source: "path:skill-source/pdf" });
  });

  it("sync keeps Claude Code's synced skills out of the shared directory and shares skills it created", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-sync-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runSync }, { resolveScope }, { loadConfig }] = await Promise.all([
      import("./sync.js"),
      import("../../scope.js"),
      import("../../config/loader.js"),
    ]);
    const claudeSkills = join(homeDir, ".claude", "skills");
    const shared = join(dotagentsHome, "skills");
    const skill = async (dir: string, name: string) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "SKILL.md"), SKILL_MD.replace("pdf", name));
    };

    // The earlier layout: ~/.claude/skills linked whole, so Claude Code wrote synced/ into it.
    await skill(shared, "pdf");
    await skill(join(shared, "synced", "bucket"), "docx");
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await symlink(relative(join(homeDir, ".claude"), shared), claudeSkills);
    await writeFile(join(dotagentsHome, "agents.toml"), 'version = 1\nagents = ["claude", "codex"]\n');

    await runSync({ scope: resolveScope("user") });

    expect((await lstat(claudeSkills)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(claudeSkills, "synced", "bucket", "docx", "SKILL.md"))).toBe(true);
    expect(existsSync(join(shared, "synced"))).toBe(false);
    expect((await lstat(join(claudeSkills, "pdf"))).isSymbolicLink()).toBe(true);

    // A skill Claude Code creates in its own directory is shared and declared by the next sync.
    await skill(claudeSkills, "made-in-claude");
    const result = await runSync({ scope: resolveScope("user") });

    expect(result.clientSkillsMoved).toEqual(["made-in-claude"]);
    expect(result.adopted).toContain("made-in-claude");
    expect(existsSync(join(shared, "made-in-claude", "SKILL.md"))).toBe(true);
    expect((await lstat(join(claudeSkills, "made-in-claude"))).isSymbolicLink()).toBe(true);
    const config = await loadConfig(join(dotagentsHome, "agents.toml"));
    expect(config.skills.map((dep) => dep.name).toSorted()).toEqual(["made-in-claude", "pdf"]);


    // A skill created in Claude with the name of a stale managed skill still recorded in the lock
    // file stays in Claude's directory, across repeated runs, until install clears the record.
    const { writeLockfile } = await import("../../lockfile/writer.js");
    const { loadLockfile } = await import("../../lockfile/loader.js");
    const lock = await loadLockfile(join(dotagentsHome, "agents.lock"));
    await writeLockfile(join(dotagentsHome, "agents.lock"), {
      ...lock!,
      skills: { ...lock!.skills, reused: { source: "org/repo", resolved_url: "https://github.com/org/repo.git", resolved_path: "reused" } },
    });
    await skill(claudeSkills, "reused");
    for (let run = 0; run < 2; run++) {
      const kept = await runSync({ scope: resolveScope("user") });
      expect(kept.issues.map((issue) => issue.message).join("\n")).toContain("still records a managed skill");
      expect(await readFile(join(claudeSkills, "reused", "SKILL.md"), "utf-8")).toContain("name: reused");
      expect(existsSync(join(shared, "reused"))).toBe(false);
    }

    const { runInstall } = await import("./install.js");
    await runInstall({ scope: resolveScope("user") });
    await runSync({ scope: resolveScope("user") });
    expect(await readFile(join(shared, "reused", "SKILL.md"), "utf-8")).toContain("name: reused");
    expect((await lstat(join(claudeSkills, "reused"))).isSymbolicLink()).toBe(true);
  });

  it("warns when Claude Code already has its own copy of an installed skill", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-install-conflict-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runInstall }, { resolveScope }] = await Promise.all([
      import("./install.js"),
      import("../../scope.js"),
    ]);
    const sourceDir = join(dotagentsHome, "skill-source", "pdf");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), SKILL_MD);
    await mkdir(join(homeDir, ".claude", "skills", "pdf"), { recursive: true });
    await writeFile(join(homeDir, ".claude", "skills", "pdf", "SKILL.md"), SKILL_MD);
    const scope = resolveScope("user");
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n\n[[skills]]\nname = "pdf"\nsource = "path:skill-source/pdf"\n');

    const result = await runInstall({ scope });

    expect(result.skillLinkWarnings.map((w) => w.name)).toEqual(["pdf"]);
    expect((await lstat(join(homeDir, ".claude", "skills", "pdf"))).isDirectory()).toBe(true);
  });

  it("sync leaves a Claude Code skill alone when a declared skill of that name is missing", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-sync-declared-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runSync }, { resolveScope }] = await Promise.all([
      import("./sync.js"),
      import("../../scope.js"),
    ]);
    const claudeSkills = join(homeDir, ".claude", "skills");
    await mkdir(join(claudeSkills, "pdf"), { recursive: true });
    await writeFile(join(claudeSkills, "pdf", "SKILL.md"), SKILL_MD);
    await mkdir(join(dotagentsHome, "skills"), { recursive: true });
    await writeFile(join(dotagentsHome, "agents.toml"), 'version = 1\nagents = ["claude"]\n\n[[skills]]\nname = "pdf"\nsource = "getsentry/skills"\n');

    const result = await runSync({ scope: resolveScope("user") });

    expect(result.clientSkillsMoved).toEqual([]);
    expect((await lstat(join(claudeSkills, "pdf"))).isDirectory()).toBe(true);
    expect(existsSync(join(dotagentsHome, "skills", "pdf"))).toBe(false);
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("has the name of a skill declared in agents.toml that is not installed");
  });

  it("install links shared skills but leaves a skill Claude Code created for sync to share", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-install-no-adopt-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runInstall }, { resolveScope }] = await Promise.all([
      import("./install.js"),
      import("../../scope.js"),
    ]);
    const claudeSkills = join(homeDir, ".claude", "skills");
    await mkdir(join(claudeSkills, "pdf"), { recursive: true });
    await writeFile(join(claudeSkills, "pdf", "SKILL.md"), SKILL_MD);
    const scope = resolveScope("user");
    await mkdir(scope.skillsDir, { recursive: true });
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n');

    await runInstall({ scope });

    expect((await lstat(join(claudeSkills, "pdf"))).isDirectory()).toBe(true);
    expect(existsSync(join(scope.skillsDir, "pdf"))).toBe(false);
  });

  it("init leaves a Claude Code skill in place when a declared skill has that name", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-init-declared-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runInit }, { resolveScope }] = await Promise.all([
      import("./init.js"),
      import("../../scope.js"),
    ]);
    const claudeSkills = join(homeDir, ".claude", "skills");
    await mkdir(join(claudeSkills, "dotagents"), { recursive: true });
    await writeFile(join(claudeSkills, "dotagents", "SKILL.md"), "---\nname: dotagents\ndescription: Local copy\n---\n");
    const runInstallStub = vi.fn(async () => ({
      installed: [],
      installedPlugins: [],
      pruned: [],
      prunedPlugins: [],
      mcpWarnings: [],
      hookWarnings: [],
      subagentWarnings: [],
      pluginWarnings: [],
      skillLinkWarnings: [],
    }));

    await mkdir(join(dotagentsHome, "skills", "synced", "old"), { recursive: true });
    await mkdir(join(claudeSkills, "synced", "new"), { recursive: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let printed = "";

    try {
      await runInit({ scope: resolveScope("user"), agents: ["claude"], services: { runInstall: runInstallStub } });
      printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(printed).toContain(`${join(claudeSkills, "dotagents")} is not a link to`);
    expect(printed).toMatch(/synced was also in .*, so the shared copy moved to .*\.client-owned-backup/);

    expect(await readFile(join(claudeSkills, "dotagents", "SKILL.md"), "utf-8")).toContain("Local copy");
    expect((await lstat(join(claudeSkills, "dotagents"))).isDirectory()).toBe(true);
    expect(existsSync(join(dotagentsHome, "skills", "dotagents"))).toBe(false);
  });

  it("install reports where a duplicate synced/ from the shared directory was moved", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-install-set-aside-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runInstall }, { resolveScope }] = await Promise.all([
      import("./install.js"),
      import("../../scope.js"),
    ]);
    const scope = resolveScope("user");
    await mkdir(join(scope.skillsDir, "synced", "old"), { recursive: true });
    await mkdir(join(homeDir, ".claude", "skills", "synced", "new"), { recursive: true });
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n');

    const result = await runInstall({ scope });

    expect(result.skillLinkWarnings).toEqual([
      { name: "synced", message: expect.stringContaining(join(dotagentsHome, ".client-owned-backup", "synced-")) },
    ]);
    expect(existsSync(join(homeDir, ".claude", "skills", "synced", "new"))).toBe(true);
  });

  it("doctor --fix links shared skills and leaves unshared Claude Code skills to sync", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-doctor-links-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runDoctor }, { resolveScope }] = await Promise.all([
      import("./doctor.js"),
      import("../../scope.js"),
    ]);
    const scope = resolveScope("user");
    const claudeSkills = join(homeDir, ".claude", "skills");
    await mkdir(join(scope.skillsDir, "review"), { recursive: true });
    await writeFile(join(scope.skillsDir, "review", "SKILL.md"), SKILL_MD);
    await mkdir(join(claudeSkills, "draft"), { recursive: true });
    await writeFile(join(claudeSkills, "draft", "SKILL.md"), SKILL_MD);
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n');

    const before = await runDoctor({ scope, fix: true });
    expect(before.checks.find((c) => c.name === "skill links")?.status).toBe("ok");

    expect((await lstat(join(claudeSkills, "review"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(claudeSkills, "draft"))).isDirectory()).toBe(true);
    const after = await runDoctor({ scope });
    expect(after.checks.find((c) => c.name === "skill links")?.status).toBe("ok");
    expect(after.checks.find((c) => c.name === "unshared skills")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("draft"),
    });
  });

  it("doctor --fix prints where it set aside a duplicate synced/", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-doctor-set-aside-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runDoctor }, { resolveScope }] = await Promise.all([
      import("./doctor.js"),
      import("../../scope.js"),
    ]);
    const scope = resolveScope("user");
    await mkdir(join(scope.skillsDir, "synced", "old"), { recursive: true });
    await mkdir(join(homeDir, ".claude", "skills", "synced", "new"), { recursive: true });
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n');
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let printed = "";

    try {
      await runDoctor({ scope, fix: true });
      printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      log.mockRestore();
    }

    expect(printed).toContain(join(dotagentsHome, ".client-owned-backup", "synced-"));
    expect(existsSync(join(scope.skillsDir, "synced"))).toBe(false);
  });

  it("sync does not share a Claude Code skill under a name it prunes in the same run", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-sync-pruned-name-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runSync }, { resolveScope }, { writeLockfile }] = await Promise.all([
      import("./sync.js"),
      import("../../scope.js"),
      import("../../lockfile/writer.js"),
    ]);
    const scope = resolveScope("user");
    const claudeSkills = join(homeDir, ".claude", "skills");
    await mkdir(join(scope.skillsDir, "bar"), { recursive: true });
    await writeFile(join(scope.skillsDir, "bar", "SKILL.md"), SKILL_MD);
    await mkdir(join(claudeSkills, "bar"), { recursive: true });
    await writeFile(join(claudeSkills, "bar", "SKILL.md"), SKILL_MD);
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n');
    await writeLockfile(scope.lockPath, { version: 1, skills: { bar: { source: "org/repo", resolved_url: "https://github.com/org/repo.git", resolved_path: "bar" } } });

    const result = await runSync({ scope });

    expect(result.pruned).toEqual(["bar"]);
    expect((await lstat(join(claudeSkills, "bar"))).isDirectory()).toBe(true);
    expect(existsSync(join(scope.skillsDir, "bar"))).toBe(false);

    const next = await runSync({ scope });
    expect(next.clientSkillsMoved).toEqual(["bar"]);
    expect(next.adopted).toEqual(["bar"]);
  });

  it("sync removes a synced declaration an earlier version wrote, and install then succeeds", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-legacy-synced-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = join(tmpDir, "state");
    vi.resetModules();

    const [{ runSync }, { runInstall }, { resolveScope }, { writeLockfile }, { loadConfig }] = await Promise.all([
      import("./sync.js"),
      import("./install.js"),
      import("../../scope.js"),
      import("../../lockfile/writer.js"),
      import("../../config/loader.js"),
    ]);
    const scope = resolveScope("user");
    const claudeSkills = join(homeDir, ".claude", "skills");
    await mkdir(join(scope.skillsDir, "synced", "account", "pdf"), { recursive: true });
    await writeFile(join(scope.skillsDir, "synced", "account", "pdf", "SKILL.md"), SKILL_MD);
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await symlink(scope.skillsDir, claudeSkills);
    await writeFile(scope.configPath, 'version = 1\nagents = ["claude"]\n\n[[skills]]\nname = "synced"\nsource = "path:skills/synced"\n');
    await writeLockfile(scope.lockPath, { version: 1, skills: { synced: { source: "path:skills/synced" } } });

    const beforeSync = await runInstall({ scope });
    expect(beforeSync.skillLinkWarnings.map((w) => w.message).join("\n")).toContain("run 'npx @sentry/dotagents sync' to remove that declaration");
    expect(existsSync(join(scope.skillsDir, "synced", "account", "pdf", "SKILL.md"))).toBe(true);

    await runSync({ scope });

    expect((await loadConfig(scope.configPath)).skills.map((dep) => dep.name)).toEqual([]);
    expect(existsSync(join(claudeSkills, "synced", "account", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(scope.skillsDir, "synced"))).toBe(false);
    await expect(runInstall({ scope })).resolves.toMatchObject({ skillLinkWarnings: [] });
  });
});
