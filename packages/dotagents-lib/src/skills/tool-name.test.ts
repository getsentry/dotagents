import { describe, it, expect, expectTypeOf } from "vitest";
import { TOOL_NAMES, isToolName, type ToolName } from "./tool-name.js";

function verifyCandidate(candidate: string | number): void {
  if (isToolName(candidate)) {
    expectTypeOf(candidate).toEqualTypeOf<ToolName>();
  }
}

describe("isToolName", () => {
  it("accepts every name in TOOL_NAMES", () => {
    for (const name of TOOL_NAMES) {
      expect(isToolName(name)).toBe(true);
    }

    verifyCandidate("Read");
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

});
