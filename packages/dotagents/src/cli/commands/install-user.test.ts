import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile, lstat, stat } from "node:fs/promises";
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

  it("installs a user-scope path skill and writes the user agent skill symlink", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-install-"));
    const homeDir = join(tmpDir, "home");
    const dotagentsHome = join(tmpDir, "agents");
    const stateDir = join(tmpDir, "state");
    const sourceDir = join(dotagentsHome, "skill-source", "pdf");

    process.env["HOME"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = stateDir;
    vi.resetModules();

    const [{ runInstall }, { resolveScope }, { loadLockfile }] = await Promise.all([
      import("./install.js"),
      import("../../scope.js"),
      import("../../lockfile/loader.js"),
    ]);

    await mkdir(sourceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
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
    const scope = resolveScope("user");
    await mkdir(scope.root, { recursive: true });
    await writeFile(
      scope.configPath,
      `version = 1
agents = ["claude"]

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

    const skillsLink = join(homeDir, ".claude", "skills");
    const skillsLinkStat = await lstat(skillsLink);
    expect(skillsLinkStat.isSymbolicLink()).toBe(true);
    expect(await readlink(skillsLink)).toBe(relative(join(homeDir, ".claude"), scope.skillsDir));

    expect(JSON.parse(await readFile(join(homeDir, ".claude.json"), "utf-8"))).toEqual({
      theme: "dark",
      mcpServers: {
        manual: { command: "manual" },
        fixture: { command: "node", args: ["server.js"] },
      },
    });

    const mcpPath = join(homeDir, ".claude.json");
    const beforeEmptyInstall = await readFile(mcpPath, "utf-8");
    await writeFile(
      scope.configPath,
      `version = 1
agents = ["claude"]

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

  it("writes copilot MCP config without a skill symlink", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-user-copilot-"));
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

    const [{ runInstall }, { resolveScope }] = await Promise.all([
      import("./install.js"),
      import("../../scope.js"),
    ]);

    await mkdir(sourceDir, { recursive: true });
    await mkdir(copilotHome, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), SKILL_MD);
    await writeFile(
      join(copilotHome, "mcp-config.json"),
      JSON.stringify({
        note: "keep",
        mcpServers: {
          manual: { command: "manual", args: [] },
          fixture: { command: "old", args: [] },
        },
      }),
    );

    const scope = resolveScope("user");
    await mkdir(scope.root, { recursive: true });
    await writeFile(
      scope.configPath,
      `version = 1
agents = ["copilot"]

[[skills]]
name = "pdf"
source = "path:skill-source/pdf"

[[mcp]]
name = "fixture"
command = "node"
args = ["server.js"]
`,
    );

    await runInstall({ scope });

    expect(existsSync(join(scope.skillsDir, "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(join(copilotHome, "skills"))).toBe(false);
    expect(JSON.parse(await readFile(join(copilotHome, "mcp-config.json"), "utf-8"))).toEqual({
      note: "keep",
      mcpServers: {
        manual: { command: "manual", args: [] },
        fixture: { command: "node", args: ["server.js"] },
      },
    });
    if (process.platform !== "win32") {
      expect((await stat(join(copilotHome, "mcp-config.json"))).mode & 0o777).toBe(0o600);
    }
  });
});
