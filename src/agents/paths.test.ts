import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { getUserMcpTarget } from "./paths.js";
import { getAgent } from "./registry.js";

describe("getUserMcpTarget", () => {
  const home = homedir();

  it("claude targets ~/.claude.json (shared)", () => {
    const t = getUserMcpTarget("claude");
    expect(t.filePath).toBe(join(home, ".claude.json"));
    expect(t.shared).toBe(true);
  });

  it("cursor targets ~/.cursor/mcp.json (not shared)", () => {
    const t = getUserMcpTarget("cursor");
    expect(t.filePath).toBe(join(home, ".cursor", "mcp.json"));
    expect(t.shared).toBe(false);
  });

  it("codex targets ~/.codex/config.toml (shared)", () => {
    const t = getUserMcpTarget("codex");
    expect(t.filePath).toBe(join(home, ".codex", "config.toml"));
    expect(t.shared).toBe(true);
  });

  it("vscode targets platform-specific path (not shared)", () => {
    const t = getUserMcpTarget("vscode");
    expect(t.shared).toBe(false);
    // Path varies by platform; just verify it ends with the expected file
    expect(t.filePath).toMatch(/mcp\.json$/);
  });

  it("opencode targets ~/.config/opencode/opencode.json (shared)", () => {
    const t = getUserMcpTarget("opencode");
    expect(t.filePath).toBe(join(home, ".config", "opencode", "opencode.json"));
    expect(t.shared).toBe(true);
  });

  it("pi targets ~/.pi/agent/mcp.json (not shared)", () => {
    const t = getUserMcpTarget("pi");
    expect(t.filePath).toBe(join(home, ".pi", "agent", "mcp.json"));
    expect(t.shared).toBe(false);
  });

  it("throws for unknown agent", () => {
    expect(() => getUserMcpTarget("emacs")).toThrow("Unknown agent");
  });
});

describe("skill discovery paths", () => {
  const home = homedir();

  // Agents that DON'T read .agents/skills/ natively need symlinks
  it("claude needs project and user symlinks", () => {
    const agent = getAgent("claude")!;
    expect(agent.skillsParentDir).toBe(".claude");
    expect(agent.userSkillsParentDirs).toEqual([join(home, ".claude")]);
  });

  it("cursor shares .claude skills symlink", () => {
    const agent = getAgent("cursor")!;
    expect(agent.skillsParentDir).toBe(".claude");
    expect(agent.userSkillsParentDirs).toEqual([join(home, ".claude")]);
  });

  // Agents that DO read .agents/skills/ natively need no symlinks
  it("vscode reads .agents/skills/ natively", () => {
    const agent = getAgent("vscode")!;
    expect(agent.skillsParentDir).toBeUndefined();
    expect(agent.userSkillsParentDirs).toBeUndefined();
  });

  it("codex reads .agents/skills/ natively", () => {
    const agent = getAgent("codex")!;
    expect(agent.skillsParentDir).toBeUndefined();
    expect(agent.userSkillsParentDirs).toBeUndefined();
  });

  it("opencode reads .agents/skills/ natively", () => {
    const agent = getAgent("opencode")!;
    expect(agent.skillsParentDir).toBeUndefined();
    expect(agent.userSkillsParentDirs).toBeUndefined();
  });

  it("pi needs project and user symlinks", () => {
    const agent = getAgent("pi")!;
    expect(agent.skillsParentDir).toBe(".pi");
    expect(agent.userSkillsParentDirs).toEqual([join(home, ".pi", "agent")]);
  });
});
