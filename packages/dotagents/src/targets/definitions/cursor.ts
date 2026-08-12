import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition, HookDeclaration } from "../types.js";
import type { HookEvent } from "../../config/schema.js";
import claude from "./claude.js";
import { httpServer } from "./helpers.js";
import { markManagedMarkdownSubagent, serializeMarkdownSubagent } from "../../subagents/format.js";

/**
 * Maps universal hook events to Cursor event names.
 * PreToolUse maps to both beforeShellExecution and beforeMCPExecution.
 */
const CURSOR_EVENT_MAP = {
  PreToolUse: ["beforeShellExecution", "beforeMCPExecution"],
  PostToolUse: ["afterFileEdit"],
  UserPromptSubmit: ["beforeSubmitPrompt"],
  Stop: ["stop"],
} as const satisfies Record<HookEvent, readonly string[]>;

type CursorHookEvent = (typeof CURSOR_EVENT_MAP)[HookEvent][number];
type CursorHookEntry = { command: string };

const cursor: AgentDefinition = {
  ...claude,
  id: "cursor",
  displayName: "Cursor",
  configDir: ".cursor",
  skillsParentDir: ".claude",
  userSkillsParentDirs: [join(homedir(), ".claude")],
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
  serializeServer(s) {
    // Cursor auto-detects transport from url presence; no type field needed
    if (s.url) {return httpServer(s, undefined, (k) => `\${env:${k}}`);}

    return claude.serializeServer(s);
  },
  serializeHooks(hooks: HookDeclaration[]) {
    const result: Partial<Record<CursorHookEvent, CursorHookEntry[]>> = {};
    for (const h of hooks) {
      const cursorEvents = CURSOR_EVENT_MAP[h.event];
      for (const ce of cursorEvents) {
        const list = result[ce] ?? [];
        list.push({ command: h.command });
        result[ce] = list;
      }
    }
    return result;
  },
  subagents: {
    projectDir: ".cursor/agents",
    userDir: join(homedir(), ".cursor", "agents"),
    fileExtension: ".md",
    identity: "frontmatter-name-or-filename",
    serialize(subagent) {
      const native = subagent.native?.cursor;
      return {
        fileName: `${subagent.name}.md`,
        content: native
          ? markManagedMarkdownSubagent(native)
          : serializeMarkdownSubagent(
              {
                name: subagent.name,
                description: subagent.description,
              },
              subagent.instructions,
            ),
      };
    },
  },
};

export default cursor;
