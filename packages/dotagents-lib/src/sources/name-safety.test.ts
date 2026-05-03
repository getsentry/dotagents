import { describe, it, expect } from "vitest";
import { validateGitNameSafety, GitNameSafetyError } from "./name-safety.js";

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
    try {
      validateGitNameSafety({ owner: "-malicious" });
    } catch (err) {
      expect(err).toBeInstanceOf(GitNameSafetyError);
      expect((err as GitNameSafetyError).field).toBe("owner");
      expect((err as GitNameSafetyError).reason).toBe("leading-dash");
    }
  });

  it("rejects leading-dash repo", () => {
    try {
      validateGitNameSafety({ repo: "-evil" });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitNameSafetyError);
      expect((err as GitNameSafetyError).field).toBe("repo");
      expect((err as GitNameSafetyError).reason).toBe("leading-dash");
    }
  });

  it("rejects leading-dash ref", () => {
    try {
      validateGitNameSafety({ ref: "--upload-pack=evil" });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitNameSafetyError);
      expect((err as GitNameSafetyError).field).toBe("ref");
      expect((err as GitNameSafetyError).reason).toBe("leading-dash");
    }
  });

  it("rejects '..' as repo", () => {
    try {
      validateGitNameSafety({ owner: "safe", repo: ".." });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as GitNameSafetyError).reason).toBe("traversal");
    }
  });

  it("rejects '.' as repo", () => {
    try {
      validateGitNameSafety({ repo: "." });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as GitNameSafetyError).reason).toBe("traversal");
    }
  });

  it("rejects invalid characters", () => {
    try {
      validateGitNameSafety({ owner: "weird name" });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as GitNameSafetyError).reason).toBe("invalid-characters");
    }
  });

  it("accepts GitLab nested group with safe segments", () => {
    expect(() =>
      validateGitNameSafety({ owner: "group/subgroup", repo: "repo" }),
    ).not.toThrow();
  });

  it("rejects GitLab nested group when one segment is unsafe", () => {
    try {
      validateGitNameSafety({ owner: "group/-evil", repo: "repo" });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as GitNameSafetyError).field).toBe("owner");
      expect((err as GitNameSafetyError).reason).toBe("leading-dash");
    }
  });

  it("rejects GitLab nested group with traversal segment", () => {
    try {
      validateGitNameSafety({ owner: "group/../escape", repo: "repo" });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as GitNameSafetyError).field).toBe("owner");
      expect((err as GitNameSafetyError).reason).toBe("traversal");
    }
  });
});
