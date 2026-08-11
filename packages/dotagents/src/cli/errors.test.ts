import { describe, it, expect } from "vitest";
import { GitError, TrustError, type TrustPolicy } from "@sentry/dotagents-lib";
import { resolveScope } from "../scope.js";
import { formatGitError, formatTrustError } from "./errors.js";

const globalScope = resolveScope("user");

const policy: TrustPolicy = {
  allow_all: false,
  github_orgs: ["getsentry"],
  github_repos: [],
  git_domains: [],
};

describe("formatTrustError", () => {
  it("renders the dotagents trust add hint for GitHub sources", () => {
    const err = new TrustError("Source \"evil/repo\" is not trusted.", {
      source: "evil/repo",
      kind: "github",
      owner: "evil",
      repo: "repo",
      allowed: policy,
    });

    const out = formatTrustError(err, globalScope);
    expect(out).toContain("npx @sentry/dotagents trust add evil");
    expect(out).toContain("npx @sentry/dotagents trust add evil/repo");
  });

  it("renders the dotagents trust add hint for git/well-known sources", () => {
    const err = new TrustError("Source \"https://git.evil.com/x\" is not trusted.", {
      source: "https://git.evil.com/x",
      kind: "well-known",
      domain: "git.evil.com",
      allowed: policy,
    });

    const out = formatTrustError(err, globalScope);
    expect(out).toContain("npx @sentry/dotagents trust add git.evil.com");
  });

  it("returns the bare message when no recovery hint applies", () => {
    const err = new TrustError("Some unusual case.", {
      source: "x",
      kind: "git",
      allowed: policy,
    });
    expect(formatTrustError(err, globalScope)).toBe("Some unusual case.");
  });
});

describe("formatGitError", () => {
  it("renders the SSH-URL hint for auth-required failures", () => {
    const err = new GitError("Failed to clone https://github.com/private/repo.git: authentication required.", {
      kind: "auth-required",
      url: "https://github.com/private/repo.git",
      sshUrl: "git@github.com:private/repo.git",
    });

    const out = formatGitError(err, globalScope);
    expect(out).toContain("npx @sentry/dotagents add git@github.com:private/repo.git");
  });

  it("returns the bare message for non-auth failures", () => {
    const err = new GitError("Failed to clone: some other error", {
      kind: "other",
      url: "https://github.com/x/y.git",
    });
    expect(formatGitError(err, globalScope)).toBe("Failed to clone: some other error");
  });

  it("returns the bare message when details are absent", () => {
    const err = new GitError("Plain message");
    expect(formatGitError(err, globalScope)).toBe("Plain message");
  });
});
