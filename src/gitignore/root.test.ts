import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureRootGitignoreEntry } from "./root.js";

describe("ensureRootGitignoreEntry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it("creates .gitignore when missing", async () => {
    const modified = await ensureRootGitignoreEntry(dir);

    expect(modified).toBe(true);
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toBe(".agents/.gitignore\n");
  });

  it("appends to existing file", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf-8");

    const modified = await ensureRootGitignoreEntry(dir);

    expect(modified).toBe(true);
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n.agents/.gitignore\n");
  });

  it("is a no-op when entry already present", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/\n.agents/.gitignore\n", "utf-8");

    const modified = await ensureRootGitignoreEntry(dir);

    expect(modified).toBe(false);
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n.agents/.gitignore\n");
  });

  it("preserves existing content", async () => {
    const existing = "# My project\nnode_modules/\ndist/\n";
    await writeFile(join(dir, ".gitignore"), existing, "utf-8");

    await ensureRootGitignoreEntry(dir);

    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("# My project");
    expect(content).toContain("node_modules/");
    expect(content).toContain("dist/");
    expect(content).toContain(".agents/.gitignore");
  });

  it("handles files without trailing newline", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules/", "utf-8");

    const modified = await ensureRootGitignoreEntry(dir);

    expect(modified).toBe(true);
    const content = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\n.agents/.gitignore\n");
  });
});
