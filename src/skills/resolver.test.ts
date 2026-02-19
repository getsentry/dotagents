import { describe, it, expect } from "vitest";
import { parseSource } from "./resolver.js";

describe("parseSource", () => {
  it("parses owner/repo as github", () => {
    const result = parseSource("anthropics/skills");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("anthropics");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/anthropics/skills.git");
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
  });

  it("parses SSH GitHub URL", () => {
    const result = parseSource("git@github.com:getsentry/skills");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
    expect(result.ref).toBeUndefined();
  });

  it("parses SSH GitHub URL with .git suffix", () => {
    const result = parseSource("git@github.com:getsentry/skills.git");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
  });

  it("parses SSH GitHub URL with @ref", () => {
    const result = parseSource("git@github.com:getsentry/skills@v2.0");
    expect(result.type).toBe("github");
    expect(result.owner).toBe("getsentry");
    expect(result.repo).toBe("skills");
    expect(result.ref).toBe("v2.0");
    expect(result.url).toBe("https://github.com/getsentry/skills.git");
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
});
