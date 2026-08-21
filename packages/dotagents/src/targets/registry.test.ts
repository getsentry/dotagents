import { describe, it, expect } from "vitest";
import { getAgent, allAgentIds } from "./registry.js";

describe("allAgentIds", () => {
  it("includes all expected agents", () => {
    const ids = allAgentIds();
    expect(ids).toContain("claude");
    expect(ids).toContain("cursor");
    expect(ids).toContain("codex");
    expect(ids).toContain("vscode");
    expect(ids).toContain("opencode");
    expect(ids).toContain("copilot");
  });
});

describe("getAgent", () => {
  it("returns undefined for unknown agent", () => {
    expect(getAgent("unknown")).toBeUndefined();
  });
});
