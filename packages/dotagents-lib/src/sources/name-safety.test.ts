import { describe, it, expect } from "vitest";
import { validateGitNameSafety, GitNameSafetyError } from "./name-safety.js";

function captureGitNameSafetyError(run: () => void): GitNameSafetyError {
  try {
    run();
  } catch (err) {
    if (err instanceof GitNameSafetyError) {return err;}
    throw err;
  }
  throw new Error("expected validateGitNameSafety to throw");
}

describe("validateGitNameSafety", () => {
  it("accepts safe owner/repo/ref", () => {
    expect(() =>
      validateGitNameSafety({ owner: "getsentry", repo: "warden", ref: "abc123" }),
    ).not.toThrow();
  });

  it("accepts owner with dots, hyphens, underscores", () => {
    expect(() =>
      validateGitNameSafety({ owner: "my.org_x-y", repo: "repo" }),
    ).not.toThrow();
  });

  it("accepts a refs/heads/branch ref via dots and slashes are not allowed — only flat refs", () => {
    // refs containing slashes are rejected because we validate as a single segment.
    // Callers that pass branch refs should pass the leaf only.
    expect(() => validateGitNameSafety({ ref: "main" })).not.toThrow();
    expect(() => validateGitNameSafety({ ref: "v1.2.3" })).not.toThrow();
  });

  it("accepts no fields (all optional)", () => {
    expect(() => validateGitNameSafety({})).not.toThrow();
  });

  it("rejects leading-dash owner", () => {
    expect(() => validateGitNameSafety({ owner: "-malicious" })).toThrow(
      GitNameSafetyError,
    );
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ owner: "-malicious" }),
    );
    expect(err.field).toBe("owner");
    expect(err.reason).toBe("leading-dash");
  });

  it("rejects leading-dash repo", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ repo: "-evil" }),
    );
    expect(err.field).toBe("repo");
    expect(err.reason).toBe("leading-dash");
  });

  it("rejects leading-dash ref", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ ref: "--upload-pack=evil" }),
    );
    expect(err.field).toBe("ref");
    expect(err.reason).toBe("leading-dash");
  });

  it("rejects '..' as repo", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ owner: "safe", repo: ".." }),
    );
    expect(err.reason).toBe("traversal");
  });

  it("rejects '.' as repo", () => {
    const err = captureGitNameSafetyError(() => validateGitNameSafety({ repo: "." }));
    expect(err.reason).toBe("traversal");
  });

  it("rejects embedded '..' in a segment", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ repo: "foo..bar" }),
    );
    expect(err.reason).toBe("traversal");
  });

  it("rejects embedded '..' in owner segment", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ owner: "..foo" }),
    );
    expect(err.reason).toBe("traversal");
  });

  it("rejects invalid characters", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ owner: "weird name" }),
    );
    expect(err.reason).toBe("invalid-characters");
  });

  it("accepts GitLab nested group with safe segments", () => {
    expect(() =>
      validateGitNameSafety({ owner: "group/subgroup", repo: "repo" }),
    ).not.toThrow();
  });

  it("rejects GitLab nested group when one segment is unsafe", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ owner: "group/-evil", repo: "repo" }),
    );
    expect(err.field).toBe("owner");
    expect(err.reason).toBe("leading-dash");
  });

  it("rejects GitLab nested group with traversal segment", () => {
    const err = captureGitNameSafetyError(() =>
      validateGitNameSafety({ owner: "group/../escape", repo: "repo" }),
    );
    expect(err.field).toBe("owner");
    expect(err.reason).toBe("traversal");
  });
});
