import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import { envRecord, httpServer } from "./helpers.js";

const opencode: AgentDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  configDir: ".claude",
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
    if (s.url) return httpServer(s, "remote");
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
};

export default opencode;
