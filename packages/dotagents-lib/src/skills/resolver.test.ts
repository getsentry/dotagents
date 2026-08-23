import { describe, it, expect } from "vitest";
import {
  applyDefaultRepositorySource,
  parseOwnerRepoShorthand,
  parseSource,
  normalizeSource,
  sourcesMatch,
  isSourceExcluded,
  ParseSourceError,
} from "./resolver.js";

function captureParseSourceError(source: string): ParseSourceError {
  try {
    parseSource(source);
  } catch (err) {
    if (err instanceof ParseSourceError) {return err;}
    throw err;
  }
  throw new Error("expected parseSource to throw");
}

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

  it("expands multi-slash GitLab path when configured for gitlab", () => {
    expect(applyDefaultRepositorySource("group/subgroup/repo", "gitlab")).toBe(
      "https://gitlab.com/group/subgroup/repo",
    );
  });

  it("expands multi-slash GitLab path with @ref", () => {
    expect(
      applyDefaultRepositorySource("group/subgroup/repo@v1.0", "gitlab"),
    ).toBe("https://gitlab.com/group/subgroup/repo@v1.0");
  });

  it("expands deeply nested GitLab path", () => {
    expect(
      applyDefaultRepositorySource("a/b/c/d/repo", "gitlab"),
    ).toBe("https://gitlab.com/a/b/c/d/repo");
  });

  it("does not expand multi-slash path for github", () => {
    // Multi-slash is not valid for GitHub, returns unchanged
    expect(applyDefaultRepositorySource("a/b/c", "github")).toBe("a/b/c");
  });

  it("rejects multi-slash path with leading dash segment", () => {
    expect(applyDefaultRepositorySource("-bad/group/repo", "gitlab")).toBe(
      "-bad/group/repo",
    );
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

  it("parses bare HTTPS URL as well-known", () => {
    const result = parseSource("https://cli.sentry.dev");
    expect(result.type).toBe("well-known");
    expect(result.url).toBe("https://cli.sentry.dev");
  });

  it("parses bare HTTPS URL with path as well-known", () => {
    const result = parseSource("https://example.com/skills");
    expect(result.type).toBe("well-known");
    expect(result.url).toBe("https://example.com/skills");
  });

  it("strips trailing slash from well-known URL", () => {
    const result = parseSource("https://cli.sentry.dev/");
    expect(result.type).toBe("well-known");
    expect(result.url).toBe("https://cli.sentry.dev");
  });

  it("does not parse http:// URL as well-known (HTTPS required)", () => {
    // http:// falls through to the shorthand branch, where the URL's path
    // structure trips the multi-segment-shorthand strictness check. Either
    // way, http:// is rejected.
    expect(() => parseSource("http://localhost:3000")).toThrow(ParseSourceError);
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

  it("normalizes well-known URL (strips trailing slash, lowercases hostname)", () => {
    expect(normalizeSource("https://CLI.Sentry.Dev/")).toBe(
      "https://cli.sentry.dev",
    );
  });

  it("normalizes well-known URL with path", () => {
    expect(normalizeSource("https://Example.Com/Skills/")).toBe(
      "https://example.com/Skills",
    );
  });

  it("preserves port in well-known URL normalization", () => {
    expect(normalizeSource("https://localhost:3000/")).toBe(
      "https://localhost:3000",
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

  it("matches well-known URLs with different casing", () => {
    expect(
      sourcesMatch("https://CLI.Sentry.Dev", "https://cli.sentry.dev"),
    ).toBe(true);
  });

  it("matches well-known URL with and without trailing slash", () => {
    expect(
      sourcesMatch("https://cli.sentry.dev/", "https://cli.sentry.dev"),
    ).toBe(true);
  });

  it("does not match different well-known domains", () => {
    expect(
      sourcesMatch("https://cli.sentry.dev", "https://other.example.com"),
    ).toBe(false);
  });

  it("does not match well-known URLs with different ports", () => {
    expect(
      sourcesMatch("https://localhost:3000", "https://localhost:4000"),
    ).toBe(false);
  });
});

describe("isSourceExcluded", () => {
  it("returns false with no exclude list", () => {
    expect(isSourceExcluded("getsentry/skills")).toBe(false);
    expect(isSourceExcluded("getsentry/skills", [])).toBe(false);
  });

  it("matches bare org name", () => {
    expect(isSourceExcluded("getsentry/skills", ["getsentry"])).toBe(true);
    expect(isSourceExcluded("getsentry/other", ["getsentry"])).toBe(true);
  });

  it("does not match different org", () => {
    expect(isSourceExcluded("anthropics/skills", ["getsentry"])).toBe(false);
  });

  it("matches exact org/repo", () => {
    expect(isSourceExcluded("getsentry/skills", ["getsentry/skills"])).toBe(true);
  });

  it("does not match different repo in same org", () => {
    expect(isSourceExcluded("getsentry/other", ["getsentry/skills"])).toBe(false);
  });

  it("matches wildcard org/*", () => {
    expect(isSourceExcluded("getsentry/skills", ["getsentry/*"])).toBe(true);
    expect(isSourceExcluded("getsentry/other", ["getsentry/*"])).toBe(true);
  });

  it("strips git: prefix for matching", () => {
    expect(isSourceExcluded("git:getsentry/skills", ["getsentry"])).toBe(true);
    expect(isSourceExcluded("git:getsentry/skills", ["getsentry/skills"])).toBe(true);
  });
});

describe("parseSource strict shorthand", () => {
  it("throws ParseSourceError on empty SHA after @", () => {
    expect(() => parseSource("owner/repo@")).toThrow(ParseSourceError);
    const err = captureParseSourceError("owner/repo@");
    expect(err.kind).toBe("empty-sha");
  });

  it("throws ParseSourceError on empty SHA in scoped shorthand", () => {
    expect(captureParseSourceError("@owner/repo@").kind).toBe("empty-sha");
  });

  it("throws ParseSourceError on multi-segment shorthand", () => {
    expect(captureParseSourceError("owner/repo/nested").kind).toBe(
      "multi-segment-shorthand",
    );
  });

  it("still parses valid github shorthand without throwing", () => {
    expect(() => parseSource("owner/repo")).not.toThrow();
    expect(() => parseSource("owner/repo@abc123")).not.toThrow();
    expect(() => parseSource("@owner/repo")).not.toThrow();
  });

  it("still parses GitHub URLs without throwing (URL form unaffected)", () => {
    expect(() => parseSource("https://github.com/owner/repo@abc")).not.toThrow();
    expect(() => parseSource("git@github.com:owner/repo.git@abc")).not.toThrow();
  });

  it("GitLab nested groups via applyDefaultRepositorySource go through URL form, not shorthand", () => {
    const expanded = applyDefaultRepositorySource("group/sub/repo", "gitlab");
    expect(() => parseSource(expanded)).not.toThrow();
    const parsed = parseSource(expanded);
    expect(parsed.type).toBe("git");
    expect(parsed.owner).toBe("group/sub");
    expect(parsed.repo).toBe("repo");
  });
});

describe("normalizeSource gracefully handles malformed inputs", () => {
  // normalizeSource is called from dedup / comparison paths that should not
  // crash on stale or hand-edited config. parseSource throwing on malformed
  // shorthand must not propagate up to those callers.
  it("returns input as-is when parseSource throws empty-sha", () => {
    expect(normalizeSource("owner/repo@")).toBe("owner/repo@");
  });

  it("returns input as-is when parseSource throws multi-segment-shorthand", () => {
    expect(normalizeSource("owner/repo/nested")).toBe("owner/repo/nested");
  });

  it("still normalizes valid inputs", () => {
    expect(normalizeSource("https://github.com/owner/repo")).toBe("owner/repo");
  });
});

describe("sourcesMatch gracefully handles malformed inputs", () => {
  it("returns false (not throws) when one side is malformed", () => {
    expect(sourcesMatch("owner/repo", "owner/repo@")).toBe(false);
  });

  it("matches two equally-malformed inputs as opaque strings", () => {
    expect(sourcesMatch("owner/repo@", "owner/repo@")).toBe(true);
  });
});

describe("parseOwnerRepoShorthand strict (mirrors parseSource)", () => {
  it("returns undefined for empty SHA after @", () => {
    expect(parseOwnerRepoShorthand("owner/repo@")).toBeUndefined();
  });

  it("returns undefined for multi-segment shorthand", () => {
    expect(parseOwnerRepoShorthand("owner/repo/nested")).toBeUndefined();
  });

  it("still parses valid shorthand", () => {
    expect(parseOwnerRepoShorthand("owner/repo@abc")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "abc",
    });
  });
});
