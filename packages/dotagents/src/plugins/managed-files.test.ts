import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isManagedJsonFile, managedJsonMarkerPath, stableJson, writeManagedJsonIfChanged } from "./managed-files.js";

describe("managed plugin JSON", () => {
  let root: string;

  afterEach(async () => {
    if (root) {await rm(root, { recursive: true, force: true });}
  });

  it("rejects non-serializable managed JSON", () => {
    expect(() => stableJson({ callback: () => null })).toThrow("Managed JSON must be serializable");
  });

  it("replaces marker symlinks without writing through them", async () => {
    root = await mkdtemp(join(tmpdir(), "dotagents-managed-json-"));
    const filePath = join(root, "plugin", "plugin.json");
    const outsidePath = join(root, "outside.txt");
    await mkdir(join(root, "plugin"), { recursive: true });
    await writeFile(outsidePath, "outside", "utf-8");
    await symlink(outsidePath, managedJsonMarkerPath(filePath));

    await writeManagedJsonIfChanged(filePath, "{}\n");

    expect(await readFile(outsidePath, "utf-8")).toBe("outside");
    expect((await lstat(managedJsonMarkerPath(filePath))).isFile()).toBe(true);
    expect(await isManagedJsonFile(filePath)).toBe(true);
  });
});
