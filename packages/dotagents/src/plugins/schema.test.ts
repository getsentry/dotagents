import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGIN_SCHEMA,
  AGENT_PLUGIN_MCP_SCHEMA,
  parsePluginManifest,
  parsePluginMcp,
  parsePluginMcpBestEffort,
  parsePluginMarketplace,
  isStandardPluginManifest,
  pluginManifestSchema,
  pluginMarketplaceSchema,
} from "./schema.js";

describe("plugin manifest schema", () => {
  it("accepts Agent Plugins v1 manifests", () => {
    const manifest = parsePluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      description: "Review tools",
      extensions: {
        "com.example.client": { enabled: true },
      },
    }, "plugin.json");

    expect(manifest.$schema).toBe(AGENT_PLUGIN_SCHEMA);
    expect(manifest.extensions?.["com.example.client"]).toEqual({ enabled: true });
  });

  it("preserves nonstandard author and homepage strings", () => {
    const manifest = parsePluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      author: {
        name: "Review Team",
        email: "team at example dot com",
        url: "internal-review-home",
      },
      homepage: "internal-homepage",
    }, "plugin.json");

    expect(manifest.author).toEqual({
      name: "Review Team",
      email: "team at example dot com",
      url: "internal-review-home",
    });
    expect(manifest.homepage).toBe("internal-homepage");
  });

  it("drops unknown standard fields and malformed extensions", () => {
    const manifest = parsePluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      metadata: { leaked: true },
      extensions: "invalid",
    }, "plugin.json");

    expect(manifest).toEqual({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
    });
  });

  it("keeps valid standard extensions beside malformed siblings", () => {
    const manifest = parsePluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      extensions: {
        "com.example.valid": { enabled: true },
        "com.example.invalid": "bad",
      },
    }, "plugin.json");

    expect(manifest.extensions).toEqual({
      "com.example.valid": { enabled: true },
    });
  });

  it("rejects non-namespaced standard extensions", () => {
    expect(() => parsePluginManifest({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "review-tools",
      extensions: {
        claude: { enabled: true },
      },
    }, "plugin.json")).toThrow(/reverse-domain identifier/);
  });

  it("rejects unsupported Agent Plugins schema identifiers", () => {
    expect(() => parsePluginManifest({
      $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      name: "review-tools",
    }, "plugin.json")).toThrow("Invalid plugin manifest");
  });

  it("treats non-Agent schema metadata as legacy input", () => {
    const manifest = parsePluginManifest({
      $schema: "https://example.com/claude-plugin.schema.json",
      name: "review-tools",
      commands: "./commands",
    }, "plugin.json");

    expect(manifest.name).toBe("review-tools");
    expect("$schema" in manifest).toBe(false);
    expect(isStandardPluginManifest(manifest)).toBe(false);
  });

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
    expect((manifest as Record<string, unknown>)["x-runtime"]).toEqual({
      plugins: ["runtime/plugin.ts"],
      runtime: "bun",
    });
    expect((manifest as Record<string, unknown>)["x-dotagents"]).toEqual({ stable: true });
  });

  it("rejects absolute and traversing component paths", () => {
    expect(pluginManifestSchema.safeParse({ skills: "/tmp/skills" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ commands: ["../commands"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ skills: "https://example.com/skills" }).success).toBe(false);
  });
});

describe("plugin MCP schema", () => {
  it("accepts Agent Plugins v1 MCP declarations", () => {
    const config = parsePluginMcp({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        review: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server.js"],
          env: { CACHE_DIR: "${PLUGIN_DATA}/cache" },
        },
      },
    }, "mcp.json");
    expect(config.mcpServers["review"]?.type).toBe("stdio");
  });

  it("rejects shell commands and unsupported transports", () => {
    expect(() => parsePluginMcp({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { bad: { type: "stdio", command: "node server.js" } },
    }, "mcp.json")).toThrow('Invalid plugin MCP server "bad"');
    expect(() => parsePluginMcp({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { bad: { type: "http", url: "https://example.com" } },
    }, "mcp.json")).toThrow('Invalid plugin MCP server "bad"');
    for (const command of ["/tmp/server", "../server", "./../server", "bin/server"]) {
      expect(() => parsePluginMcp({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { bad: { type: "stdio", command } },
      }, "mcp.json")).toThrow('Invalid plugin MCP server "bad"');
    }
    expect(parsePluginMcp({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: { good: { type: "stdio", command: "./bin/server" } },
    }, "mcp.json").mcpServers["good"]?.type).toBe("stdio");
  });

  it("rejects unsafe cwd and reserved portable environment overrides", () => {
    for (const cwd of [
      "/tmp",
      "../outside",
      "${HOME}/plugin",
      "${PLUGIN_ROOT}/../outside",
      "${PLUGIN_DATA}/cache/../../outside",
    ]) {
      expect(() => parsePluginMcp({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { bad: { type: "stdio", command: "node", cwd } },
      }, "mcp.json")).toThrow('Invalid plugin MCP server "bad"');
    }
    for (const key of ["PLUGIN_ROOT", "PLUGIN_DATA"]) {
      expect(() => parsePluginMcp({
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { bad: { type: "stdio", command: "node", env: { [key]: "override" } } },
      }, "mcp.json")).toThrow('Invalid plugin MCP server "bad"');
    }
  });

  it("retains valid MCP servers beside invalid siblings", () => {
    const parsed = parsePluginMcpBestEffort({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        good: { type: "stdio", command: "node" },
        bad: { type: "stdio", command: "node server.js" },
      },
    }, "mcp.json");

    expect(Object.keys(parsed.config.mcpServers)).toEqual(["good"]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toContain('Invalid plugin MCP server "bad"');
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

  it("accepts unsupported extension source objects without local paths", () => {
    const marketplace = parsePluginMarketplace(
      {
        name: "dotagents",
        plugins: [
          {
            name: "external-tools",
            source: {
              source: "github",
              repo: "org/external-tools",
            },
          },
        ],
      },
      "marketplace.json",
    );

    expect(marketplace.plugins[0]!.source).toEqual({
      source: "github",
      repo: "org/external-tools",
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

  it("rejects local marketplace source objects without a path selector", () => {
    expect(pluginMarketplaceSchema.safeParse({
      name: "dotagents",
      plugins: [{ name: "bad", source: { source: "local" } }],
    }).success).toBe(false);
  });
});
