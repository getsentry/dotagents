import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDoctor } from "./doctor.js";
import { resolveScope } from "../../scope.js";

describe("runDoctor", () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dotagents-doctor-"));
    projectRoot = join(tmpDir, "project");
    await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it("reports error when agents.toml is missing", async () => {
    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const tomlCheck = result.checks.find((c) => c.name === "agents.toml");
    expect(tomlCheck?.status).toBe("error");
  });

  it("all checks pass for a clean project", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    expect(result.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("detects legacy pin field in agents.toml", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\npin = true\n");
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "legacy pin field");
    expect(check?.status).toBe("warn");
  });

  it("detects legacy gitignore field in agents.toml", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\ngitignore = true\n");
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "legacy gitignore field");
    expect(check?.status).toBe("warn");
  });

  it("detects legacy commit/integrity in agents.lock", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    // Write a lockfile with legacy fields (raw TOML, not via writeLockfile which drops them)
    await writeFile(
      join(projectRoot, "agents.lock"),
      `version = 1\n\n[skills.pdf]\nsource = "org/repo"\nresolved_url = "https://github.com/org/repo.git"\nresolved_path = "pdf"\ncommit = "abc123"\nintegrity = "sha256-xxx"\n`,
    );
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "legacy lockfile fields");
    expect(check?.status).toBe("warn");
  });

  it("detects missing root .gitignore entries", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "root .gitignore");
    expect(check?.status).toBe("error");
  });

  it("detects missing .agents/.gitignore", async () => {
    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === ".agents/.gitignore");
    expect(check?.status).toBe("warn");
  });

  it("detects missing skills", async () => {
    await writeFile(
      join(projectRoot, "agents.toml"),
      `version = 1\n\n[[skills]]\nname = "pdf"\nsource = "org/repo"\n`,
    );
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "installed skills");
    expect(check?.status).toBe("error");
    expect(check?.message).toContain("pdf");
  });

  it("detects generated files tracked by git", async () => {
    // Initialize a git repo so git ls-files works
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: projectRoot, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: projectRoot, stdio: "ignore" });
    execSync("git config user.name test", { cwd: projectRoot, stdio: "ignore" });

    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeFile(join(projectRoot, "agents.lock"), "version = 1\n");
    await writeFile(join(projectRoot, ".gitignore"), "");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    // Stage and commit the generated files
    execSync("git add agents.lock .agents/.gitignore", { cwd: projectRoot, stdio: "ignore" });
    execSync("git commit -m 'init'", { cwd: projectRoot, stdio: "ignore" });

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "tracked generated files");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("agents.lock");
    expect(check?.message).toContain(".agents/.gitignore");
  });

  it("does not warn when generated files are not tracked", async () => {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: projectRoot, stdio: "ignore" });

    await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
    await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
    await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

    const result = await runDoctor({ scope: resolveScope("project", projectRoot) });
    const check = result.checks.find((c) => c.name === "tracked generated files");
    expect(check).toBeUndefined();
  });

  describe("--fix", () => {
    it("fixes missing root .gitignore entries", async () => {
      await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
      await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

      const result = await runDoctor({ scope: resolveScope("project", projectRoot), fix: true });
      expect(result.fixed).toBeGreaterThan(0);

      const gitignore = await readFile(join(projectRoot, ".gitignore"), "utf-8");
      expect(gitignore).toContain("agents.lock");
      expect(gitignore).toContain(".agents/.gitignore");
    });

    it("fixes legacy pin field without removing unrelated lines", async () => {
      await writeFile(join(projectRoot, "agents.toml"), "version = 1\npin = true\n# pinning notes\n");
      await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
      await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

      await runDoctor({ scope: resolveScope("project", projectRoot), fix: true });

      const content = await readFile(join(projectRoot, "agents.toml"), "utf-8");
      expect(content).not.toMatch(/^\s*pin\s*=/m);
      expect(content).toContain("# pinning notes");
    });

    it("fixes legacy gitignore field", async () => {
      await writeFile(join(projectRoot, "agents.toml"), "version = 1\ngitignore = true\n");
      await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
      await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

      await runDoctor({ scope: resolveScope("project", projectRoot), fix: true });

      const content = await readFile(join(projectRoot, "agents.toml"), "utf-8");
      expect(content).not.toContain("gitignore");
    });

    it("fixes legacy lockfile fields", async () => {
      await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
      await writeFile(
        join(projectRoot, "agents.lock"),
        `version = 1\n\n[skills.pdf]\nsource = "org/repo"\nresolved_url = "https://github.com/org/repo.git"\nresolved_path = "pdf"\ncommit = "abc123"\nintegrity = "sha256-xxx"\n`,
      );
      await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
      await writeFile(join(projectRoot, ".agents", ".gitignore"), "# managed\n");

      await runDoctor({ scope: resolveScope("project", projectRoot), fix: true });

      const lockContent = await readFile(join(projectRoot, "agents.lock"), "utf-8");
      expect(lockContent).not.toContain("commit");
      expect(lockContent).not.toContain("integrity");
      // Should still have the valid fields
      expect(lockContent).toContain("org/repo");
    });

    it("creates missing .agents/.gitignore", async () => {
      await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
      await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");

      await runDoctor({ scope: resolveScope("project", projectRoot), fix: true });

      expect(existsSync(join(projectRoot, ".agents", ".gitignore"))).toBe(true);
    });

    it("includes lockfile subagents when recreating .agents/.gitignore", async () => {
      await writeFile(join(projectRoot, "agents.toml"), "version = 1\n");
      await writeFile(join(projectRoot, ".gitignore"), "agents.lock\n.agents/.gitignore\n");
      await writeFile(
        join(projectRoot, "agents.lock"),
        `version = 1\n\n[skills]\n\n[subagents.old-reviewer]\nsource = "path:agents"\n`,
      );

      await runDoctor({ scope: resolveScope("project", projectRoot), fix: true });

      const gitignore = await readFile(join(projectRoot, ".agents", ".gitignore"), "utf-8");
      expect(gitignore).toContain("/agents/old-reviewer.md");
    });
  });
});
