import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalSource, LocalSourceError } from "./local.js";

describe("resolveLocalSource", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-local-"));
    await mkdir(join(root, "skills", "review"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a nested child directory", async () => {
    // The containment check must be separator-agnostic: on Windows `root`
    // uses `\`, so a `${root}/` string prefix would never match this child.
    const resolved = await resolveLocalSource(root, "skills/review");
    expect(resolved).toBe(join(root, "skills", "review"));
  });

  it("resolves the project root itself", async () => {
    expect(await resolveLocalSource(root, ".")).toBe(root);
  });

  it("rejects a parent-traversal path that escapes the root", async () => {
    await expect(resolveLocalSource(root, "../escape")).rejects.toThrow(
      LocalSourceError,
    );
  });

  it("rejects the bare parent directory", async () => {
    // Covers the `rel === ".."` guard specifically — the other traversal cases
    // all produce `..${sep}<child>` and only exercise the startsWith branch.
    await expect(resolveLocalSource(root, "..")).rejects.toThrow(
      /resolves outside project root/,
    );
  });

  it("rejects traversal that dips out and back in", async () => {
    await expect(
      resolveLocalSource(root, "skills/../../elsewhere"),
    ).rejects.toThrow(/resolves outside project root/);
  });

  it("errors when the source does not exist", async () => {
    await expect(resolveLocalSource(root, "skills/missing")).rejects.toThrow(
      /not found/,
    );
  });

  it("errors when the source is a file, not a directory", async () => {
    await writeFile(join(root, "afile.md"), "not a dir\n");
    await expect(resolveLocalSource(root, "afile.md")).rejects.toThrow(
      /not a directory/,
    );
  });
});
