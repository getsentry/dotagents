import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  default as trust,
  classifyTrustSource,
  runTrustAdd,
  runTrustRemove,
  getTrustList,
  TrustCommandError,
} from "./trust.js";
import { loadConfig } from "../../config/loader.js";
import type { ScopeRoot } from "../../scope.js";
import { validateTrustedSource } from "@sentry/dotagents-lib";

describe("trust", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let scope: ScopeRoot;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-trust-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    scope = {
      scope: "project",
      root: projectRoot,
      agentsDir: join(projectRoot, ".agents"),
      skillsDir: join(projectRoot, ".agents", "skills"),
      pluginsDir: join(projectRoot, ".agents", "plugins"),
      configPath: join(projectRoot, "agents.toml"),
      lockPath: join(projectRoot, "agents.lock"),
    };
  });

  afterEach(async () => {
    process.exitCode = undefined;
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  describe("classifyTrustSource", () => {
    it("classifies owner/repo as github_repos", () => {
      expect(classifyTrustSource("external-org/specific-repo")).toEqual({
        field: "github_repos",
        value: "external-org/specific-repo",
      });
    });

    it("classifies domain with dots as git_domains", () => {
      expect(classifyTrustSource("git.corp.example.com")).toEqual({
        field: "git_domains",
        value: "git.corp.example.com",
      });
    });

    it("classifies bare name as github_orgs", () => {
      expect(classifyTrustSource("getsentry")).toEqual({
        field: "github_orgs",
        value: "getsentry",
      });
    });

    it("classifies dotted-domain/path as git_domains", () => {
      // First segment has a dot → domain path, not GitHub owner/repo
      expect(classifyTrustSource("gitlab.com/owner")).toEqual({
        field: "git_domains",
        value: "gitlab.com/owner",
      });
      expect(classifyTrustSource("git.corp.co/team/repo")).toEqual({
        field: "git_domains",
        value: "git.corp.co/team/repo",
      });
    });

    describe("with defaultRepositorySource=gitlab", () => {
      it("expands bare org name to gitlab.com domain path", () => {
        expect(classifyTrustSource("myorg", "gitlab")).toEqual({
          field: "git_domains",
          value: "gitlab.com/myorg",
        });
      });

      it("expands owner/repo to gitlab.com domain path", () => {
        expect(classifyTrustSource("owner/repo", "gitlab")).toEqual({
          field: "git_domains",
          value: "gitlab.com/owner/repo",
        });
      });

      it("expands owner/group/repo to gitlab.com domain path", () => {
        expect(classifyTrustSource("owner/group/repo", "gitlab")).toEqual({
          field: "git_domains",
          value: "gitlab.com/owner/group/repo",
        });
      });

      it("does not expand sources that already contain dots", () => {
        expect(classifyTrustSource("gitlab.com", "gitlab")).toEqual({
          field: "git_domains",
          value: "gitlab.com",
        });
      });

      it("classifies dotted domain paths as git_domains even with gitlab default", () => {
        expect(classifyTrustSource("gitlab.com/owner", "gitlab")).toEqual({
          field: "git_domains",
          value: "gitlab.com/owner",
        });
      });
    });
  });

  describe("runTrustAdd", () => {
    it("creates [trust] section when absent", async () => {
      await runTrustAdd({ scope, source: "getsentry" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toContain("getsentry");
    });

    it("appends to existing trust field", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\n`,
      );

      await runTrustAdd({ scope, source: "anthropics" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toEqual(["getsentry", "anthropics"]);
    });

    it("adds new field to existing [trust] section", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\n`,
      );

      await runTrustAdd({ scope, source: "external/repo" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toEqual(["getsentry"]);
      expect(config.trust?.github_repos).toContain("external/repo");
    });

    it("rejects duplicates (case-insensitive)", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\n`,
      );

      await expect(
        runTrustAdd({ scope, source: "GetSentry" }),
      ).rejects.toThrow(TrustCommandError);
      await expect(
        runTrustAdd({ scope, source: "GetSentry" }),
      ).rejects.toThrow(/already in/);
    });

    it("expands gitlab shorthands when defaultRepositorySource=gitlab", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\ndefaultRepositorySource = "gitlab"\n`,
      );

      await runTrustAdd({ scope, source: "myorg" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.git_domains).toContain("gitlab.com/myorg");
      expect(config.trust?.github_orgs ?? []).toEqual([]);
    });

    it("expands gitlab owner/repo when defaultRepositorySource=gitlab", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\ndefaultRepositorySource = "gitlab"\n`,
      );

      await runTrustAdd({ scope, source: "owner/repo" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.git_domains).toContain("gitlab.com/owner/repo");
      expect(config.trust?.github_repos ?? []).toEqual([]);
    });

    it("inserts [trust] before [[skills]]", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[[skills]]\nname = "foo"\nsource = "org/repo"\n`,
      );

      await runTrustAdd({ scope, source: "getsentry" });

      const raw = await readFile(scope.configPath, "utf-8");
      const trustIdx = raw.indexOf("[trust]");
      const skillsIdx = raw.indexOf("[[skills]]");
      expect(trustIdx).toBeLessThan(skillsIdx);
    });
  });

  describe("runTrustRemove", () => {
    it("removes an entry", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry", "anthropics"]\n`,
      );

      await runTrustRemove({ scope, source: "getsentry" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toEqual(["anthropics"]);
    });

    it("preserves other trust fields when an array becomes empty", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\ngit_domains = ['example.com']\n`,
      );

      await runTrustRemove({ scope, source: "getsentry" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toEqual([]);
      expect(config.trust?.git_domains).toEqual(["example.com"]);
    });

    it("keeps an empty allow-list when the last source is removed", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\n`,
      );

      await runTrustRemove({ scope, source: "getsentry" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toEqual([]);
      expect(() => validateTrustedSource("getsentry/skills", config.trust)).toThrow(/not trusted/);
      expect(() => validateTrustedSource("other/skills", config.trust)).toThrow(/not trusted/);
    });

    it("throws for non-existent source", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\n`,
      );

      await expect(
        runTrustRemove({ scope, source: "nope" }),
      ).rejects.toThrow(TrustCommandError);
      await expect(
        runTrustRemove({ scope, source: "nope" }),
      ).rejects.toThrow(/not found/);
    });

    it("removes case-insensitively", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["GetSentry"]\n`,
      );

      await runTrustRemove({ scope, source: "getsentry" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs ?? []).toEqual([]);
    });

    it("removes single-quoted entries", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ['getsentry', 'anthropics']\n`,
      );

      await runTrustRemove({ scope, source: "getsentry" });

      const config = await loadConfig(scope.configPath);
      expect(config.trust?.github_orgs).toEqual(["anthropics"]);
    });
  });

  it("edits multiline trust arrays and preserves comments", async () => {
    await writeFile(
      scope.configPath,
      [
        "version = 1",
        "",
        "[trust]",
        "github_orgs = [",
        '  "getsentry", # internal',
        '  "anthropics" # vendor',
        "]",
        "",
      ].join("\n"),
    );

    await runTrustAdd({ scope, source: "vercel" });
    await runTrustRemove({ scope, source: "getsentry" });

    const config = await loadConfig(scope.configPath);
    expect(config.trust?.github_orgs).toEqual(["anthropics", "vercel"]);
    const raw = await readFile(scope.configPath, "utf-8");
    expect(raw).toContain("# vendor");
    expect(raw).toContain("# internal");

    await runTrustRemove({ scope, source: "anthropics" });
    await runTrustRemove({ scope, source: "vercel" });

    expect((await loadConfig(scope.configPath)).trust?.github_orgs).toEqual([]);
  });

  it.each([
    { name: "trailing comma", array: `['getsentry', 'anthropics',]`, kept: "anthropics" },
    { name: "escaped source", array: `["get\\u0073entry", "anthropics"]`, kept: "anthropics" },
    { name: "syntax inside strings", array: `['getsentry', 'org#]']`, kept: "org#]" },
    { name: "escaped quotes", array: String.raw`["getsentry", "org\"#]"]`, kept: 'org"#]' },
    { name: "multiline strings", array: `["""getsentry""", '''anthropics''']`, kept: "anthropics" },
    { name: "CRLF line endings", array: `[\r\n  'getsentry',\r\n  'anthropics'\r\n]`, kept: "anthropics" },
  ])("edits arrays with $name without changing other values", async ({ array, kept }) => {
    const newline = array.includes("\r\n") ? "\r\n" : "\n";
    const prefix = "version = 1\n# retain\n[trust] # allow-list\n".replaceAll("\n", newline);
    const suffix = "\n\n[custom]\ndate = 2026-10-20\nvalue = 'untouched' # retain\n".replaceAll("\n", newline);
    await writeFile(scope.configPath, `${prefix}\t'github_orgs'\t=\t${array}${suffix}`);

    await runTrustAdd({ scope, source: "vercel" });
    expect((await loadConfig(scope.configPath)).trust?.github_orgs).toEqual(["getsentry", kept, "vercel"]);
    await runTrustRemove({ scope, source: "GETSENTRY" });
    expect((await loadConfig(scope.configPath)).trust?.github_orgs).toEqual([kept, "vercel"]);
    const raw = await readFile(scope.configPath, "utf-8");
    expect(raw.startsWith(prefix)).toBe(true);
    expect(raw.endsWith(suffix)).toBe(true);
  });

  it.each([runTrustAdd, runTrustRemove])("rejects edits it cannot locate without writing the file", async (mutate) => {
    const input = `version = 1\ntrust = { github_orgs = ['getsentry'] }\n`;
    await writeFile(scope.configPath, input);

    await expect(mutate({ scope, source: mutate === runTrustAdd ? "vercel" : "getsentry" })).rejects.toThrow(/Cannot locate/);
    expect(await readFile(scope.configPath, "utf-8")).toBe(input);
  });

  it("rejects an edit to a matching header inside a string without writing the file", async () => {
    const input = `version = 1\nnotes = '''\n[trust]\ngithub_orgs = ['getsentry']\n'''\n[trust]\ngithub_orgs = ['getsentry']\n`;
    await writeFile(scope.configPath, input);

    await expect(runTrustRemove({ scope, source: "getsentry" })).rejects.toThrow(/Could not remove/);
    expect(await readFile(scope.configPath, "utf-8")).toBe(input);
  });

  describe("getTrustList", () => {
    it("returns empty for no trust section", async () => {
      const config = await loadConfig(scope.configPath);
      expect(getTrustList(config)).toEqual([]);
    });

    it("returns allow_all when set", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\nallow_all = true\n`,
      );
      const config = await loadConfig(scope.configPath);
      expect(getTrustList(config)).toBe("allow_all");
    });

    it("returns entries with type labels", async () => {
      await writeFile(
        scope.configPath,
        `version = 1\n\n[trust]\ngithub_orgs = ["getsentry"]\ngithub_repos = ["ext/repo"]\ngit_domains = ["git.corp.com"]\n`,
      );
      const config = await loadConfig(scope.configPath);
      const entries = getTrustList(config);
      expect(entries).toEqual([
        { type: "github_org", value: "getsentry" },
        { type: "github_repo", value: "ext/repo" },
        { type: "git_domain", value: "git.corp.com" },
      ]);
    });
  });

  it("includes explicit project scope in nested usage errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await trust(["add"], { scope });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("npx @sentry/dotagents --project trust add"));
    error.mockRestore();
  });
});
