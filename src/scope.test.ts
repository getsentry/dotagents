import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveScope } from "./scope.js";

describe("resolveScope", () => {
  afterEach(() => {
    delete process.env["DOTAGENTS_HOME"];
  });

  it("project scope uses projectRoot", () => {
    const s = resolveScope("project", "/tmp/my-project");
    expect(s.scope).toBe("project");
    expect(s.root).toBe("/tmp/my-project");
    expect(s.agentsDir).toBe("/tmp/my-project/.agents");
    expect(s.configPath).toBe("/tmp/my-project/agents.toml");
    expect(s.lockPath).toBe("/tmp/my-project/agents.lock");
    expect(s.skillsDir).toBe("/tmp/my-project/.agents/skills");
  });

  it("user scope uses ~/.agents by default", () => {
    const s = resolveScope("user");
    const expected = join(homedir(), ".agents");
    expect(s.scope).toBe("user");
    expect(s.root).toBe(expected);
    expect(s.agentsDir).toBe(expected);
    expect(s.configPath).toBe(join(expected, "agents.toml"));
    expect(s.lockPath).toBe(join(expected, "agents.lock"));
    expect(s.skillsDir).toBe(join(expected, "skills"));
  });

  it("user scope respects DOTAGENTS_HOME override", () => {
    process.env["DOTAGENTS_HOME"] = "/tmp/fake-home";
    const s = resolveScope("user");
    expect(s.root).toBe("/tmp/fake-home");
    expect(s.agentsDir).toBe("/tmp/fake-home");
    expect(s.skillsDir).toBe("/tmp/fake-home/skills");
  });

  it("user scope: agentsDir equals root (flat layout)", () => {
    process.env["DOTAGENTS_HOME"] = "/tmp/user-agents";
    const s = resolveScope("user");
    expect(s.agentsDir).toBe(s.root);
  });

  it("project scope defaults to cwd when no projectRoot given", () => {
    const s = resolveScope("project");
    expect(s.root).toBe(process.cwd());
  });
});
