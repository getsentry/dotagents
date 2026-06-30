import { describe, expect, it } from "vitest";
import { lockEntryForPlugin, type ResolvedPlugin } from "./plugin-store.js";

describe("plugin store", () => {
  it("preserves an empty resolved path for root git plugins", () => {
    const resolved = {
      type: "git",
      source: "org/review-tools",
      resolvedUrl: "https://github.com/org/review-tools.git",
      resolvedPath: "",
      commit: "abc123",
      plugin: {
        name: "review-tools",
        source: "org/review-tools",
        pluginDir: "/tmp/review-tools",
        manifest: { name: "review-tools" },
      },
    } satisfies ResolvedPlugin;

    expect(lockEntryForPlugin(resolved)).toEqual({
      source: "org/review-tools",
      resolved_url: "https://github.com/org/review-tools.git",
      resolved_path: "",
      resolved_commit: "abc123",
    });
  });
});
