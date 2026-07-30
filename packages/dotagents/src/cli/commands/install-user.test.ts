import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";

const SKILL_MD = `---
name: pdf
description: Test skill pdf
---

# pdf
`;

describe("runInstall user scope", () => {
  let tmpDir: string | undefined;
  // USERPROFILE matters as much as HOME: on Windows `os.homedir()` reads
  // USERPROFILE and ignores HOME, so overriding HOME alone leaves the target
  // definitions pointing at the developer's real home.
  const previousEnv = {
    HOME: process.env["HOME"],
    USERPROFILE: process.env["USERPROFILE"],
    DOTAGENTS_HOME: process.env["DOTAGENTS_HOME"],
    DOTAGENTS_STATE_DIR: process.env["DOTAGENTS_STATE_DIR"],
  };

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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
    process.env["USERPROFILE"] = homeDir;
    process.env["DOTAGENTS_HOME"] = dotagentsHome;
    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Hard stop before anything touches the filesystem. The agent target
    // definitions resolve user dirs from `os.homedir()` at module load, and
    // runInstall *moves* an existing skills directory aside (rename) and then
    // deletes it. If this sandbox ever fails again, that destroys the real
    // ~/.claude/skills — fail the test instead of the developer's machine.
    expect(homedir()).toBe(homeDir);

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
    const stat = await lstat(skillsLink);
    expect(stat.isSymbolicLink()).toBe(true);
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
});
