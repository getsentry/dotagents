import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { fetchWellKnownIndex, ensureWellKnownCached } from "./wellknown.js";

const VALID_INDEX = {
  skills: [
    {
      name: "error-tracking",
      description: "Track errors with Sentry",
      files: ["SKILL.md", "prompt.md"],
    },
    {
      name: "performance",
      description: "Monitor performance",
      files: ["SKILL.md"],
    },
  ],
};

const SKILL_MD_CONTENT = `---
name: error-tracking
description: Track errors with Sentry
---

# Error Tracking
`;

describe("fetchWellKnownIndex", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and parses a valid index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(VALID_INDEX),
      }),
    );

    const index = await fetchWellKnownIndex("https://cli.sentry.dev");
    expect(index).toEqual(VALID_INDEX);
    expect(fetch).toHaveBeenCalledWith(
      "https://cli.sentry.dev/.well-known/skills/index.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("strips trailing slash from base URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(VALID_INDEX),
      }),
    );

    await fetchWellKnownIndex("https://cli.sentry.dev/");
    expect(fetch).toHaveBeenCalledWith(
      "https://cli.sentry.dev/.well-known/skills/index.json",
      expect.anything(),
    );
  });

  it("returns null on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    const index = await fetchWellKnownIndex("https://example.com");
    expect(index).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const index = await fetchWellKnownIndex("https://example.com");
    expect(index).toBeNull();
  });

  it("returns null on invalid JSON shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ not_skills: [] }),
      }),
    );

    const index = await fetchWellKnownIndex("https://example.com");
    expect(index).toBeNull();
  });

  it("returns null when skills entry is missing name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ skills: [{ description: "no name", files: [] }] }),
      }),
    );

    const index = await fetchWellKnownIndex("https://example.com");
    expect(index).toBeNull();
  });

  it("returns null when skills entry is missing files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ skills: [{ name: "test" }] }),
      }),
    );

    const index = await fetchWellKnownIndex("https://example.com");
    expect(index).toBeNull();
  });
});

describe("ensureWellKnownCached", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-wellknown-"));
    stateDir = join(tmpDir, "state");
    process.env["DOTAGENTS_STATE_DIR"] = stateDir;
  });

  afterEach(async () => {
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("fetches index and downloads skill files into cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("index.json")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(VALID_INDEX),
          });
        }
        if (url.endsWith("SKILL.md")) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(SKILL_MD_CONTENT),
          });
        }
        if (url.endsWith("prompt.md")) {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve("Prompt content"),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }),
    );

    const result = await ensureWellKnownCached({
      url: "https://cli.sentry.dev",
      cacheKey: "wellknown/cli.sentry.dev",
    });

    expect(result).not.toBeNull();
    expect(existsSync(join(result!.cacheDir, "error-tracking", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result!.cacheDir, "error-tracking", "prompt.md"))).toBe(true);
    expect(existsSync(join(result!.cacheDir, "performance", "SKILL.md"))).toBe(true);

    const content = await readFile(
      join(result!.cacheDir, "error-tracking", "SKILL.md"),
      "utf-8",
    );
    expect(content).toBe(SKILL_MD_CONTENT);
  });

  it("returns null when fetch fails and no cache exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const result = await ensureWellKnownCached({
      url: "https://cli.sentry.dev",
      cacheKey: "wellknown/cli.sentry.dev",
    });

    expect(result).toBeNull();
  });

  it("uses stale cache when fetch fails", async () => {
    // First call succeeds — populates cache
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("index.json")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(VALID_INDEX),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("content"),
        });
      }),
    );

    const first = await ensureWellKnownCached({
      url: "https://cli.sentry.dev",
      cacheKey: "wellknown/cli.sentry.dev",
      ttlMs: 0, // Force stale
    });
    expect(first).not.toBeNull();

    // Second call fails — should use stale cache
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const second = await ensureWellKnownCached({
      url: "https://cli.sentry.dev",
      cacheKey: "wellknown/cli.sentry.dev",
      ttlMs: 0, // Force stale
    });

    expect(second).not.toBeNull();
    expect(second!.cacheDir).toBe(first!.cacheDir);
  });

  it("returns cached result when not stale", async () => {
    // Populate cache
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("index.json")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(VALID_INDEX),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("content"),
        });
      }),
    );

    await ensureWellKnownCached({
      url: "https://cli.sentry.dev",
      cacheKey: "wellknown/cli.sentry.dev",
    });

    // Reset fetch mock — should NOT be called for the second request
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await ensureWellKnownCached({
      url: "https://cli.sentry.dev",
      cacheKey: "wellknown/cli.sentry.dev",
      ttlMs: 60_000, // 1 minute — cache is fresh
    });

    expect(result).not.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips skills with path-traversal names from remote index", async () => {
    const maliciousIndex = {
      skills: [
        { name: "../../etc/malicious", files: ["SKILL.md"] },
        { name: "../escape", files: ["SKILL.md"] },
        { name: "legit-skill", files: ["SKILL.md"] },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("index.json")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(maliciousIndex),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("content"),
        });
      }),
    );

    const result = await ensureWellKnownCached({
      url: "https://evil.example.com",
      cacheKey: "wellknown/evil.example.com",
    });

    expect(result).not.toBeNull();
    // Malicious names should be skipped
    expect(existsSync(join(result!.cacheDir, "../../etc/malicious"))).toBe(false);
    expect(existsSync(join(result!.cacheDir, "../escape"))).toBe(false);
    // Legit skill should be cached
    expect(existsSync(join(result!.cacheDir, "legit-skill", "SKILL.md"))).toBe(true);
  });

  it("skips files with path-traversal names from remote index", async () => {
    const maliciousIndex = {
      skills: [
        { name: "my-skill", files: ["SKILL.md", "../../../.bashrc", "legit.md"] },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("index.json")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(maliciousIndex),
          });
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve("content"),
        });
      }),
    );

    const result = await ensureWellKnownCached({
      url: "https://evil.example.com",
      cacheKey: "wellknown/evil.example.com",
    });

    expect(result).not.toBeNull();
    // Safe files should be written
    expect(existsSync(join(result!.cacheDir, "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(result!.cacheDir, "my-skill", "legit.md"))).toBe(true);
  });
});
