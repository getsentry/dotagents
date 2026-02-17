import type { AgentDefinition } from "../types.js";
import { UnsupportedFeature } from "../errors.js";
import claude from "./claude.js";
import { envRecord } from "./helpers.js";

const codex: AgentDefinition = {
  ...claude,
  id: "codex",
  displayName: "Codex",
  configDir: ".codex",
  // reads .agents/skills/ natively at both project and user scope
  skillsParentDir: undefined,
  userSkillsParentDirs: undefined,
  mcp: {
    filePath: ".codex/config.toml",
    rootKey: "mcp_servers",
    format: "toml",
    shared: true,
  },
  serializeServer(s) {
    if (s.url) {
      return [s.name, { url: s.url, ...(s.headers && { http_headers: s.headers }) }];
    }
    const env = envRecord(s.env, (k) => `\${${k}}`);
    return [s.name, { command: s.command, args: s.args ?? [], ...(env && { env }) }];
  },
  hooks: undefined,
  serializeHooks() {
    throw new UnsupportedFeature("codex", "hooks");
  },
};

export default codex;
