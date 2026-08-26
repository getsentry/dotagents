import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeLockfile } from "./writer.js";
import { loadLockfile } from "./loader.js";

describe("writeLockfile + loadLockfile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("round-trips and sorts every lockfile entry type", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "z-git": {
          source: "anthropics/skills",
          resolved_url: "https://github.com/anthropics/skills.git",
          resolved_path: "z-git",
          resolved_ref: "v1.2.0",
        },
        "a-local": {
          source: "path:../shared/a-local",
          resolved_path: "engineering/a-local",
        },
      },
      subagents: {
        "z-reviewer": { source: "org/z-repo" },
        "a-reviewer": { source: "org/a-repo" },
      },
      plugins: {
        "z-plugin": { source: "org/z-repo" },
        "a-plugin": { source: "org/a-repo" },
      },
    });

    const loaded = await loadLockfile(lockPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(Object.keys(loaded!.skills)).toEqual(["a-local", "z-git"]);
    expect(Object.keys(loaded!.subagents)).toEqual(["a-reviewer", "z-reviewer"]);
    expect(Object.keys(loaded!.plugins)).toEqual(["a-plugin", "z-plugin"]);
    expect(loaded!.skills["a-local"]).toEqual({
      source: "path:../shared/a-local",
      resolved_path: "engineering/a-local",
    });
    expect(loaded!.skills["z-git"]).toEqual({
      source: "anthropics/skills",
      resolved_url: "https://github.com/anthropics/skills.git",
      resolved_path: "z-git",
      resolved_ref: "v1.2.0",
    });
  });

  it("omits empty optional entry sections", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {},
      subagents: {},
      plugins: {},
    });

    const content = await readFile(lockPath, "utf-8");
    expect(content).not.toContain("[subagents]");
    expect(content).not.toContain("[plugins]");
    expect(await loadLockfile(lockPath)).toEqual({
      version: 1,
      skills: {},
      subagents: {},
      plugins: {},
    });
  });

  it("ends with exactly one trailing newline", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: { "test-skill": { source: "org/repo" } },
    });

    expect(await readFile(lockPath, "utf-8")).toMatch(/[^\n]\n$/);
  });

  it("returns null for a missing lockfile", async () => {
    await expect(loadLockfile(join(dir, "nope.lock"))).resolves.toBeNull();
  });
});
