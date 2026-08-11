import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const POST_MERGE_MARKER = "# dotagents:post-merge";
export const POST_MERGE_END_MARKER = "# dotagents:end";

const POST_MERGE_BLOCK = `${POST_MERGE_MARKER}
if command -v dotagents >/dev/null 2>&1; then
  dotagents --project install
elif command -v npx >/dev/null 2>&1; then
  npx --yes @sentry/dotagents --project install
fi
${POST_MERGE_END_MARKER}`;

function managedBlockRange(content: string): { start: number; end: number } | undefined {
  const start = content.indexOf(POST_MERGE_MARKER);
  if (start === -1) {return undefined;}
  const endMarker = content.indexOf(POST_MERGE_END_MARKER, start);
  if (endMarker === -1) {return undefined;}
  return { start, end: endMarker + POST_MERGE_END_MARKER.length };
}

export function hasLegacyPostMergeBlock(content: string): boolean {
  const range = managedBlockRange(content);
  if (!range) {return false;}
  const block = content.slice(range.start, range.end);
  return /^\s*dotagents install\s*$/m.test(block) ||
    /^\s*npx --yes @sentry\/dotagents install\s*$/m.test(block);
}

function replaceManagedBlock(content: string): string | undefined {
  const range = managedBlockRange(content);
  if (!range) {return undefined;}
  return `${content.slice(0, range.start)}${POST_MERGE_BLOCK}${content.slice(range.end)}`;
}

export async function inspectPostMergeHook(
  gitDir: string,
): Promise<"missing" | "unmanaged" | "current" | "legacy"> {
  const hookPath = join(gitDir, "hooks", "post-merge");
  if (!existsSync(hookPath)) {return "missing";}
  const content = await readFile(hookPath, "utf-8");
  if (!managedBlockRange(content)) {return "unmanaged";}
  return hasLegacyPostMergeBlock(content) ? "legacy" : "current";
}

/** Updates an existing managed block without creating a new hook. */
export async function updateManagedPostMergeHook(gitDir: string): Promise<boolean> {
  const hookPath = join(gitDir, "hooks", "post-merge");
  if (!existsSync(hookPath)) {return false;}
  const content = await readFile(hookPath, "utf-8");
  const updated = replaceManagedBlock(content);
  if (updated === undefined || updated === content) {return false;}
  await writeFile(hookPath, updated, "utf-8");
  return true;
}

export async function installPostMergeHook(
  gitDir: string,
): Promise<"created" | "updated" | "exists"> {
  const hooksDir = join(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-merge");

  if (existsSync(hookPath)) {
    const existing = await readFile(hookPath, "utf-8");
    const updated = replaceManagedBlock(existing);
    if (updated !== undefined) {
      if (updated === existing) {return "exists";}
      await writeFile(hookPath, updated, "utf-8");
      return "updated";
    }
    await writeFile(hookPath, `${existing.trimEnd()}\n${POST_MERGE_BLOCK}\n`, "utf-8");
  } else {
    await writeFile(hookPath, `#!/bin/sh\n${POST_MERGE_BLOCK}\n`, "utf-8");
  }

  await chmod(hookPath, 0o755);
  return "created";
}
