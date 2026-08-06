import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DOTAGENTS_METADATA = { managedBy: "dotagents" };

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(sortJson);}
  if (!value || typeof value !== "object") {return value;}

  const result: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).toSorted()) {
    result[key] = sortJson(record[key]);
  }
  return result;
}

export async function writeJsonIfChanged(filePath: string, content: string): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true });
  return writeTextIfChanged(filePath, content);
}

async function writeTextIfChanged(filePath: string, content: string): Promise<boolean> {
  try {
    if (await readFile(filePath, "utf-8") === content) {return false;}
  } catch (err) {
    if (!isNotFoundError(err)) {throw err;}
  }
  await writeFile(filePath, content, "utf-8");
  return true;
}

/** Checks the JSON ownership marker used for managed plugin outputs. */
export async function isManagedJsonFile(filePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
    const metadata = parsed["metadata"];
    return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>)["managedBy"] === "dotagents";
  } catch {
    return false;
  }
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
