import type { AgentDefinition } from "../types.js";
import { envRecord, httpServer } from "./helpers.js";

const vscode: AgentDefinition = {
  id: "vscode",
  displayName: "VS Code Copilot",
  configDir: ".vscode",
  skillsParentDir: ".vscode",
  mcp: {
    filePath: ".vscode/mcp.json",
    rootKey: "servers",
    format: "json",
    shared: false,
  },
  serializeServer(s) {
    if (s.url) return httpServer(s, "sse");
    const env = envRecord(s.env, (k) => `\${input:${k}}`);
    return [
      s.name,
      { type: "stdio", command: s.command, args: s.args ?? [], ...(env && { env }) },
    ];
  },
};

export default vscode;
