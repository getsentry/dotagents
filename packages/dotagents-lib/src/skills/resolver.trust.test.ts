import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSkill, resolveWildcardSkills } from "./resolver.js";
import { TrustError } from "../trust/validator.js";
import type { TrustPolicy } from "../trust/policy.js";

vi.mock("../sources/cache.js", () => ({
  ensureCached: vi.fn(async () => {
    throw new Error("ensureCached should not be called when trust rejects");
  }),
}));

vi.mock("../sources/wellknown.js", () => ({
  ensureWellKnownCached: vi.fn(async () => {
    throw new Error("ensureWellKnownCached should not be called when trust rejects");
  }),
}));

vi.mock("../sources/local.js", () => ({
  resolveLocalSource: vi.fn(async () => {
    throw new Error("resolveLocalSource should not be called when trust rejects");
  }),
  LocalSourceError: class extends Error {},
}));

import { ensureCached } from "../sources/cache.js";
import { ensureWellKnownCached } from "../sources/wellknown.js";

const allowOnlyAnthropics: TrustPolicy = {
  allow_all: false,
  github_orgs: ["anthropics"],
  github_repos: [],
  git_domains: [],
};

const STATE_DIR = "/tmp/dotagents-trust-test-cache";

describe("resolveSkill with trust opt", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks a disallowed source BEFORE any network access", async () => {
    await expect(
      resolveSkill(
        "foo",
        { source: "evil-org/evil-skills" },
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(ensureCached).not.toHaveBeenCalled();
    expect(ensureWellKnownCached).not.toHaveBeenCalled();
  });

  it("blocks a disallowed well-known source BEFORE any network access", async () => {
    await expect(
      resolveSkill(
        "foo",
        { source: "https://untrusted.example.com/skills" },
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(ensureCached).not.toHaveBeenCalled();
    expect(ensureWellKnownCached).not.toHaveBeenCalled();
  });

  it("validates the expanded source under a non-default host (regression: shorthand+gitlab bypass)", async () => {
    // User trusts GitHub's "anthropics" but configures gitlab as the default host.
    // Shorthand "anthropics/skills" must NOT pass trust here — the actual clone
    // would target gitlab.com/anthropics/skills, which the policy never authorized.
    await expect(
      resolveSkill(
        "foo",
        { source: "anthropics/skills" },
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics, defaultRepositorySource: "gitlab" },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(ensureCached).not.toHaveBeenCalled();
  });

  it("does NOT enforce trust when the opt is omitted (today's behavior)", async () => {
    // No trust opt → resolver should proceed to network. Mock throws a sentinel
    // so we can verify network was attempted (rather than trust short-circuiting).
    await expect(
      resolveSkill("foo", { source: "evil-org/evil-skills" }, { stateDir: STATE_DIR }),
    ).rejects.toThrowError(/ensureCached should not be called/);

    expect(ensureCached).toHaveBeenCalledTimes(1);
  });
});

describe("resolveWildcardSkills with trust opt", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("blocks a disallowed source BEFORE any network access", async () => {
    await expect(
      resolveWildcardSkills(
        { source: "evil-org/evil-skills" },
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(ensureCached).not.toHaveBeenCalled();
    expect(ensureWellKnownCached).not.toHaveBeenCalled();
  });

  it("does NOT enforce trust when the opt is omitted", async () => {
    await expect(
      resolveWildcardSkills({ source: "evil-org/evil-skills" }, { stateDir: STATE_DIR }),
    ).rejects.toThrowError(/ensureCached should not be called/);

    expect(ensureCached).toHaveBeenCalledTimes(1);
  });
});
