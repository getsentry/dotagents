import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addSkillToConfig,
  removeSkillFromConfig,
  generateDefaultConfig,
} from "./writer.js";
import { loadConfig } from "./loader.js";

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

    it("sets gitignore to false by default", async () => {
      const config = await loadConfig(configPath);
      expect(config.gitignore).toBe(false);
    });

    it("contains gitignore = false in output", () => {
      const content = generateDefaultConfig();
      expect(content).toContain("gitignore = false");
    });

    it("sets gitignore = true when requested", () => {
      const content = generateDefaultConfig({ gitignore: true });
      expect(content).toContain("gitignore = true");
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
        gitignore: true,
        trust: { allow_all: false, github_orgs: ["my-org"], github_repos: [], git_domains: [] },
      });
      await writeFile(configPath, content);
      const config = await loadConfig(configPath);
      expect(config.version).toBe(1);
      expect(config.gitignore).toBe(true);
      expect(config.agents).toEqual(["claude"]);
      expect(config.trust?.github_orgs).toEqual(["my-org"]);
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
      expect(review?.path).toBe("skills/review");
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
  });
});
