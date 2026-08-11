import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectPostMergeHook,
  installPostMergeHook,
  updateManagedPostMergeHook,
} from "./post-merge-hook.js";

const LEGACY_BLOCK = `# dotagents:post-merge
if command -v dotagents >/dev/null 2>&1; then
  dotagents install
elif command -v npx >/dev/null 2>&1; then
  npx --yes @sentry/dotagents install
fi
# dotagents:end`;

describe("managed post-merge hooks", () => {
  let root: string;
  let gitDir: string;
  let hookPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-post-merge-"));
    gitDir = join(root, ".git");
    hookPath = join(gitDir, "hooks", "post-merge");
    await mkdir(join(gitDir, "hooks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects and replaces a legacy block without touching surrounding content", async () => {
    const before = `#!/usr/bin/env bash\necho before\n${LEGACY_BLOCK}\necho after\n`;
    await writeFile(hookPath, before);
    await chmod(hookPath, 0o744);

    expect(await inspectPostMergeHook(gitDir)).toBe("legacy");
    expect(await updateManagedPostMergeHook(gitDir)).toBe(true);

    const after = await readFile(hookPath, "utf-8");
    expect(after).toMatch(/^#!\/usr\/bin\/env bash\necho before\n/);
    expect(after).toContain("dotagents --project install");
    expect(after).toContain("npx --yes @sentry/dotagents --project install");
    expect(after).toMatch(/# dotagents:end\necho after\n$/);
    expect((await lstat(hookPath)).mode & 0o777).toBe(0o744);
    expect(await inspectPostMergeHook(gitDir)).toBe("current");
  });

  it("is idempotent after repairing a legacy block", async () => {
    await writeFile(hookPath, `#!/bin/sh\n${LEGACY_BLOCK}\n`);

    expect(await installPostMergeHook(gitDir)).toBe("updated");
    const repaired = await readFile(hookPath, "utf-8");
    expect(await installPostMergeHook(gitDir)).toBe("exists");
    expect(await readFile(hookPath, "utf-8")).toBe(repaired);
  });

  it("treats an unmatched marker as unmanaged content", async () => {
    await writeFile(hookPath, "#!/bin/sh\n# dotagents:post-merge\necho custom\n");

    expect(await inspectPostMergeHook(gitDir)).toBe("unmanaged");
  });
});
