import { describe, it, expect } from "vitest";
import { parseSource, normalizeSource } from "@sentry/dotagents-lib";

/**
 * Cross-package smoke: confirms the workspace dependency on `@sentry/dotagents-lib`
 * resolves and a representative public symbol is callable end-to-end.
 *
 * This test does not re-cover the lib's own resolver tests — it only catches a
 * broken workspace link or a stale re-export path.
 */
describe("@sentry/dotagents-lib smoke (consumed via workspace dep)", () => {
  it("parseSource recognises GitHub shorthand", () => {
    const parsed = parseSource("https://github.com/anthropics/skills@main");
    expect(parsed.type).toBe("github");
    expect(parsed.owner).toBe("anthropics");
    expect(parsed.repo).toBe("skills");
    expect(parsed.ref).toBe("main");
  });

  it("normalizeSource collapses owner/repo equivalents", () => {
    expect(normalizeSource("https://github.com/anthropics/skills.git")).toBe(
      "anthropics/skills",
    );
  });
});
