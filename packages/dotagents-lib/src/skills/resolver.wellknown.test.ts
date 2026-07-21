import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureWellKnownCached } from "../sources/wellknown.js";
import { ResolveError, resolveSkill, resolveWildcardSkills } from "./resolver.js";

vi.mock("../sources/wellknown.js", () => ({
  ensureWellKnownCached: vi.fn().mockResolvedValue(null),
}));

const STATE_DIR = "/tmp/dotagents-well-known-test-cache";
const SOURCE = "https://skills.example.com";
const mockedEnsureWellKnownCached = vi.mocked(ensureWellKnownCached);

describe("missing well-known index", () => {
  it("rejects single-skill resolution", async () => {
    await expect(
      resolveSkill("review", { source: SOURCE }, { stateDir: STATE_DIR }),
    ).rejects.toThrow(ResolveError);
  });

  it("returns no wildcard skills", async () => {
    await expect(
      resolveWildcardSkills(
        { source: SOURCE, exclude: [] },
        { stateDir: STATE_DIR },
      ),
    ).resolves.toEqual([]);
  });
});

describe("scoped well-known wildcard", () => {
  it("discovers only skills under path and preserves resolved paths", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "dotagents-well-known-scope-"));
    try {
      await mkdir(join(cacheDir, "engineering", "review"), { recursive: true });
      await writeFile(
        join(cacheDir, "engineering", "review", "SKILL.md"),
        `---\nname: review\ndescription: Review skill\n---\n`,
      );
      await mkdir(join(cacheDir, "engineering", "deploy"), { recursive: true });
      await writeFile(
        join(cacheDir, "engineering", "deploy", "SKILL.md"),
        `---\nname: deploy\ndescription: Deploy skill\n---\n`,
      );
      await mkdir(join(cacheDir, "productivity", "notes"), { recursive: true });
      await writeFile(
        join(cacheDir, "productivity", "notes", "SKILL.md"),
        `---\nname: notes\ndescription: Notes skill\n---\n`,
      );
      mockedEnsureWellKnownCached.mockResolvedValueOnce({ cacheDir });

      const results = await resolveWildcardSkills(
        { source: SOURCE, path: "engineering", exclude: ["deploy"] },
        { stateDir: STATE_DIR },
      );

      expect(results.map((result) => result.name)).toEqual(["review"]);
      expect(results[0]!.resolved).toEqual(expect.objectContaining({
        type: "well-known",
        resolvedPath: "engineering/review",
        skillDir: join(cacheDir, "engineering", "review"),
      }));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
