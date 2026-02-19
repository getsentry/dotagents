import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import { envRecord, httpServer } from "./helpers.js";

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
    if (s.url) return httpServer(s);
    const env = envRecord(s.env, (k) => `\${${k}}`);
    return [s.name, { command: s.command, args: s.args ?? [], ...(env && { env }) }];
  },
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("pi", "hooks");
  },
};

export default pi;
