import { describe, expect, it, vi } from "vitest";
import { ResolveError, resolveSkill, resolveWildcardSkills } from "./resolver.js";

const ensureWellKnownCached = vi.fn(async () => null);

const STATE_DIR = "/tmp/dotagents-well-known-test-cache";
const SOURCE = "https://skills.example.com";

describe("missing well-known index", () => {
  it("rejects single-skill resolution", async () => {
    await expect(
      resolveSkill("review", { source: SOURCE }, {
        stateDir: STATE_DIR,
        services: { ensureWellKnownCached },
      }),
    ).rejects.toThrow(ResolveError);
  });

  it("returns no wildcard skills", async () => {
    await expect(
      resolveWildcardSkills(
        { source: SOURCE, exclude: [] },
        { stateDir: STATE_DIR, services: { ensureWellKnownCached } },
      ),
    ).resolves.toEqual([]);
  });
});

describe("scoped well-known wildcard", () => {
  it("rejects scoped well-known sources", async () => {
    await expect(
      resolveWildcardSkills(
        { source: SOURCE, path: "engineering", exclude: [] },
        { stateDir: STATE_DIR },
      ),
    ).rejects.toThrow(/not supported for well-known sources/);
  });
});
