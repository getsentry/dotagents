import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
          commit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          integrity: "sha256-test123",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.skills["pdf-processing"]?.integrity).toBe("sha256-test123");
  });

  it("round-trips a lockfile with local skills", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "my-skill": {
          source: "path:../shared/my-skill",
          integrity: "sha256-localtest",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    expect(loaded!.skills["my-skill"]?.source).toBe("path:../shared/my-skill");
  });

  it("sorts skills alphabetically", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "z-skill": {
          source: "org/z-repo",
          integrity: "sha256-z",
        },
        "a-skill": {
          source: "org/a-repo",
          integrity: "sha256-a",
        },
      },
    });

    const loaded = await loadLockfile(lockPath);
    const keys = Object.keys(loaded!.skills);
    expect(keys).toEqual(["a-skill", "z-skill"]);
  });

  it("ends with exactly one trailing newline", async () => {
    const lockPath = join(dir, "agents.lock");
    await writeLockfile(lockPath, {
      version: 1,
      skills: {
        "test-skill": {
          source: "org/repo",
          integrity: "sha256-abc",
        },
      },
    });

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(lockPath, "utf-8");
    expect(content).toMatch(/[^\n]\n$/);
  });

  it("returns null for missing lockfile", async () => {
    const result = await loadLockfile(join(dir, "nope.lock"));
    expect(result).toBeNull();
  });
});
