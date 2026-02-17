import { describe, it, expect } from "vitest";
import { getAgent, allAgentIds } from "./registry.js";
import type { McpDeclaration } from "./types.js";

const STDIO_SERVER: McpDeclaration = {
  name: "github",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: ["GITHUB_TOKEN"],
};

const HTTP_SERVER: McpDeclaration = {
  name: "remote-api",
  url: "https://mcp.example.com/sse",
  headers: { Authorization: "Bearer tok" },
};

const STDIO_NO_ENV: McpDeclaration = {
  name: "simple",
  command: "mcp-server",
  args: [],
};

describe("allAgentIds", () => {
  it("returns all 5 agents", () => {
    const ids = allAgentIds();
    expect(ids).toContain("claude");
    expect(ids).toContain("cursor");
    expect(ids).toContain("codex");
    expect(ids).toContain("vscode");
    expect(ids).toContain("opencode");
    expect(ids).toHaveLength(5);
  });
});

describe("getAgent", () => {
  it("returns undefined for unknown agent", () => {
    expect(getAgent("unknown")).toBeUndefined();
  });
});

describe("claude serializer", () => {
  const agent = getAgent("claude")!;

  it("serializes stdio server", () => {
    const [name, config] = agent.serializeServer(STDIO_SERVER);
    expect(name).toBe("github");
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("serializes http server", () => {
    const [name, config] = agent.serializeServer(HTTP_SERVER);
    expect(name).toBe("remote-api");
    expect(config).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("omits env when empty", () => {
    const [, config] = agent.serializeServer(STDIO_NO_ENV);
    expect(config).toEqual({ command: "mcp-server", args: [] });
    expect(config).not.toHaveProperty("env");
  });
});

describe("cursor serializer", () => {
  it("produces same shape as claude", () => {
    const claude = getAgent("claude")!;
    const cursor = getAgent("cursor")!;
    expect(cursor.serializeServer(STDIO_SERVER)).toEqual(claude.serializeServer(STDIO_SERVER));
    expect(cursor.serializeServer(HTTP_SERVER)).toEqual(claude.serializeServer(HTTP_SERVER));
  });
});

describe("codex serializer", () => {
  const agent = getAgent("codex")!;

  it("serializes stdio server", () => {
    const [name, config] = agent.serializeServer(STDIO_SERVER);
    expect(name).toBe("github");
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("serializes http server with http_headers and no type", () => {
    const [name, config] = agent.serializeServer(HTTP_SERVER);
    expect(name).toBe("remote-api");
    expect(config).toEqual({
      url: "https://mcp.example.com/sse",
      http_headers: { Authorization: "Bearer tok" },
    });
  });

  it("has toml format and shared flag", () => {
    expect(agent.mcp.format).toBe("toml");
    expect(agent.mcp.shared).toBe(true);
  });
});

describe("vscode serializer", () => {
  const agent = getAgent("vscode")!;

  it("serializes stdio server with type and input refs", () => {
    const [name, config] = agent.serializeServer(STDIO_SERVER);
    expect(name).toBe("github");
    expect(config).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${input:GITHUB_TOKEN}" },
    });
  });

  it("serializes http server with http type", () => {
    const [name, config] = agent.serializeServer(HTTP_SERVER);
    expect(name).toBe("remote-api");
    expect(config).toEqual({
      type: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("omits env when empty", () => {
    const [, config] = agent.serializeServer(STDIO_NO_ENV);
    expect(config).toEqual({ type: "stdio", command: "mcp-server", args: [] });
    expect(config).not.toHaveProperty("env");
  });
});

describe("opencode serializer", () => {
  const agent = getAgent("opencode")!;

  it("serializes stdio server as local type with merged command", () => {
    const [name, config] = agent.serializeServer(STDIO_SERVER);
    expect(name).toBe("github");
    expect(config).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
  });

  it("serializes http server as remote type", () => {
    const [name, config] = agent.serializeServer(HTTP_SERVER);
    expect(name).toBe("remote-api");
    expect(config).toEqual({
      type: "remote",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("omits environment when no env vars", () => {
    const [, config] = agent.serializeServer(STDIO_NO_ENV);
    expect(config).toEqual({
      type: "local",
      command: ["mcp-server"],
    });
    expect(config).not.toHaveProperty("environment");
  });

  it("shares config and reads .agents/ natively", () => {
    expect(agent.mcp.shared).toBe(true);
    expect(agent.skillsParentDir).toBeUndefined();
  });
});
