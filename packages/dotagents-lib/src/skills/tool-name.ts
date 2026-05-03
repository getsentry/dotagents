/**
 * Closed set of well-known agent tool names. The list tracks Claude Code's
 * tool inventory, which is the de-facto agentskills.io standard.
 *
 * Hosts that want a stricter set layer their own validation on top
 * (e.g. `z.enum(TOOL_NAMES).refine(...)` to disallow `Bash`).
 * Hosts that need an open set use `string[]` directly and do their own typing.
 */
export const TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && TOOL_NAME_SET.has(value);
}
