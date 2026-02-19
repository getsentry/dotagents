import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";

const pi: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  configDir: ".pi",
  skillsParentDir: ".pi",
  userSkillsParentDirs: [join(homedir(), ".pi", "agent")],
  mcp: {
    filePath: ".pi/mcp.json",
    rootKey: "mcpServers",
    format: "json",
    shared: false,
  },
  serializeServer(s) {
    if (s.url) {
      return [
        s.name,
        {
          command: "npx",
          args: ["-y", "mcp-remote", s.url],
          ...(s.headers && { headers: s.headers }),
        },
      ];
    }
    const env: Record<string, string> = {};
    if (s.env) {
      for (const key of s.env) env[key] = `\${${key}}`;
    }
    return [
      s.name,
      {
        command: s.command,
        args: s.args ?? [],
        ...(Object.keys(env).length > 0 && { env }),
      },
    ];
  },
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("pi", "hooks");
  },
};

export default pi;
