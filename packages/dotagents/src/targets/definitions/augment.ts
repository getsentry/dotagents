import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import { envRecord, httpServer } from "./helpers.js";
import { serializeMarkdownSubagent } from "../../subagents/format.js";

const augment: AgentDefinition = {
  id: "augment",
  displayName: "Augment (Auggie)",
  configDir: ".augment",
  // reads .agents/skills/ natively at both project and user scope
  mcp: {
    filePath: ".augment/settings.json",
    rootKey: "mcpServers",
    format: "json",
    shared: true,
  },
  serializeServer(s) {
    if (s.url) {return httpServer(s, "http");}

    const env = envRecord(s.env, (key) => `\${${key}}`);
    return [
      s.name,
      {
        type: "stdio",
        command: s.command,
        args: s.args ?? [],
        ...(env && { env }),
      },
    ];
  },
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("augment", "hooks");
  },
  subagents: {
    projectDir: ".augment/agents",
    userDir: join(homedir(), ".augment", "agents"),
    fileExtension: ".md",
    identity: "frontmatter-name",
    serialize(subagent) {
      return {
        fileName: `${subagent.name}.md`,
        content: serializeMarkdownSubagent(
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

export default augment;
