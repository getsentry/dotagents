import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import { envRecord, httpServer } from "./helpers.js";
import { markManagedMarkdownSubagent, serializeMarkdownSubagent } from "../../subagents/format.js";

const opencode: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  configDir: ".opencode",
  // reads .agents/skills/ natively at both project and user scope
  skillsParentDir: undefined,
  userSkillsParentDirs: undefined,
  mcp: {
    filePath: "opencode.json",
    rootKey: "mcp",
    format: "json",
    shared: true,
  },
  serializeServer(s) {
    if (s.url) {return httpServer(s, "remote", (k) => `{env:${k}}`);}

    const env = envRecord(s.env, (k) => `\${${k}}`);
    return [
      s.name,
      {
        type: "local",
        command: [s.command!, ...(s.args ?? [])],
        ...(env && { environment: env }),
      },
    ];
  },
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("opencode", "hooks");
  },
  subagents: {
    projectDir: ".opencode/agents",
    userDir: join(homedir(), ".config", "opencode", "agents"),
    fileExtension: ".md",
    identity: "filename",
    serialize(subagent) {
      const native = subagent.native?.opencode;
      return {
        fileName: `${subagent.name}.md`,
        content: native
          ? markManagedMarkdownSubagent(native)
          : serializeMarkdownSubagent(
              {
                description: subagent.description,
                mode: "subagent",
              },
              subagent.instructions,
            ),
      };
    },
  },
};

export default opencode;
