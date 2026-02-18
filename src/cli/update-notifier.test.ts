import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareSemver, formatUpdateMessage, checkForUpdate } from "./update-notifier.js";

describe("compareSemver", () => {
  it("returns positive when b is newer", () => {
    expect(compareSemver("0.7.0", "0.8.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.2.0")).toBeGreaterThan(0);
  });

  it("returns negative when a is newer", () => {
    expect(compareSemver("0.8.0", "0.7.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.0.0")).toBeLessThan(0);
  });

  it("returns zero when versions are equal", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.7.0", "0.7.0")).toBe(0);
  });

  it("compares major before minor before patch", () => {
    expect(compareSemver("1.9.9", "2.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.9", "1.1.0")).toBeGreaterThan(0);
  });
});

describe("formatUpdateMessage", () => {
  it("includes both versions and upgrade command", () => {
    const msg = formatUpdateMessage("0.7.0", "0.8.0");
    expect(msg).toContain("0.7.0");
    expect(msg).toContain("0.8.0");
    expect(msg).toContain("npm install -g @sentry/dotagents");
  });

  it("contains the arrow separator", () => {
    const msg = formatUpdateMessage("1.0.0", "2.0.0");
    expect(msg).toContain("\u2192");
  });
});

describe("checkForUpdate", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "dotagents-update-"));
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cacheDir, { recursive: true });
  });

  it("returns null when fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network error"));
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toBeNull();
  });

  it("returns null when fetch returns non-ok status", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response);
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toBeNull();
  });

  it("returns null when already on the latest version", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.7.0" }),
    } as Response);
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toBeNull();
  });

  it("returns null when on a newer version than registry", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.6.0" }),
    } as Response);
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toBeNull();
  });

  it("returns a message when a newer version exists", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.8.0" }),
    } as Response);
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).not.toBeNull();
    expect(result).toContain("0.7.0");
    expect(result).toContain("0.8.0");
  });

  it("returns null when registry returns invalid json shape", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ name: "no-version-field" }),
    } as Response);
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toBeNull();
  });

  it("uses cached version when cache is fresh", async () => {
    // Write a fresh cache file
    await writeFile(
      join(cacheDir, "update-check.json"),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: "0.9.0" }),
    );
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toContain("0.9.0");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches when cache is stale", async () => {
    // Write a stale cache (> 24h old)
    await writeFile(
      join(cacheDir, "update-check.json"),
      JSON.stringify({ lastCheck: Date.now() - 25 * 60 * 60 * 1000, latestVersion: "0.8.0" }),
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.9.0" }),
    } as Response);
    const result = await checkForUpdate("0.7.0", { cacheDir });
    expect(result).toContain("0.9.0");
    expect(fetch).toHaveBeenCalled();
  });
});
