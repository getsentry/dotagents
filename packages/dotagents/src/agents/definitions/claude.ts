import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition } from "../types.js";
import { envRecord, httpServer, markManagedMarkdownSubagent, serializeClaudeHooks, serializeMarkdownSubagent } from "./helpers.js";

const claude: AgentDefinition = {
  id: "claude",
  displayName: "Claude Code",
  configDir: ".claude",
  skillsParentDir: ".claude",
  userSkillsParentDirs: [join(homedir(), ".claude")],
  mcp: {
    filePath: ".mcp.json",
    rootKey: "mcpServers",
    format: "json",
    shared: false,
  },
  serializeServer(s) {
    if (s.url) {return httpServer(s, "http");}
    const env = envRecord(s.env, (k) => `\${${k}}`);
    return [s.name, { command: s.command, args: s.args ?? [], ...(env && { env }) }];
  },
  hooks: {
    filePath: ".claude/settings.json",
    rootKey: "hooks",
    format: "json",
    shared: true,
  },
  serializeHooks: serializeClaudeHooks,
  subagents: {
    projectDir: ".claude/agents",
    userDir: join(homedir(), ".claude", "agents"),
    fileExtension: ".md",
    identity: "frontmatter-name",
    serialize(subagent) {
      const native = subagent.native?.claude;
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

export default claude;
