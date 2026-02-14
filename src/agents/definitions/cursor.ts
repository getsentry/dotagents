import type { AgentDefinition, HookDeclaration } from "../types.js";
import type { HookEvent } from "../../config/schema.js";
import claude from "./claude.js";

/**
 * Maps universal hook events to Cursor event names.
 * PreToolUse maps to both beforeShellExecution and beforeMCPExecution.
 */
const CURSOR_EVENT_MAP: Record<HookEvent, string[]> = {
  PreToolUse: ["beforeShellExecution", "beforeMCPExecution"],
  PostToolUse: ["afterFileEdit"],
  UserPromptSubmit: ["beforeSubmitPrompt"],
  Stop: ["stop"],
};

const cursor: AgentDefinition = {
  ...claude,
  id: "cursor",
  displayName: "Cursor",
  configDir: ".cursor",
  skillsParentDir: ".cursor",
  mcp: {
    filePath: ".cursor/mcp.json",
    rootKey: "mcpServers",
    format: "json",
    shared: false,
  },
  hooks: {
    filePath: ".cursor/hooks.json",
    rootKey: "hooks",
    format: "json",
    shared: false,
    extraFields: { version: 1 },
  },
  serializeHooks(hooks: HookDeclaration[]) {
    const result: Record<string, unknown[]> = {};
    for (const h of hooks) {
      const cursorEvents = CURSOR_EVENT_MAP[h.event];
      for (const ce of cursorEvents) {
        const list = (result[ce] as unknown[]) ?? [];
        list.push({ command: h.command });
        result[ce] = list;
      }
    }
    return result;
  },
};

export default cursor;
