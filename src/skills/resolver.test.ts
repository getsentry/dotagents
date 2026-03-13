import { describe, it, expect } from "vitest";
import {
  applyDefaultRepositorySource,
  parseOwnerRepoShorthand,
  parseSource,
  normalizeSource,
  sourcesMatch,
} from "./resolver.js";

describe("parseOwnerRepoShorthand", () => {
  it("parses owner/repo", () => {
    expect(parseOwnerRepoShorthand("getsentry/skills")).toEqual({
      owner: "getsentry",
      repo: "skills",
    });
  });

  it("parses @owner/repo (strips leading @)", () => {
    expect(parseOwnerRepoShorthand("@getsentry/skills")).toEqual({
      owner: "getsentry",
      repo: "skills",
    });
  });

  it("parses @owner/repo@ref (strips leading @, preserves ref)", () => {
    expect(parseOwnerRepoShorthand("@getsentry/skills@v1.0.0")).toEqual({
      owner: "getsentry",
      repo: "skills",
      ref: "v1.0.0",
    });
  });

  it("returns undefined for explicit URLs", () => {
    expect(parseOwnerRepoShorthand("https://github.com/o/r")).toBeUndefined();
    expect(parseOwnerRepoShorthand("git@github.com:o/r")).toBeUndefined();
  });
});

describe("applyDefaultRepositorySource", () => {
  it("expands shorthand to GitHub by default", () => {
    expect(applyDefaultRepositorySource("getsentry/skills")).toBe(
      "https://github.com/getsentry/skills",
    );
  });

  it("expands shorthand to GitLab when configured", () => {
    expect(applyDefaultRepositorySource("getsentry/skills", "gitlab")).toBe(
      "https://gitlab.com/getsentry/skills",
    );
  });

  it("keeps explicit URL unchanged", () => {
    expect(
      applyDefaultRepositorySource(
        "https://gitlab.com/group/repo",
        "github",
      ),
    ).toBe("https://gitlab.com/group/repo");
  });
});

describe("parseSource", () => {
  it("parses owner/repo as github", () => {
    const result = parseSource("anthropics/skills");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("anthropics");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/anthropics/skills.git");
    expect(result.cloneUrl).toBeUndefined();
    expect(result.ref).toBeUndefined();
  });

  it("parses @owner/repo as github (strips leading @)", () => {
    const result = parseSource("@getsentry/skills");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.ref).toBeUndefined();
  });

  it("parses @owner/repo@ref as github with ref", () => {
    const result = parseSource("@getsentry/skills@v2.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.ref).toBe("v2.0");
  });

  it("parses owner/repo@ref as github with ref", () => {
    const result = parseSource("getsentry/sentry-skills@v1.0.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("sentry-skills");
    expect(result.ref).toBe("v1.0.0");
    expect(result.url).toBe("https://github.com/getsentry/sentry-skills.git");
  });

  it("parses owner/repo@sha as github with sha ref", () => {
    const result = parseSource("anthropics/skills@abc123");
    expect(result.type).toBe("github");
    expect(result.ref).toBe("abc123");
  });

  it("parses git: prefix as generic git", () => {
    const result = parseSource(
      "git:https://git.corp.example.com/team/skills.git",
    );
    expect(result.type).toBe("git");
    expect(result.url).toBe("https://git.corp.example.com/team/skills.git");
  });

  it("parses path: prefix as local", () => {
    const result = parseSource("path:../shared/my-skill");
    expect(result.type).toBe("local");
    expect(result.path).toBe("../shared/my-skill");
  });

  it("parses HTTPS GitHub URL", () => {
    const result = parseSource("https://github.com/getsentry/skills");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.cloneUrl).toBe("https://github.com/getsentry/skills");
    expect(result.ref).toBeUndefined();
  });

  it("parses HTTPS GitHub URL with .git suffix", () => {
    const result = parseSource("https://github.com/getsentry/skills.git");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
  });

  it("parses HTTPS GitHub URL with trailing slash", () => {
    const result = parseSource("https://github.com/getsentry/skills/");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
  });

  it("parses HTTPS GitHub URL with @ref", () => {
    const result = parseSource("https://github.com/getsentry/skills@v1.0.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.ref).toBe("v1.0.0");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.cloneUrl).toBe("https://github.com/getsentry/skills");
  });

  it("parses SSH GitHub URL", () => {
    const result = parseSource("git@github.com:getsentry/skills");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.cloneUrl).toBe("git@github.com:getsentry/skills");
    expect(result.ref).toBeUndefined();
  });

  it("parses SSH GitHub URL with .git suffix", () => {
    const result = parseSource("git@github.com:getsentry/skills.git");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.cloneUrl).toBe("git@github.com:getsentry/skills.git");
  });

  it("parses SSH GitHub URL with @ref", () => {
    const result = parseSource("git@github.com:getsentry/skills@v2.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.ref).toBe("v2.0");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.cloneUrl).toBe("git@github.com:getsentry/skills");
  });

  it("parses HTTPS GitHub URL with dotted repo name", () => {
    const result = parseSource("https://github.com/vercel/next.js");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("vercel");
    expect(result.repo).toBe("next.js");
    expect(result.url).toBe("https://github.com/vercel/next.js.git");
  });

  it("parses HTTPS GitHub URL with dotted repo name and .git suffix", () => {
    const result = parseSource("https://github.com/vercel/next.js.git");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("vercel");
    expect(result.repo).toBe("next.js");
    expect(result.url).toBe("https://github.com/vercel/next.js.git");
  });

  it("parses HTTPS GitLab URL", () => {
    const result = parseSource("https://gitlab.com/group/repo");
    expect(result.type).toBe("git");
    expect(result.owner).toBe("group");
    expect(result.repo).toBe("repo");
    expect(result.url).toBe("https://gitlab.com/group/repo.git");
    expect(result.cloneUrl).toBe("https://gitlab.com/group/repo");
  });

  it("parses HTTPS GitLab URL with subgroup", () => {
    const result = parseSource("https://gitlab.com/group/subgroup/repo");
    expect(result.type).toBe("git");
    expect(result.owner).toBe("group/subgroup");
    expect(result.repo).toBe("repo");
    expect(result.url).toBe("https://gitlab.com/group/subgroup/repo.git");
  });

  it("parses SSH GitLab URL with ref", () => {
    const result = parseSource("git@gitlab.com:group/repo@v2.0");
    expect(result.type).toBe("git");
    expect(result.owner).toBe("group");
    expect(result.repo).toBe("repo");
    expect(result.ref).toBe("v2.0");
    expect(result.url).toBe("https://gitlab.com/group/repo.git");
    expect(result.cloneUrl).toBe("git@gitlab.com:group/repo");
  });

  it("upgrades http:// to https:// in cloneUrl", () => {
    const result = parseSource("http://github.com/getsentry/skills");
    expect(result.type).toBe("github");
    expect(result.cloneUrl).toBe("https://github.com/getsentry/skills");
  });

  it("does not set cloneUrl for owner/repo shorthand", () => {
    const result = parseSource("getsentry/skills@v1.0");
    expect(result.cloneUrl).toBeUndefined();
  });

  it("strips ref containing @ from cloneUrl correctly", () => {
    const result = parseSource("git@github.com:org/repo@packages/foo@1.0.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("org");
    expect(result.repo).toBe("repo");
    expect(result.ref).toBe("packages/foo@1.0.0");
    expect(result.cloneUrl).toBe("git@github.com:org/repo");
  });
});

describe("normalizeSource", () => {
  it("normalizes owner/repo shorthand to itself", () => {
    expect(normalizeSource("getsentry/skills")).toBe("getsentry/skills");
  });

  it("normalizes GitHub HTTPS URL to owner/repo", () => {
    expect(normalizeSource("https://github.com/getsentry/skills")).toBe(
      "getsentry/skills",
    );
  });

  it("normalizes GitHub SSH URL to owner/repo", () => {
    expect(normalizeSource("git@github.com:getsentry/skills.git")).toBe(
      "getsentry/skills",
    );
  });

  it("normalizes GitHub HTTPS URL with .git suffix", () => {
    expect(normalizeSource("https://github.com/getsentry/skills.git")).toBe(
      "getsentry/skills",
    );
  });

  it("normalizes GitLab HTTPS URL to group/repo", () => {
    expect(normalizeSource("https://gitlab.com/group/repo")).toBe(
      "group/repo",
    );
  });

  it("normalizes GitLab SSH URL to group/repo", () => {
    expect(normalizeSource("git@gitlab.com:group/repo.git")).toBe(
      "group/repo",
    );
  });

  it("returns non-github sources unchanged", () => {
    expect(normalizeSource("path:../my-skill")).toBe("path:../my-skill");
    expect(normalizeSource("git:https://example.com/repo.git")).toBe(
      "git:https://example.com/repo.git",
    );
  });
});

describe("sourcesMatch", () => {
  it("matches identical shorthand", () => {
    expect(sourcesMatch("getsentry/skills", "getsentry/skills")).toBe(true);
  });

  it("matches SSH URL with shorthand", () => {
    expect(
      sourcesMatch("git@github.com:getsentry/skills.git", "getsentry/skills"),
    ).toBe(true);
  });

  it("matches HTTPS URL with shorthand", () => {
    expect(
      sourcesMatch("https://github.com/getsentry/skills", "getsentry/skills"),
    ).toBe(true);
  });

  it("matches GitLab URL with shorthand", () => {
    expect(
      sourcesMatch("https://gitlab.com/getsentry/skills", "getsentry/skills"),
    ).toBe(true);
  });

  it("matches SSH URL with HTTPS URL", () => {
    expect(
      sourcesMatch(
        "git@github.com:getsentry/skills.git",
        "https://github.com/getsentry/skills",
      ),
    ).toBe(true);
  });

  it("matches GitLab SSH URL with GitLab HTTPS URL", () => {
    expect(
      sourcesMatch(
        "git@gitlab.com:group/repo.git",
        "https://gitlab.com/group/repo",
      ),
    ).toBe(true);
  });

  it("does not match different repos", () => {
    expect(sourcesMatch("getsentry/skills", "getsentry/other")).toBe(false);
  });

  it("does not match different owners", () => {
    expect(sourcesMatch("getsentry/skills", "anthropics/skills")).toBe(false);
  });
});
