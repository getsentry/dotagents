import { describe, expect, it } from "vitest";
import {
  parsePluginManifest,
  parsePluginMarketplace,
  pluginManifestSchema,
  pluginMarketplaceSchema,
} from "./plugin-schema.js";

describe("plugin manifest schema", () => {
  it("accepts known fields and preserves extension fields", () => {
    const manifest = parsePluginManifest(
      {
        name: "review-tools",
        version: "1.2.3",
        skills: "./skills",
        commands: ["commands/review.md"],
        opencode: {
          plugins: ["opencode/plugin.ts"],
          runtime: "bun",
        },
        "x-dotagents": {
          stable: true,
        },
      },
      "plugin.json",
    );

    expect(manifest.name).toBe("review-tools");
    expect(manifest.opencode?.plugins).toEqual(["opencode/plugin.ts"]);
    expect(manifest.opencode?.["runtime"]).toBe("bun");
    expect(manifest["x-dotagents"]).toEqual({ stable: true });
  });

  it("rejects absolute and traversing component paths", () => {
    expect(pluginManifestSchema.safeParse({ skills: "/tmp/skills" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ commands: ["../commands"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ skills: "https://example.com/skills" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ opencode: { plugins: ["opencode/../../plugin.ts"] } }).success).toBe(false);
  });

  it("rejects multiple OpenCode plugin modules", () => {
    expect(pluginManifestSchema.safeParse({
      opencode: {
        plugins: ["opencode/first.ts", "opencode/second.ts"],
      },
    }).success).toBe(false);
  });

  it("rejects OpenCode plugin modules without a JavaScript or TypeScript extension", () => {
    expect(pluginManifestSchema.safeParse({
      opencode: {
        plugins: ["opencode/plugin.md"],
      },
    }).success).toBe(false);
  });
});

describe("plugin marketplace schema", () => {
  it("accepts codex-compatible local entries and preserves extension fields", () => {
    const marketplace = parsePluginMarketplace(
      {
        name: "dotagents",
        metadata: {
          pluginRoot: ".agents/plugins",
          managedBy: "dotagents",
        },
        plugins: [
          {
            name: "review-tools",
            source: {
              source: "local",
              path: "./review-tools",
            },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_INSTALL",
            },
            extra: "kept",
          },
        ],
      },
      "marketplace.json",
    );

    expect(marketplace.metadata?.pluginRoot).toBe(".agents/plugins");
    expect(marketplace.metadata?.["managedBy"]).toBe("dotagents");
    expect(marketplace.plugins[0]!.source).toEqual({
      source: "local",
      path: "./review-tools",
    });
    expect(marketplace.plugins[0]!["extra"]).toBe("kept");
  });

  it("rejects unsafe marketplace paths", () => {
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: "../bad" }],
    }).success).toBe(false);
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: "https://example.com/plugin.git" }],
    }).success).toBe(false);
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      metadata: { pluginRoot: "../plugins" },
      plugins: [{ name: "bad", source: "./bad" }],
    }).success).toBe(false);
  });

  it("rejects marketplace source objects without a path selector", () => {
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: { source: "local" } }],
    }).success).toBe(false);
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: { url: "https://example.com/plugin.git" } }],
    }).success).toBe(false);
  });
});
