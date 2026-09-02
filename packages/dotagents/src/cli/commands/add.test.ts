import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as clack from "@clack/prompts";
import addCommand, {
  runAdd as runAddCommand,
  AddCancelledError,
  AddError,
  type AddOptions,
  type AddPrompts,
} from "./add.js";
import * as installModule from "./install.js";
import { TrustError, exec } from "@sentry/dotagents-lib";
import { resolveScope } from "../../scope.js";
import type { CommandContext } from "../context.js";
import { z } from "zod/v4";

const prompts = {
  select: vi.fn<AddPrompts["select"]>(),
  multiselect: vi.fn<AddPrompts["multiselect"]>(),
  isCancel: vi.fn<AddPrompts["isCancel"]>(clack.isCancel),
  spinner: vi.fn<AddPrompts["spinner"]>(),
} satisfies AddPrompts;

const gitTraceEventSchema = z.object({
  event: z.string(),
  argv: z.array(z.string()).optional(),
}).passthrough();

function runAdd(opts: AddOptions): ReturnType<typeof runAddCommand> {
  return runAddCommand({ ...opts, prompts });
}

function add(args: string[], context: CommandContext): Promise<void> {
  return addCommand(args, context, prompts);
}

const SKILL_MD = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

# ${name}
`;

async function writePlugin(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.json"), JSON.stringify({ name }));
}

function mockRunInstall() {
  return vi.spyOn(installModule, "runInstall").mockResolvedValue({
    installed: [],
    installedPlugins: [],
    pruned: [],
    prunedPlugins: [],
    mcpWarnings: [],
    hookWarnings: [],
    subagentWarnings: [],
    pluginWarnings: [],
  });
}

function countGitFetches(tracePath: string): number {
  if (!existsSync(tracePath)) {return 0;}
  return readFileSync(tracePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => gitTraceEventSchema.parse(JSON.parse(line)))
    .filter((event) => event.event === "start" && event.argv?.[1] === "fetch")
    .length;
}

describe("runAdd", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-add-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Set up project
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    // Create a local git repo with skills
    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));
    await writeFile(join(repoDir, "pdf", "prompt.md"), "Process PDFs");

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    await mkdir(join(repoDir, "skills", "commit"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "commit", "SKILL.md"),
      SKILL_MD("commit"),
    );

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env["DOTAGENTS_STATE_DIR"];
    delete process.env["GIT_CONFIG_COUNT"];
    delete process.env["GIT_CONFIG_KEY_0"];
    delete process.env["GIT_CONFIG_VALUE_0"];
    delete process.env["GIT_TRACE2_EVENT"];
    await rm(tmpDir, { recursive: true });
  });

  it("does not fetch a git source again during the nested install", async () => {
    const tracePath = join(tmpDir, "add-git-trace.json");
    process.env["GIT_TRACE2_EVENT"] = tracePath;
    const scope = resolveScope("project", projectRoot);
    let fetchesBeforeInstall = -1;

    await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf"],
      progress: {
        start(message) {
          if (message === "Installing components") {
            fetchesBeforeInstall = countGitFetches(tracePath);
          }
        },
        message() {},
        stop() {},
        error() {},
      },
    });

    expect(fetchesBeforeInstall).toBeGreaterThanOrEqual(0);
    expect(countGitFetches(tracePath)).toBe(fetchesBeforeInstall);

    const installTracePath = join(tmpDir, "install-git-trace.json");
    process.env["GIT_TRACE2_EVENT"] = installTracePath;
    await installModule.runInstall({ scope });
    const installEvents = (await readFile(installTracePath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => gitTraceEventSchema.parse(JSON.parse(line)));
    const installFetches = installEvents.filter(
      (event) => event.event === "start" && event.argv?.[1] === "fetch",
    );
    expect(installFetches).toHaveLength(1);
  });

  it("restores the acquired commit after another dependency checks out a different ref", async () => {
    await exec("git", ["branch", "stable", "HEAD"], { cwd: repoDir });
    await writeFile(
      join(repoDir, "pdf", "SKILL.md"),
      `${SKILL_MD("pdf")}\nLatest main content\n`,
    );
    await exec("git", ["add", "pdf/SKILL.md"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "update pdf on main"], { cwd: repoDir });
    const { stdout: latestStdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
    });
    const latestCommit = latestStdout.trim();
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\nref = "stable"\n`,
    );

    await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: `git:${repoDir}`,
      names: ["pdf"],
    });

    expect(
      await readFile(join(projectRoot, ".agents", "skills", "pdf", "SKILL.md"), "utf-8"),
    ).toContain("Latest main content");
    expect(await readFile(join(projectRoot, "agents.lock"), "utf-8")).toContain(latestCommit);
  });

  it("adds a single skill via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf"],
    });

    expect(result).toBe("pdf");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
  });

  it("adds multiple skills via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf", "review"],
    });

    expect(result).toEqual(["pdf", "review"]);

    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
    expect(toml).toContain('name = "review"');
  });

  it("throws when a skill is not found", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["nonexistent"],
      }),
    ).rejects.toThrow(AddError);
  });

  it("validates every requested git skill before writing", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["pdf", "nonexistent"],
      }),
    ).rejects.toThrow(AddError);

    // "pdf" should NOT have been partially added
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).not.toContain('name = "pdf"');
  });

  it("refreshes an exactly matching single skill", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const install = mockRunInstall();
    await expect(runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf"],
    })).resolves.toBe("pdf");

    expect(install).toHaveBeenCalledOnce();
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe(
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );
  });

  it("rejects a single skill with the same name from a different source", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      'version = 1\n\n[[skills]]\nname = "pdf"\nsource = "other/repo"\n',
    );

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: `git:${repoDir}`,
      names: ["pdf"],
    })).rejects.toThrow("different source or ref");
  });

  it("skips existing skills only for a multi-name request", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["review", "pdf"],
    });

    // Only "review" should be added; "pdf" was skipped
    expect(result).toEqual(["review"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "review"');
  });

  it("refreshes when all specified skills already exist exactly", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const install = mockRunInstall();
    await expect(runAdd({
      scope,
      specifier: `git:${repoDir}`,
      names: ["pdf", "review"],
    })).resolves.toEqual(["pdf", "review"]);
    expect(install).toHaveBeenCalledOnce();
  });

  it("reports only conflicting skills in a mixed duplicate request", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "git:${repoDir}"\n\n[[skills]]\nname = "review"\nsource = "other/repo"\n`,
    );

    const error = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: `git:${repoDir}`,
      names: ["pdf", "review"],
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AddError);
    if (!(error instanceof Error)) {throw new Error("expected add to reject");}
    expect(error.message).toBe(
      "Skills already exist in agents.toml with a different source or ref: review.",
    );
  });

  it("throws when --all is used with names", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        names: ["invalid/name"],
        all: true,
      }),
    ).rejects.toThrow("Cannot use --all with --name. Use one or the other.");
  });

  it("refreshes an existing wildcard after source classification", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "*"\nsource = "git:${repoDir}"\n`,
    );

    const scope = resolveScope("project", projectRoot);
    const install = mockRunInstall();
    await expect(runAdd({
      scope,
      specifier: `git:${repoDir}`,
      all: true,
    })).resolves.toBe("*");
    expect(install).toHaveBeenCalledOnce();
  });

  it("validates trust against expanded source, not raw shorthand", async () => {
    // When defaultRepositorySource=gitlab, a shorthand like "getsentry/skills"
    // should be validated as a GitLab source, not a GitHub source.
    // github_orgs=["getsentry"] should NOT allow it — the clone targets GitLab.
    await writeFile(
      join(projectRoot, "agents.toml"),
      [
        "version = 1",
        'defaultRepositorySource = "gitlab"',
        "",
        "[trust]",
        'github_orgs = ["getsentry"]',
        "",
      ].join("\n"),
    );

    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: "getsentry/skills",
        names: ["pdf"],
      }),
    ).rejects.toThrow(TrustError);
  });

  it("stores the original source spelling and installs once", async () => {
    const shorthand = "local/source-spelling";
    process.env["GIT_CONFIG_COUNT"] = "1";
    process.env["GIT_CONFIG_KEY_0"] = `url.file://${repoDir}.insteadOf`;
    process.env["GIT_CONFIG_VALUE_0"] = `https://github.com/${shorthand}`;
    const installSpy = vi.spyOn(installModule, "runInstall").mockResolvedValue({
      installed: [],
      installedPlugins: [],
      pruned: [],
      prunedPlugins: [],
      mcpWarnings: [],
      hookWarnings: [],
      subagentWarnings: [],
      pluginWarnings: [],
    });

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: shorthand,
      all: true,
    });

    expect(result).toBe("*");
    expect(installSpy).toHaveBeenCalledOnce();
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain(`source = "${shorthand}"`);
    expect(toml).not.toContain(`source = "https://github.com/${shorthand}"`);
  });

  it("classifies an acquired git repository as a plugin source", async () => {
    await writePlugin(join(repoDir, "plugins", "git-plugin"), "git-plugin");
    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "add plugin"], { cwd: repoDir });
    mockRunInstall();

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: `git:${repoDir}`,
      names: ["git-plugin"],
    });

    expect(result).toBe("git-plugin");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain("[[plugins]]");
    expect(toml).toContain('path = "plugins/git-plugin"');
    expect(toml).not.toContain("[[skills]]");
  });

  it("selects explicit well-known names like git catalog names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("index.json")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              skills: ["pdf", "review"].map((name) => ({
                name,
                description: `Test skill ${name}`,
                files: ["SKILL.md"],
              })),
            }),
          });
        }
        const name = url.includes("/pdf/") ? "pdf" : "review";
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(SKILL_MD(name)),
        });
      }),
    );

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "https://skills.example.com",
      names: ["pdf", "review"],
    });

    expect(result).toEqual(["pdf", "review"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
    expect(toml).toContain('name = "review"');
  });

  it("auto-selects when repo has a single skill", async () => {
    // Create a repo with only one skill
    const singleRepo = join(tmpDir, "single-repo");
    await mkdir(singleRepo, { recursive: true });
    await exec("git", ["init"], { cwd: singleRepo });
    await exec("git", ["config", "user.email", "test@test.com"], {
      cwd: singleRepo,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: singleRepo });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: singleRepo });
    await mkdir(join(singleRepo, "only-skill"), { recursive: true });
    await writeFile(
      join(singleRepo, "only-skill", "SKILL.md"),
      SKILL_MD("only-skill"),
    );
    await exec("git", ["add", "."], { cwd: singleRepo });
    await exec("git", ["commit", "-m", "initial"], { cwd: singleRepo });

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: `git:${singleRepo}`,
      interactive: false,
    });

    expect(result).toBe("only-skill");
  });

  it("throws in non-interactive mode with multiple skills and no names", async () => {
    const scope = resolveScope("project", projectRoot);
    await expect(
      runAdd({
        scope,
        specifier: `git:${repoDir}`,
        interactive: false,
      }),
    ).rejects.toThrow(/Multiple skills found/);
  });

  it("cancels interactive catalog selection before writing", async () => {
    prompts.select.mockResolvedValue("pick");
    prompts.isCancel.mockReturnValue(true);

    await expect(
      runAdd({
        scope: resolveScope("project", projectRoot),
        specifier: `git:${repoDir}`,
        interactive: true,
      }),
    ).rejects.toBeInstanceOf(AddCancelledError);

    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe(
      "version = 1\n",
    );
  });

  it("persists an interactive all selection and installs once", async () => {
    prompts.select.mockResolvedValue("all");
    prompts.isCancel.mockReturnValue(false);
    const install = vi.spyOn(installModule, "runInstall").mockResolvedValue({
      installed: [],
      installedPlugins: [],
      pruned: [],
      prunedPlugins: [],
      mcpWarnings: [],
      hookWarnings: [],
      subagentWarnings: [],
      pluginWarnings: [],
    });

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: `git:${repoDir}`,
      interactive: true,
    });

    expect(result).toBe("*");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toContain(
      'name = "*"',
    );
    expect(install).toHaveBeenCalledOnce();
  });

  it("persists interactive skill selections and installs once", async () => {
    prompts.select.mockResolvedValue("pick");
    prompts.multiselect.mockResolvedValue(["pdf", "review"]);
    prompts.isCancel.mockReturnValue(false);
    const install = vi.spyOn(installModule, "runInstall").mockResolvedValue({
      installed: [],
      installedPlugins: [],
      pruned: [],
      prunedPlugins: [],
      mcpWarnings: [],
      hookWarnings: [],
      subagentWarnings: [],
      pluginWarnings: [],
    });

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: `git:${repoDir}`,
      interactive: true,
    });

    expect(result).toEqual(["pdf", "review"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
    expect(toml).toContain('name = "review"');
    expect(install).toHaveBeenCalledOnce();
  });
});

describe("runAdd (local sources)", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let localSkillsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-add-local-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;

    // Set up project with a local skills directory inside it
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

    // Create a local directory with multiple skills (inside project root)
    localSkillsDir = join(projectRoot, "local-skills");
    await mkdir(join(localSkillsDir, "pdf"), { recursive: true });
    await writeFile(join(localSkillsDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(localSkillsDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(localSkillsDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    await mkdir(join(localSkillsDir, "skills", "commit"), { recursive: true });
    await writeFile(
      join(localSkillsDir, "skills", "commit", "SKILL.md"),
      SKILL_MD("commit"),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["DOTAGENTS_STATE_DIR"];
    await rm(tmpDir, { recursive: true });
  });

  it("adds a single local skill without names (reads root SKILL.md)", async () => {
    // Create a single-skill local directory with SKILL.md at root
    const singleSkillDir = join(projectRoot, "my-skill");
    await mkdir(singleSkillDir, { recursive: true });
    await writeFile(join(singleSkillDir, "SKILL.md"), SKILL_MD("my-skill"));

    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: "path:my-skill",
    });

    expect(result).toBe("my-skill");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "my-skill"');
  });

  it("adds a single local skill via names", async () => {
    const scope = resolveScope("project", projectRoot);
    const result = await runAdd({
      scope,
      specifier: "path:local-skills",
      names: ["pdf"],
    });

    expect(result).toBe("pdf");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "pdf"');
  });

  it("prefers a plugin over standalone and bundled skills for the whole source", async () => {
    const sourceDir = join(projectRoot, "mixed-source");
    await writePlugin(sourceDir, "review-plugin");
    await mkdir(join(sourceDir, "skills", "bundled"), { recursive: true });
    await writeFile(join(sourceDir, "skills", "bundled", "SKILL.md"), SKILL_MD("bundled"));
    await mkdir(join(sourceDir, "standalone"), { recursive: true });
    await writeFile(join(sourceDir, "standalone", "SKILL.md"), SKILL_MD("standalone"));
    const install = mockRunInstall();

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:mixed-source",
    });

    expect(result).toBe("review-plugin");
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain("[[plugins]]");
    expect(toml).toContain('name = "review-plugin"');
    expect(toml).toContain('path = "."');
    expect(toml).not.toContain("[[skills]]");
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not fall back to skills when a plugin manifest is malformed", async () => {
    const sourceDir = join(projectRoot, "broken-plugin-source");
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(join(sourceDir, "plugin.json"), "{");

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:broken-plugin-source",
      names: ["review"],
    })).rejects.toThrow(join(sourceDir, "plugin.json"));
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");
  });

  it("does not fall back to skills when a named marketplace plugin has no manifest", async () => {
    const sourceDir = join(projectRoot, "broken-marketplace-source");
    await mkdir(join(sourceDir, "plugins", "review"), { recursive: true });
    await mkdir(join(sourceDir, "skills", "review"), { recursive: true });
    await writeFile(join(sourceDir, "skills", "review", "SKILL.md"), SKILL_MD("review"));
    await writeFile(join(sourceDir, "marketplace.json"), JSON.stringify({
      name: "broken",
      plugins: [{ name: "review", source: "./plugins/review" }],
    }));

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:broken-marketplace-source",
      names: ["review"],
    })).rejects.toThrow(/Marketplace plugin "review".*has no supported plugin manifest/);
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");
  });

  it("preflights plugin names and persists exact paths and refs in one install", async () => {
    const sourceDir = join(projectRoot, "plugin-catalog");
    await writePlugin(join(sourceDir, "plugins", "alpha"), "alpha");
    await writePlugin(join(sourceDir, "plugins", "beta"), "beta");
    const install = mockRunInstall();

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-catalog",
      names: ["alpha", "missing"],
    })).rejects.toThrow('Plugin "missing" not found');
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-catalog",
      names: ["alpha", "beta"],
      ref: "release/v1",
    });

    expect(result).toEqual(["alpha", "beta"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml.match(/\[\[plugins\]\]/g)).toHaveLength(2);
    expect(toml).toContain('path = "plugins/alpha"');
    expect(toml).toContain('path = "plugins/beta"');
    expect(toml.match(/ref = "release\/v1"/g)).toHaveLength(2);
    expect(install).toHaveBeenCalledOnce();
  });

  it("lists plugins in non-interactive mode and supports interactive selection", async () => {
    const sourceDir = join(projectRoot, "plugin-picker");
    await writePlugin(join(sourceDir, "plugins", "alpha"), "alpha");
    await writePlugin(join(sourceDir, "plugins", "beta"), "beta");

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-picker",
      interactive: false,
    })).rejects.toThrow(/Multiple plugins found.*alpha, beta.*--name/);

    prompts.select.mockResolvedValue("pick");
    prompts.multiselect.mockResolvedValue([1]);
    prompts.isCancel.mockReturnValue(false);
    mockRunInstall();
    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-picker",
      interactive: true,
    });

    expect(result).toBe("beta");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toContain(
      'path = "plugins/beta"',
    );
  });

  it("pins an interactively selected source-root plugin with a dot path", async () => {
    const sourceDir = join(projectRoot, "root-plugin-picker");
    await writePlugin(sourceDir, "shared");
    await writePlugin(join(sourceDir, ".agents", "plugins", "shared"), "shared");
    prompts.select.mockResolvedValue("pick");
    prompts.multiselect.mockResolvedValue([0]);
    prompts.isCancel.mockReturnValue(false);
    mockRunInstall();

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:root-plugin-picker",
      interactive: true,
    });

    expect(result).toBe("shared");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toContain(
      'path = "."',
    );
  });

  it("rejects a local plugin source that contains the managed install directory", async () => {
    await writePlugin(projectRoot, "project-root");

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:.",
    })).rejects.toThrow("source overlaps this project's managed plugin directory");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");
  });

  it("rejects a symlinked local source that resolves to the project root", async () => {
    await writePlugin(projectRoot, "project-root");
    await symlink(projectRoot, join(projectRoot, "source-link"), "dir");

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:source-link",
    })).rejects.toThrow("source overlaps this project's managed plugin directory");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");
  });

  it("rejects a local plugin source inside the managed install directory", async () => {
    await writePlugin(join(projectRoot, ".agents", "plugins", "local-tools"), "local-tools");

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:.agents/plugins/local-tools",
    })).rejects.toThrow("source overlaps this project's managed plugin directory");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");
  });

  it("rejects a source inside a symlinked managed plugin directory", async () => {
    const managedAgentsDir = join(projectRoot, "managed-agents");
    const pluginDir = join(managedAgentsDir, "plugins", "local-tools");
    await rm(join(projectRoot, ".agents"), { recursive: true });
    await writePlugin(pluginDir, "local-tools");
    await symlink(managedAgentsDir, join(projectRoot, ".agents"), "dir");

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:managed-agents/plugins/local-tools",
    })).rejects.toThrow("source overlaps this project's managed plugin directory");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe("version = 1\n");
  });

  it("adds a local plugin before the managed agents directory exists", async () => {
    const pluginDir = join(projectRoot, "plugin-source", "review-tools");
    await rm(join(projectRoot, ".agents"), { recursive: true });
    await writePlugin(pluginDir, "review-tools");
    mockRunInstall();

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-source/review-tools",
    })).resolves.toBe("review-tools");
    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toContain(
      'name = "review-tools"',
    );
  });

  it("keeps marketplace aliases distinct in the interactive plugin picker", async () => {
    const sourceDir = join(projectRoot, "aliased-plugin-picker");
    const pluginDir = join(sourceDir, "shared-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), "{}");
    await writeFile(join(sourceDir, "marketplace.json"), JSON.stringify({
      name: "aliases",
      plugins: [
        { name: "alpha", source: "./shared-plugin" },
        { name: "beta", source: "./shared-plugin" },
      ],
    }));
    prompts.select.mockResolvedValue("pick");
    prompts.multiselect.mockResolvedValue([0, 1]);
    prompts.isCancel.mockReturnValue(false);
    mockRunInstall();

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:aliased-plugin-picker",
      interactive: true,
    });

    expect(result).toEqual(["alpha", "beta"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml).toContain('name = "alpha"');
    expect(toml).toContain('name = "beta"');
    expect(toml.match(/path = "shared-plugin"/g)).toHaveLength(2);
  });

  it("adds every discovered plugin explicitly with --all", async () => {
    const sourceDir = join(projectRoot, "plugin-all");
    await writePlugin(join(sourceDir, "plugins", "alpha"), "alpha");
    await writePlugin(join(sourceDir, "plugins", "beta"), "beta");
    const install = mockRunInstall();

    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-all",
      all: true,
    });

    expect(result).toEqual(["alpha", "beta"]);
    const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
    expect(toml.match(/\[\[plugins\]\]/g)).toHaveLength(2);
    expect(toml).not.toContain('name = "*"');
    expect(install).toHaveBeenCalledOnce();
  });

  it("refreshes an exact plugin duplicate and still adds new requested plugins", async () => {
    const sourceDir = join(projectRoot, "plugin-duplicates");
    await writePlugin(join(sourceDir, "plugins", "alpha"), "alpha");
    await writePlugin(join(sourceDir, "plugins", "beta"), "beta");
    await writeFile(
      join(projectRoot, "agents.toml"),
      'version = 1\n\n[[plugins]]\nname = "alpha"\nsource = "path:plugin-duplicates"\npath = "plugins/alpha"\n',
    );

    const install = mockRunInstall();
    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-duplicates",
      names: ["alpha"],
    })).resolves.toBe("alpha");
    expect(install).toHaveBeenCalledOnce();

    install.mockClear();
    const result = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-duplicates",
      names: ["alpha", "beta"],
    });
    expect(result).toEqual(["beta"]);
    expect(install).toHaveBeenCalledOnce();
  });

  it("reports only conflicting plugins in a mixed duplicate request", async () => {
    const sourceDir = join(projectRoot, "plugin-conflicts");
    await writePlugin(join(sourceDir, "plugins", "alpha"), "alpha");
    await writePlugin(join(sourceDir, "plugins", "beta"), "beta");
    await writeFile(
      join(projectRoot, "agents.toml"),
      [
        "version = 1",
        "",
        "[[plugins]]",
        'name = "alpha"',
        'source = "path:plugin-conflicts"',
        'path = "plugins/alpha"',
        "",
        "[[plugins]]",
        'name = "beta"',
        'source = "path:plugin-conflicts"',
        'path = "different/path"',
        "",
      ].join("\n"),
    );

    const error = await runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-conflicts",
      names: ["alpha", "beta"],
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AddError);
    if (!(error instanceof Error)) {throw new Error("expected add to reject");}
    expect(error.message).toBe(
      "Plugins already exist in agents.toml with a different source, ref, or path: beta.",
    );
  });

  it("adds user-scope plugins and runs installation", async () => {
    const userRoot = join(tmpDir, "user-home");
    const sourceDir = join(userRoot, "plugin-source");
    await mkdir(userRoot, { recursive: true });
    await writeFile(join(userRoot, "agents.toml"), "version = 1\n");
    await writePlugin(sourceDir, "project-only");
    const scope = resolveScope("user");
    scope.root = userRoot;
    scope.configPath = join(userRoot, "agents.toml");
    scope.lockPath = join(userRoot, "agents.lock");
    scope.pluginsDir = join(userRoot, "plugins");

    const install = mockRunInstall();
    await expect(runAdd({
      scope,
      specifier: "path:plugin-source",
    })).resolves.toBe("project-only");

    expect(await readFile(scope.configPath, "utf-8")).toContain('name = "project-only"');
    expect(install).toHaveBeenCalledWith({ scope });
  });

  it("reinstalls an exact local plugin duplicate without changing config", async () => {
    const sourceDir = join(projectRoot, "plugin-refresh");
    await writePlugin(sourceDir, "refresh-tools");
    await writeFile(join(sourceDir, "README.md"), "version one\n");
    const scope = resolveScope("project", projectRoot);

    await runAdd({ scope, specifier: "path:plugin-refresh" });
    const configBefore = await readFile(scope.configPath, "utf-8");
    expect(
      await readFile(
        join(projectRoot, ".agents", "plugins", "refresh-tools", "README.md"),
        "utf-8",
      ),
    ).toBe("version one\n");

    await writeFile(join(sourceDir, "README.md"), "version two\n");
    await expect(
      runAdd({ scope, specifier: "path:plugin-refresh" }),
    ).resolves.toBe("refresh-tools");

    expect(await readFile(scope.configPath, "utf-8")).toBe(configBefore);
    expect(
      await readFile(
        join(projectRoot, ".agents", "plugins", "refresh-tools", "README.md"),
        "utf-8",
      ),
    ).toBe("version two\n");
  });

  it("restores agents.toml when plugin installation fails", async () => {
    const sourceDir = join(projectRoot, "plugin-source");
    await writePlugin(sourceDir, "review-tools");
    const originalConfig = "version = 1\n# Keep this comment.\n";
    await writeFile(join(projectRoot, "agents.toml"), originalConfig);
    vi.spyOn(installModule, "runInstall").mockRejectedValue(new Error("install failed"));

    await expect(runAdd({
      scope: resolveScope("project", projectRoot),
      specifier: "path:plugin-source",
    })).rejects.toThrow("install failed");

    expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toBe(originalConfig);
  });

  it("bootstraps a missing user config for a detected plugin", async () => {
    const userRoot = join(tmpDir, "fresh-user-home");
    await writePlugin(join(userRoot, "plugin-source"), "project-only");
    const scope = resolveScope("user");
    scope.root = userRoot;
    scope.configPath = join(userRoot, "agents.toml");
    scope.lockPath = join(userRoot, "agents.lock");
    scope.pluginsDir = join(userRoot, "plugins");

    const install = mockRunInstall();
    await expect(runAdd({
      scope,
      specifier: "path:plugin-source",
    })).resolves.toBe("project-only");

    expect(await readFile(scope.configPath, "utf-8")).toContain('name = "project-only"');
    expect(install).toHaveBeenCalledWith({ scope });
  });

});

describe("add() CLI parsing", () => {
  let tmpDir: string;
  let stateDir: string;
  let projectRoot: string;
  let repoDir: string;
  let repoInitialized: boolean;
  let originalExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-add-cli-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    repoDir = join(tmpDir, "repo");
    repoInitialized = false;

    process.env["DOTAGENTS_STATE_DIR"] = stateDir;
    originalExitCode = process.exitCode;

    // Set up project
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");

  });

  async function ensureGitRepo(): Promise<void> {
    if (repoInitialized) {
      return;
    }

    await mkdir(repoDir, { recursive: true });
    await exec("git", ["init"], { cwd: repoDir });
    await exec("git", ["config", "user.email", "test@test.com"], {
      cwd: repoDir,
    });
    await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await exec("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });

    await mkdir(join(repoDir, "pdf"), { recursive: true });
    await writeFile(join(repoDir, "pdf", "SKILL.md"), SKILL_MD("pdf"));

    await mkdir(join(repoDir, "skills", "review"), { recursive: true });
    await writeFile(
      join(repoDir, "skills", "review", "SKILL.md"),
      SKILL_MD("review"),
    );

    await exec("git", ["add", "."], { cwd: repoDir });
    await exec("git", ["commit", "-m", "initial"], { cwd: repoDir });
    repoInitialized = true;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["DOTAGENTS_STATE_DIR"];
    process.exitCode = originalExitCode;
    await rm(tmpDir, { recursive: true });
  });

  it("passes positional skill names to runAdd", async () => {
    await ensureGitRepo();
    // We test the full CLI add() against a resolved project scope.
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add([`git:${repoDir}`, "pdf", "review"], { scope: resolveScope("project", projectRoot) });
      expect(process.exitCode).toBeUndefined();

      const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
      expect(toml).toContain('name = "pdf"');
      expect(toml).toContain('name = "review"');
    } finally {
      process.chdir(origCwd);
    }
  });

  it("passes repeated --skill flags to runAdd", async () => {
    await ensureGitRepo();
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add([`git:${repoDir}`, "--skill", "pdf", "--skill", "review"], { scope: resolveScope("project", projectRoot) });
      expect(process.exitCode).toBeUndefined();

      const toml = await readFile(join(projectRoot, "agents.toml"), "utf-8");
      expect(toml).toContain('name = "pdf"');
      expect(toml).toContain('name = "review"');
    } finally {
      process.chdir(origCwd);
    }
  });

  it("errors when mixing positional names and --skill flags", async () => {
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add([`git:${repoDir}`, "pdf", "--skill", "review"], { scope: resolveScope("project", projectRoot) });
      expect(process.exitCode).toBe(1);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("treats --skill as a plugin-selection alias and prints plugin output", async () => {
    await writePlugin(join(projectRoot, "plugin-source"), "cli-plugin");
    mockRunInstall();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add(["path:plugin-source", "--skill", "cli-plugin"], { scope: resolveScope("project", projectRoot) });

      expect(process.exitCode).toBeUndefined();
      expect(await readFile(join(projectRoot, "agents.toml"), "utf-8")).toContain(
        "[[plugins]]",
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Added plugin: cli-plugin"));
    } finally {
      process.chdir(origCwd);
    }
  });

  it("reports an existing plugin as refreshed without setting an error", async () => {
    await writePlugin(join(projectRoot, "plugin-source"), "cli-plugin");
    await writeFile(
      join(projectRoot, "agents.toml"),
      'version = 1\n\n[[plugins]]\nname = "cli-plugin"\nsource = "path:plugin-source"\npath = "."\n',
    );
    const install = mockRunInstall();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await add(["path:plugin-source"], {
      scope: resolveScope("project", projectRoot),
    });

    expect(process.exitCode).toBeUndefined();
    expect(install).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "cli-plugin" is already configured. Refreshed installation.',
      ),
    );
  });

  it("shows phase progress only in an interactive terminal", async () => {
    await writePlugin(join(projectRoot, "plugin-source"), "cli-plugin");
    mockRunInstall();
    const spinner = {
      start: vi.fn(),
      message: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
      isCancelled: false,
    };
    prompts.spinner.mockReturnValue(spinner);
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const origCwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await add(["path:plugin-source", "--skill", "cli-plugin"], { scope: resolveScope("project", projectRoot) });

      expect(prompts.spinner).toHaveBeenCalledWith({ indicator: "timer" });
      expect(spinner.start.mock.calls).toEqual([
        ["Resolving path:plugin-source"],
        ["Installing components"],
      ]);
      expect(spinner.message).toHaveBeenCalledWith("Inspecting path:plugin-source");
      expect(spinner.stop.mock.calls).toEqual([
        ["Source ready"],
        ["Installation complete"],
      ]);
      expect(spinner.error).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Added plugin: cli-plugin"));
    } finally {
      process.chdir(origCwd);
      if (originalIsTTY) {
        Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  });
});
