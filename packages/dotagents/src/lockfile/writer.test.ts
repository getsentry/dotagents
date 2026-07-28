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

  it("round-trips a lockfile with git skills", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "pdf-processing": {
          source: "anthropics/skills",
          resolved_url: "https://github.com/anthropics/skills.git",
          resolved_path: "pdf-processing",
          resolved_ref: "v1.2.0",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.skills["pdf-processing"]?.source).toBe("anthropics/skills");
  });

  it("round-trips a lockfile with local skills", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "my-skill": {
          source: "path:../shared/my-skill",
          resolved_path: "engineering/my-skill",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    expect(loaded!.skills["my-skill"]?.source).toBe("path:../shared/my-skill");
    expect(loaded!.skills["my-skill"]).toEqual({
      source: "path:../shared/my-skill",
      resolved_path: "engineering/my-skill",
    });
  });

  it("sorts skills alphabetically", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "z-skill": {
          source: "path:z-skill",
        },
        "a-skill": {
          source: "path:a-skill",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    const keys = Object.keys(loaded!.skills);
    expect(keys).toEqual(["a-skill", "z-skill"]);
  });

  it("sorts subagents alphabetically", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {},
      subagents: {
        "z-reviewer": {
          source: "org/z-repo",
        },
        "a-reviewer": {
          source: "org/a-repo",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    const keys = Object.keys(loaded!.subagents);
    expect(keys).toEqual(["a-reviewer", "z-reviewer"]);
  });

  it("omits empty subagents from the serialized lockfile", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {},
      subagents: {},
    });

    const content = await readFile(lockPath, "utf-8");
    expect(content).not.toContain("[subagents]");

    const loaded = await loadLockfile(lockPath);
    expect(loaded!.subagents).toEqual({});
  });

  it("ends with exactly one trailing newline", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "test-skill": {
          source: "org/repo",
        },
      },
    });

    const content = await readFile(lockPath, "utf-8");
    expect(content).toMatch(/[^\n]\n$/);
  });

  it("returns null for missing lockfile", async () => {
    const result = await loadLockfile(join(dir, "nope.lock"));
    expect(result).toBeNull();
  });
});
