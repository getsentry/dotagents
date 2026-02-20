import { describe, it, expect } from "vitest";
import { parseSource, normalizeSource, sourcesMatch } from "./resolver.js";

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

  it("parses owner/repo@ref as github with ref", () => {
    const result = parseSource("getsentry/sentry-skills@v1.0.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("sentry-skills");
    expect(result.ref).toBe("v1.0.0");
    expect(result.url).toBe(
      "https://github.com/getsentry/sentry-skills.git",
    );
  });

  it("parses owner/repo@sha as github with sha ref", () => {
    const result = parseSource("anthropics/skills@abc123");
    expect(result.type).toBe("github");
    expect(result.ref).toBe("abc123");
  });

  it("parses git: prefix as generic git", () => {
    const result = parseSource("git:https://git.corp.example.com/team/skills.git");
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

  it("normalizes HTTPS URL to owner/repo", () => {
    expect(normalizeSource("https://github.com/getsentry/skills")).toBe("getsentry/skills");
  });

  it("normalizes SSH URL to owner/repo", () => {
    expect(normalizeSource("git@github.com:getsentry/skills.git")).toBe("getsentry/skills");
  });

  it("normalizes HTTPS URL with .git suffix", () => {
    expect(normalizeSource("https://github.com/getsentry/skills.git")).toBe("getsentry/skills");
  });

  it("returns non-github sources unchanged", () => {
    expect(normalizeSource("path:../my-skill")).toBe("path:../my-skill");
    expect(normalizeSource("git:https://example.com/repo.git")).toBe("git:https://example.com/repo.git");
  });
});

describe("sourcesMatch", () => {
  it("matches identical shorthand", () => {
    expect(sourcesMatch("getsentry/skills", "getsentry/skills")).toBe(true);
  });

  it("matches SSH URL with shorthand", () => {
    expect(sourcesMatch("git@github.com:getsentry/skills.git", "getsentry/skills")).toBe(true);
  });

  it("matches HTTPS URL with shorthand", () => {
    expect(sourcesMatch("https://github.com/getsentry/skills", "getsentry/skills")).toBe(true);
  });

  it("matches SSH URL with HTTPS URL", () => {
    expect(sourcesMatch("git@github.com:getsentry/skills.git", "https://github.com/getsentry/skills")).toBe(true);
  });

  it("does not match different repos", () => {
    expect(sourcesMatch("getsentry/skills", "getsentry/other")).toBe(false);
  });

  it("does not match different owners", () => {
    expect(sourcesMatch("getsentry/skills", "anthropics/skills")).toBe(false);
  });
});
