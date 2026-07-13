import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addSkillToConfig,
  addWildcardToConfig,
  addExcludeToWildcard,
  removeSkillFromConfig,
  removeSkillBlocksBySource,
  addMcpToConfig,
  removeMcpFromConfig,
  generateDefaultConfig,
} from "./writer.js";
import { loadConfig } from "./loader.js";
import { isWildcardDep } from "./schema.js";

describe("writer", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dotagents-test-"));
    configPath = join(dir, "agents.toml");
    await writeFile(configPath, generateDefaultConfig());
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  describe("generateDefaultConfig", () => {
    it("produces valid TOML that parses", async () => {
      const config = await loadConfig(configPath);
      expect(config.version).toBe(1);
      expect(config.skills).toEqual([]);
    });

    it("does not contain gitignore field", () => {
      const content = generateDefaultConfig();
      expect(content).not.toContain("gitignore");
    });

    it("does not contain pin", () => {
      const content = generateDefaultConfig();
      expect(content).not.toContain("pin");
    });

    it("includes agents when provided via options object", () => {
      const content = generateDefaultConfig({ agents: ["claude", "cursor"] });
      expect(content).toContain('agents = ["claude", "cursor"]');
    });

    it("backwards-compat: accepts bare string[]", () => {
      const content = generateDefaultConfig(["claude"]);
      expect(content).toContain('agents = ["claude"]');
    });

    it("includes [trust] with allow_all", () => {
      const content = generateDefaultConfig({
        trust: { allow_all: true, github_orgs: [], github_repos: [], git_domains: [] },
      });
      expect(content).toContain("[trust]");
      expect(content).toContain("allow_all = true");
    });

    it("includes [trust] with restrictions", () => {
      const content = generateDefaultConfig({
        trust: {
          allow_all: false,
          github_orgs: ["anthropics"],
          github_repos: ["owner/repo"],
          git_domains: ["gitlab.example.com"],
        },
      });
      expect(content).toContain("[trust]");
      expect(content).toMatch(/github_orgs\s*=.*"anthropics"/);
      expect(content).toMatch(/github_repos\s*=.*"owner\/repo"/);
      expect(content).toMatch(/git_domains\s*=.*"gitlab\.example\.com"/);
      expect(content).not.toContain("allow_all");
    });

    it("omits [trust] when no restrictions set", () => {
      const content = generateDefaultConfig({
        trust: { allow_all: false, github_orgs: [], github_repos: [], git_domains: [] },
      });
      expect(content).not.toContain("[trust]");
    });

    it("generates valid TOML with all options combined", async () => {
      const content = generateDefaultConfig({
        agents: ["claude"],
        trust: { allow_all: false, github_orgs: ["my-org"], github_repos: [], git_domains: [] },
      });
      await writeFile(configPath, content);
      const config = await loadConfig(configPath);
      expect(config.version).toBe(1);
      expect(config.agents).toEqual(["claude"]);
      expect(config.trust?.github_orgs).toEqual(["my-org"]);
    });

    it("includes [[skills]] when skills are provided", () => {
      const content = generateDefaultConfig({
        skills: [{ name: "dotagents", source: "getsentry/dotagents" }],
      });
      expect(content).toContain("[[skills]]");
      expect(content).toContain('name = "dotagents"');
      expect(content).toContain('source = "getsentry/dotagents"');
    });

    it("includes ref and path in skills when provided", () => {
      const content = generateDefaultConfig({
        skills: [{ name: "my-skill", source: "org/repo", ref: "v1.0.0", path: "skills/my-skill" }],
      });
      expect(content).toContain('ref = "v1.0.0"');
      expect(content).toContain('path = "skills/my-skill"');
    });

    it("has no skills when skills option is omitted", () => {
      const content = generateDefaultConfig();
      expect(content).not.toContain("[[skills]]");
    });

    it("has no skills when skills array is empty", () => {
      const content = generateDefaultConfig({ skills: [] });
      expect(content).not.toContain("[[skills]]");
    });

    it("round-trips skills through loadConfig", async () => {
      const content = generateDefaultConfig({
        skills: [
          { name: "dotagents", source: "getsentry/dotagents" },
          { name: "find-bugs", source: "getsentry/skills", ref: "v2.0.0" },
        ],
      });
      await writeFile(configPath, content);
      const config = await loadConfig(configPath);
      expect(config.skills).toHaveLength(2);
      expect(config.skills[0]!.name).toBe("dotagents");
      expect(config.skills[0]!.source).toBe("getsentry/dotagents");
      expect(config.skills[1]!.name).toBe("find-bugs");
      expect(config.skills[1]!.ref).toBe("v2.0.0");
    });
  });

  describe("addSkillToConfig", () => {
    it("adds a skill with source only", async () => {
      await addSkillToConfig(configPath, "pdf", {
        source: "anthropics/skills",
      });

      const config = await loadConfig(configPath);
      const pdf = config.skills.find((s) => s.name === "pdf");
      expect(pdf?.source).toBe("anthropics/skills");
    });

    it("adds a skill with source and ref", async () => {
      await addSkillToConfig(configPath, "pdf", {
        source: "anthropics/skills",
        ref: "v1.0.0",
      });

      const config = await loadConfig(configPath);
      const pdf = config.skills.find((s) => s.name === "pdf");
      expect(pdf?.ref).toBe("v1.0.0");
    });

    it("adds a skill with source, ref, and path", async () => {
      await addSkillToConfig(configPath, "review", {
        source: "git:https://example.com/repo.git",
        ref: "main",
        path: "skills/review",
      });

      const config = await loadConfig(configPath);
      const review = config.skills.find((s) => s.name === "review");
      expect(review?.source).toBe("git:https://example.com/repo.git");
      expect(review && "path" in review ? review.path : undefined).toBe("skills/review");
    });

    it("adds multiple skills", async () => {
      await addSkillToConfig(configPath, "a", {
        source: "org/repo-a",
      });
      await addSkillToConfig(configPath, "b", {
        source: "org/repo-b",
      });

      const config = await loadConfig(configPath);
      expect(config.skills).toHaveLength(2);
    });

    it("adds in-place skill with path source", async () => {
      await addSkillToConfig(configPath, "my-skill", {
        source: "path:.agents/skills/my-skill",
      });

      const config = await loadConfig(configPath);
      const skill = config.skills.find((s) => s.name === "my-skill");
      expect(skill).toBeDefined();
      expect(skill!.source).toBe("path:.agents/skills/my-skill");
    });
  });

  describe("removeSkillFromConfig", () => {
    it("removes an existing skill", async () => {
      await addSkillToConfig(configPath, "pdf", {
        source: "anthropics/skills",
        ref: "v1.0.0",
      });
      await removeSkillFromConfig(configPath, "pdf");

      const config = await loadConfig(configPath);
      expect(config.skills.find((s) => s.name === "pdf")).toBeUndefined();
    });

    it("preserves other skills when removing one", async () => {
      await addSkillToConfig(configPath, "a", {
        source: "org/repo-a",
      });
      await addSkillToConfig(configPath, "b", {
        source: "org/repo-b",
      });
      await removeSkillFromConfig(configPath, "a");

      const config = await loadConfig(configPath);
      expect(config.skills.find((s) => s.name === "a")).toBeUndefined();
      expect(config.skills.find((s) => s.name === "b")?.source).toBe("org/repo-b");
    });

    it("is a no-op for non-existent skill", async () => {
      const before = await readFile(configPath, "utf-8");
      await removeSkillFromConfig(configPath, "nope");
      const after = await readFile(configPath, "utf-8");
      expect(after).toBe(before);
    });

    it.each([
      {
        operation: "named skill",
        input: `version = 1\n# keep this comment\n\n  [[skills]]\n  name\t=\t'remove-me' # target\n  source\t=\t'org/remove'\n\n[[skills]]\nname = 'keep-me'\nsource = 'org/keep'\n\n[misc]\nvalue = 'unchanged'\n`,
        expected: `version = 1\n# keep this comment\n\n[[skills]]\nname = 'keep-me'\nsource = 'org/keep'\n\n[misc]\nvalue = 'unchanged'\n`,
        expectedNames: ["keep-me"],
        mutate: () => removeSkillFromConfig(configPath, "remove-me"),
      },
      {
        operation: "matching source",
        input: `version = 1\n\n[[skills]]\nname = 'remove-a'\nsource = 'org/remove'\n\n[[skills]]\nname = "keep"\nsource = "org/keep"\n\n[[skills]]\nname = 'remove-b'\nsource = 'https://github.com/org/remove.git'\n\n[[mcp]]\nname = 'manual'\ncommand = 'keep-this'\n`,
        expected: `version = 1\n\n[[skills]]\nname = "keep"\nsource = "org/keep"\n\n[[mcp]]\nname = 'manual'\ncommand = 'keep-this'\n`,
        expectedNames: ["keep"],
        mutate: () => removeSkillBlocksBySource(configPath, "org/remove"),
      },
    ])("preserves unrelated text when removing a $operation", async ({ input, expected, expectedNames, mutate }) => {
      await writeFile(configPath, input);

      await mutate();

      expect(await readFile(configPath, "utf-8")).toBe(expected);
      const config = await loadConfig(configPath);
      expect(config.skills.map((skill) => skill.name)).toEqual(expectedNames);
    });

    it("leaves source-based removal text unchanged when no source matches", async () => {
      const input = `version = 1\n\n[[skills]]\n  name = 'keep'\n  source = 'org/keep' # comment\n`;
      await writeFile(configPath, input);

      await removeSkillBlocksBySource(configPath, "org/missing");

      expect(await readFile(configPath, "utf-8")).toBe(input);
    });
  });

  describe("addWildcardToConfig", () => {
    it("adds a wildcard entry", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills");

      const config = await loadConfig(configPath);
      expect(config.skills).toHaveLength(1);
      const dep = config.skills[0]!;
      expect(dep.name).toBe("*");
      expect(dep.source).toBe("getsentry/skills");
    });

    it("adds wildcard with ref", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills", { ref: "v1.0.0", exclude: [] });

      const config = await loadConfig(configPath);
      const dep = config.skills[0]!;
      expect(dep.ref).toBe("v1.0.0");
    });

    it("adds wildcard with exclude list", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills", {
        exclude: ["deprecated-skill"],
      });

      const config = await loadConfig(configPath);
      const dep = config.skills[0]!;
      expect(isWildcardDep(dep)).toBe(true);
      if (isWildcardDep(dep)) {
        expect(dep.exclude).toEqual(["deprecated-skill"]);
      }
    });

    it("round-trips with loadConfig", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills");
      await addSkillToConfig(configPath, "pdf", { source: "anthropics/skills" });

      const config = await loadConfig(configPath);
      expect(config.skills).toHaveLength(2);
      expect(config.skills.some((s) => s.name === "*")).toBe(true);
      expect(config.skills.some((s) => s.name === "pdf")).toBe(true);
    });
  });

  describe("addExcludeToWildcard", () => {
    it("adds a skill to exclude list of new wildcard", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills");
      await addExcludeToWildcard(configPath, "getsentry/skills", "deprecated");

      const config = await loadConfig(configPath);
      const dep = config.skills[0]!;
      expect(isWildcardDep(dep)).toBe(true);
      if (isWildcardDep(dep)) {
        expect(dep.exclude).toContain("deprecated");
      }
    });

    it("appends to existing exclude list", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills", {
        exclude: ["old-skill"],
      });
      await addExcludeToWildcard(configPath, "getsentry/skills", "another-skill");

      const config = await loadConfig(configPath);
      const dep = config.skills[0]!;
      expect(isWildcardDep(dep)).toBe(true);
      if (isWildcardDep(dep)) {
        expect(dep.exclude).toContain("old-skill");
        expect(dep.exclude).toContain("another-skill");
      }
    });

    it("only modifies the matching wildcard source", async () => {
      await addWildcardToConfig(configPath, "getsentry/skills");
      await addWildcardToConfig(configPath, "anthropics/skills");
      await addExcludeToWildcard(configPath, "getsentry/skills", "my-skill");

      // The anthropics entry should not have an exclude
      const config = await loadConfig(configPath);
      const getsentry = config.skills.find((s) => s.source === "getsentry/skills");
      const anthropics = config.skills.find((s) => s.source === "anthropics/skills");
      expect(isWildcardDep(getsentry!) && getsentry!.exclude).toContain("my-skill");
      expect(isWildcardDep(anthropics!) && anthropics!.exclude).toEqual([]);
    });

    it("preserves indentation and comments around an existing exclude list", async () => {
      const input = `version = 1\n\n  [[skills]]\n  name = '*'\n  source = 'getsentry/skills'\n  exclude = ['old'] # keep this\n\n[misc]\nvalue = 'unchanged'\n`;
      await writeFile(configPath, input);

      await addExcludeToWildcard(configPath, "getsentry/skills", "new");

      expect(await readFile(configPath, "utf-8")).toBe(
        `version = 1\n\n  [[skills]]\n  name = '*'\n  source = 'getsentry/skills'\n  exclude = ['old', "new"] # keep this\n\n[misc]\nvalue = 'unchanged'\n`,
      );
      const config = await loadConfig(configPath);
      const wildcard = config.skills[0]!;
      expect(isWildcardDep(wildcard) && wildcard.exclude).toEqual(["old", "new"]);
    });
  });

  describe("addMcpToConfig", () => {
    it("adds a stdio server", async () => {
      await addMcpToConfig(configPath, {
        name: "github",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: ["GITHUB_TOKEN"],
      });

      const config = await loadConfig(configPath);
      expect(config.mcp).toHaveLength(1);
      const mcp = config.mcp[0]!;
      expect(mcp.name).toBe("github");
      expect(mcp.command).toBe("npx");
      expect(mcp.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
      expect(mcp.env).toEqual(["GITHUB_TOKEN"]);
    });

    it("adds an http server with headers", async () => {
      await addMcpToConfig(configPath, {
        name: "remote",
        url: "https://mcp.example.com/sse",
        headers: { Authorization: "Bearer tok" },
        env: [],
      });

      const config = await loadConfig(configPath);
      expect(config.mcp).toHaveLength(1);
      const mcp = config.mcp[0]!;
      expect(mcp.name).toBe("remote");
      expect(mcp.url).toBe("https://mcp.example.com/sse");
      expect(mcp.headers).toEqual({ Authorization: "Bearer tok" });
    });

    it("adds multiple servers", async () => {
      await addMcpToConfig(configPath, {
        name: "a",
        command: "cmd-a",
        env: [],
      });
      await addMcpToConfig(configPath, {
        name: "b",
        url: "https://b.example.com",
        env: [],
      });

      const config = await loadConfig(configPath);
      expect(config.mcp).toHaveLength(2);
    });
  });

  describe("removeMcpFromConfig", () => {
    it("removes an existing server", async () => {
      await addMcpToConfig(configPath, {
        name: "github",
        command: "npx",
        env: [],
      });
      await removeMcpFromConfig(configPath, "github");

      const config = await loadConfig(configPath);
      expect(config.mcp).toHaveLength(0);
    });

    it("preserves other servers when removing one", async () => {
      await addMcpToConfig(configPath, {
        name: "a",
        command: "cmd-a",
        env: [],
      });
      await addMcpToConfig(configPath, {
        name: "b",
        command: "cmd-b",
        env: [],
      });
      await removeMcpFromConfig(configPath, "a");

      const config = await loadConfig(configPath);
      expect(config.mcp).toHaveLength(1);
      expect(config.mcp[0]!.name).toBe("b");
    });

    it("is a no-op for non-existent server", async () => {
      const before = await readFile(configPath, "utf-8");
      await removeMcpFromConfig(configPath, "nope");
      const after = await readFile(configPath, "utf-8");
      expect(after).toBe(before);
    });

    it("does not affect skills with same name", async () => {
      await addSkillToConfig(configPath, "github", {
        source: "org/github-skill",
      });
      await addMcpToConfig(configPath, {
        name: "github",
        command: "npx",
        env: [],
      });
      await removeMcpFromConfig(configPath, "github");

      const config = await loadConfig(configPath);
      expect(config.mcp).toHaveLength(0);
      expect(config.skills.find((s) => s.name === "github")).toBeDefined();
    });

    it("preserves comments, quoting, indentation, and adjacent sections", async () => {
      const input = `version = 1\n# retained\n\n  [[mcp]]\n  name = 'remove-me'\n  command = 'old-command'\n[[mcp]]\nname = 'keep-me'\ncommand = 'keep-command' # retained inline\n\n[trust]\ngithub_orgs = ['example']\n`;
      const expected = `version = 1\n# retained\n[[mcp]]\nname = 'keep-me'\ncommand = 'keep-command' # retained inline\n\n[trust]\ngithub_orgs = ['example']\n`;
      await writeFile(configPath, input);

      await removeMcpFromConfig(configPath, "remove-me");

      expect(await readFile(configPath, "utf-8")).toBe(expected);
      const config = await loadConfig(configPath);
      expect(config.mcp.map((server) => server.name)).toEqual(["keep-me"]);
      expect(config.trust?.github_orgs).toEqual(["example"]);
    });
  });
});
