import { describe, it, expect } from "vitest";
import {
  validateTrustedSource,
  extractDomain,
  extractDomainPath,
  TrustError,
} from "./validator.js";
import type { TrustConfig } from "../config/schema.js";

function makeTrust(overrides: Partial<TrustConfig> = {}): TrustConfig {
  return {
    allow_all: false,
    github_orgs: [],
    github_repos: [],
    git_domains: [],
    ...overrides,
  };
}

describe("validateTrustedSource", () => {
  it("allows everything when trust config is undefined", () => {
    expect(() => validateTrustedSource("evil/repo")).not.toThrow();
    expect(() =>
      validateTrustedSource("git:https://evil.com/repo.git"),
    ).not.toThrow();
    expect(() =>
      validateTrustedSource("path:../local"),
    ).not.toThrow();
  });

  it("allows everything when allow_all is true", () => {
    const trust = makeTrust({ allow_all: true });
    expect(() => validateTrustedSource("evil/repo", trust)).not.toThrow();
    expect(() =>
      validateTrustedSource("git:https://evil.com/repo.git", trust),
    ).not.toThrow();
  });

  it("allows everything when allow_all is true even with other rules", () => {
    const trust = makeTrust({ allow_all: true, github_orgs: ["getsentry"] });
    expect(() => validateTrustedSource("evil/repo", trust)).not.toThrow();
  });

  describe("github_orgs", () => {
    const trust = makeTrust({ github_orgs: ["getsentry", "anthropics"] });

    it("allows matching orgs", () => {
      expect(() =>
        validateTrustedSource("getsentry/skills", trust),
      ).not.toThrow();
      expect(() =>
        validateTrustedSource("anthropics/tools", trust),
      ).not.toThrow();
    });

    it("rejects non-matching orgs", () => {
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        TrustError,
      );
    });

    it("strips @ref before checking", () => {
      expect(() =>
        validateTrustedSource("getsentry/skills@v1.0.0", trust),
      ).not.toThrow();
      expect(() => validateTrustedSource("evil/repo@main", trust)).toThrow(
        TrustError,
      );
    });
  });

  describe("github_repos", () => {
    const trust = makeTrust({ github_repos: ["external-org/one-approved"] });

    it("allows exact repo matches", () => {
      expect(() =>
        validateTrustedSource("external-org/one-approved", trust),
      ).not.toThrow();
    });

    it("rejects same-org different-repo", () => {
      expect(() =>
        validateTrustedSource("external-org/other-repo", trust),
      ).toThrow(TrustError);
    });

    it("rejects different-org same-repo", () => {
      expect(() =>
        validateTrustedSource("other-org/one-approved", trust),
      ).toThrow(TrustError);
    });

    it("strips @ref before checking", () => {
      expect(() =>
        validateTrustedSource("external-org/one-approved@v2", trust),
      ).not.toThrow();
    });
  });

  describe("git_domains", () => {
    const trust = makeTrust({ git_domains: ["git.corp.example.com"] });

    it("allows matching domains (https)", () => {
      expect(() =>
        validateTrustedSource(
          "git:https://git.corp.example.com/team/repo.git",
          trust,
        ),
      ).not.toThrow();
    });

    it("allows matching domains (ssh)", () => {
      expect(() =>
        validateTrustedSource(
          "git:ssh://git.corp.example.com/team/repo.git",
          trust,
        ),
      ).not.toThrow();
    });

    it("allows matching domains (scp-style)", () => {
      expect(() =>
        validateTrustedSource(
          "git:git@git.corp.example.com:team/repo.git",
          trust,
        ),
      ).not.toThrow();
    });

    it("rejects non-matching domains", () => {
      expect(() =>
        validateTrustedSource("git:https://evil.com/repo.git", trust),
      ).toThrow(TrustError);
    });

    it("allows direct GitLab URLs when domain is trusted", () => {
      const gitlabTrust = makeTrust({ git_domains: ["gitlab.com"] });
      expect(() =>
        validateTrustedSource("https://gitlab.com/group/repo", gitlabTrust),
      ).not.toThrow();
    });
  });

  describe("git_domains with path prefixes", () => {
    it("allows repos under a trusted domain path (https)", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg"] });
      expect(() =>
        validateTrustedSource("https://gitlab.com/myorg/repo", trust),
      ).not.toThrow();
    });

    it("allows repos under a trusted domain path (scp-style)", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg"] });
      expect(() =>
        validateTrustedSource("git:git@gitlab.com:myorg/repo.git", trust),
      ).not.toThrow();
    });

    it("allows nested subgroups under a trusted domain path", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg"] });
      expect(() =>
        validateTrustedSource(
          "git:https://gitlab.com/myorg/subgroup/repo.git",
          trust,
        ),
      ).not.toThrow();
    });

    it("rejects repos outside the trusted path", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg"] });
      expect(() =>
        validateTrustedSource("https://gitlab.com/evil/repo", trust),
      ).toThrow(TrustError);
    });

    it("rejects repos with a prefix-collision on path boundary", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg"] });
      // myorg-evil should NOT match myorg
      expect(() =>
        validateTrustedSource("https://gitlab.com/myorg-evil/repo", trust),
      ).toThrow(TrustError);
    });

    it("allows exact domain/path match for a specific repo", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg/specific-repo"] });
      expect(() =>
        validateTrustedSource("https://gitlab.com/myorg/specific-repo", trust),
      ).not.toThrow();
    });

    it("rejects sibling repos when only one repo is trusted", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com/myorg/specific-repo"] });
      expect(() =>
        validateTrustedSource("https://gitlab.com/myorg/other-repo", trust),
      ).toThrow(TrustError);
    });

    it("domain-only entries still work (backwards compat)", () => {
      const trust = makeTrust({ git_domains: ["gitlab.com"] });
      expect(() =>
        validateTrustedSource("https://gitlab.com/any/repo", trust),
      ).not.toThrow();
      expect(() =>
        validateTrustedSource("git:git@gitlab.com:deep/nested/repo.git", trust),
      ).not.toThrow();
    });
  });

  describe("local sources", () => {
    it("always allows path: sources even with restrictive trust", () => {
      const trust = makeTrust({ github_orgs: ["getsentry"] });
      expect(() =>
        validateTrustedSource("path:../local-skill", trust),
      ).not.toThrow();
    });
  });

  describe("combined rules", () => {
    const trust = makeTrust({
      github_orgs: ["getsentry"],
      github_repos: ["external/approved"],
      git_domains: ["git.corp.com"],
    });

    it("allows source matching org rule", () => {
      expect(() =>
        validateTrustedSource("getsentry/anything", trust),
      ).not.toThrow();
    });

    it("allows source matching repo rule", () => {
      expect(() =>
        validateTrustedSource("external/approved", trust),
      ).not.toThrow();
    });

    it("allows source matching domain rule", () => {
      expect(() =>
        validateTrustedSource("git:https://git.corp.com/team/repo.git", trust),
      ).not.toThrow();
    });

    it("rejects source matching none", () => {
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        TrustError,
      );
    });
  });

  describe("case-insensitive matching", () => {
    it("matches GitHub orgs case-insensitively", () => {
      const trust = makeTrust({ github_orgs: ["getsentry"] });
      expect(() =>
        validateTrustedSource("GetSentry/repo", trust),
      ).not.toThrow();
      expect(() =>
        validateTrustedSource("GETSENTRY/repo", trust),
      ).not.toThrow();
    });

    it("matches GitHub repos case-insensitively", () => {
      const trust = makeTrust({ github_repos: ["MyOrg/MyRepo"] });
      expect(() => validateTrustedSource("myorg/myrepo", trust)).not.toThrow();
      expect(() => validateTrustedSource("MYORG/MYREPO", trust)).not.toThrow();
    });

    it("matches git domains case-insensitively", () => {
      const trust = makeTrust({ git_domains: ["git.corp.example.com"] });
      expect(() =>
        validateTrustedSource(
          "git:https://Git.Corp.Example.COM/repo.git",
          trust,
        ),
      ).not.toThrow();
    });
  });

  describe("error messages", () => {
    it("includes the rejected source", () => {
      const trust = makeTrust({ github_orgs: ["getsentry"] });
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        /evil\/repo/,
      );
    });

    it("includes allowed alternatives", () => {
      const trust = makeTrust({
        github_orgs: ["getsentry"],
        github_repos: ["ext/one"],
      });
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        /getsentry/,
      );
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        /ext\/one/,
      );
    });

    it("suggests dotagents trust add for GitHub sources", () => {
      const trust = makeTrust({ github_orgs: ["getsentry"] });
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        /dotagents trust add evil/,
      );
      expect(() => validateTrustedSource("evil/repo", trust)).toThrow(
        /dotagents trust add evil\/repo/,
      );
    });

    it("suggests dotagents trust add for git domain sources", () => {
      const trust = makeTrust({ git_domains: ["git.corp.com"] });
      expect(() =>
        validateTrustedSource("git:https://evil.com/repo.git", trust),
      ).toThrow(/dotagents trust add evil\.com/);
    });
  });
});

describe("extractDomain", () => {
  it("extracts from https URL", () => {
    expect(extractDomain("https://git.corp.com/team/repo.git")).toBe(
      "git.corp.com",
    );
  });

  it("extracts from ssh URL", () => {
    expect(extractDomain("ssh://git.corp.com/team/repo.git")).toBe(
      "git.corp.com",
    );
  });

  it("extracts from git:// URL", () => {
    expect(extractDomain("git://git.corp.com/team/repo.git")).toBe(
      "git.corp.com",
    );
  });

  it("extracts from scp-style URL", () => {
    expect(extractDomain("git@github.com:owner/repo.git")).toBe("github.com");
  });

  it("returns undefined for file:// URLs", () => {
    // file:///tmp/repo has empty hostname
    expect(extractDomain("file:///tmp/repo")).toBeUndefined();
  });

  it("returns undefined for bare paths", () => {
    expect(extractDomain("/tmp/local-repo")).toBeUndefined();
  });
});

describe("extractDomainPath", () => {
  it("extracts domain/path from https URL", () => {
    expect(extractDomainPath("https://gitlab.com/owner/group/repo.git")).toBe(
      "gitlab.com/owner/group/repo",
    );
  });

  it("extracts domain/path from scp-style URL", () => {
    expect(extractDomainPath("git@gitlab.com:owner/group/repo.git")).toBe(
      "gitlab.com/owner/group/repo",
    );
  });

  it("strips .git suffix", () => {
    expect(extractDomainPath("https://gitlab.com/owner/repo.git")).toBe(
      "gitlab.com/owner/repo",
    );
  });

  it("strips trailing slashes", () => {
    expect(extractDomainPath("https://gitlab.com/owner/repo/")).toBe(
      "gitlab.com/owner/repo",
    );
  });

  it("returns just domain when no path", () => {
    expect(extractDomainPath("https://gitlab.com")).toBe("gitlab.com");
  });

  it("handles ssh:// URLs", () => {
    expect(extractDomainPath("ssh://git.corp.com/team/repo.git")).toBe(
      "git.corp.com/team/repo",
    );
  });

  it("returns undefined for file:// URLs", () => {
    expect(extractDomainPath("file:///tmp/repo")).toBeUndefined();
  });

  it("returns undefined for bare paths", () => {
    expect(extractDomainPath("/tmp/local-repo")).toBeUndefined();
  });
});
