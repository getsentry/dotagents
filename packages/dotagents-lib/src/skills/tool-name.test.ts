import { describe, it, expect } from "vitest";
import { TOOL_NAMES, isToolName, type ToolName } from "./tool-name.js";

describe("isToolName", () => {
  it("accepts every name in TOOL_NAMES", () => {
    for (const name of TOOL_NAMES) {
      expect(isToolName(name)).toBe(true);
    }
  });

  it("rejects unknown names", () => {
    expect(isToolName("Magic")).toBe(false);
    expect(isToolName("read")).toBe(false); // case-sensitive
    expect(isToolName("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isToolName(null)).toBe(false);
    expect(isToolName(42)).toBe(false);
    expect(isToolName(["Read"])).toBe(false);
    expect(isToolName(void 0)).toBe(false);
  });

  it("narrows the type to ToolName when true", () => {
    const candidate: unknown = "Read";
    if (isToolName(candidate)) {
      // Compile-time check — `candidate` should be ToolName here.
      const narrowed: ToolName = candidate;
      expect(narrowed).toBe("Read");
    }
  });
});
