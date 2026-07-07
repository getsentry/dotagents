import { describe, expect, it } from "vitest";
import {
  parsePluginManifest,
  parsePluginMarketplace,
  pluginManifestSchema,
  pluginMarketplaceSchema,
} from "./schema.js";

describe("plugin manifest schema", () => {
  it("accepts known fields and preserves extension fields", () => {
    const manifest = parsePluginManifest(
      {
        name: "review-tools",
        version: "1.2.3",
        skills: "./skills",
        commands: ["commands/review.md"],
        "x-runtime": {
          plugins: ["runtime/plugin.ts"],
          runtime: "bun",
        },
        "x-dotagents": {
          stable: true,
        },
      },
      "plugin.json",
    );

    expect(manifest.name).toBe("review-tools");
    expect(manifest["x-runtime"]).toEqual({
      plugins: ["runtime/plugin.ts"],
      runtime: "bun",
    });
    expect(manifest["x-dotagents"]).toEqual({ stable: true });
  });

  it("rejects absolute and traversing component paths", () => {
    expect(pluginManifestSchema.safeParse({ skills: "/tmp/skills" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ commands: ["../commands"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ skills: "https://example.com/skills" }).success).toBe(false);
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

  it("accepts marketplace-file-relative local entries", () => {
    const marketplace = parsePluginMarketplace(
      {
        name: "dotagents",
        plugins: [
          {
            name: "review-tools",
            source: "../.agents/plugins/review-tools",
          },
          {
            name: "codex-tools",
            source: {
              source: "local",
              path: "./codex-tools",
            },
          },
        ],
      },
      "marketplace.json",
    );

    expect(marketplace.plugins[0]!.source).toBe("../.agents/plugins/review-tools");
    expect(marketplace.plugins[1]!.source).toEqual({
      source: "local",
      path: "./codex-tools",
    });
  });

  it("rejects unsafe marketplace paths", () => {
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: "https://example.com/plugin.git" }],
    }).success).toBe(false);
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: { source: "github", path: "../outside" } }],
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
