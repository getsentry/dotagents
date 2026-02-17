import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { getUserMcpTarget, USER_SKILLS_PARENT } from "./paths.js";

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

  it("throws for unknown agent", () => {
    expect(() => getUserMcpTarget("emacs")).toThrow("Unknown agent");
  });
});

describe("USER_SKILLS_PARENT", () => {
  it("points to ~/.claude", () => {
    expect(USER_SKILLS_PARENT).toBe(join(homedir(), ".claude"));
  });
});
