import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSkill, resolveWildcardSkills, type ResolverServices } from "./resolver.js";
import { TrustError } from "../trust/validator.js";
import type { TrustPolicy } from "../trust/policy.js";

const services = {
  ensureCached: vi.fn(async () => {
    throw new Error("ensureCached should not be called when trust rejects");
  }),
  ensureWellKnownCached: vi.fn(async () => {
    throw new Error("ensureWellKnownCached should not be called when trust rejects");
  }),
  resolveLocalSource: vi.fn(async () => {
    throw new Error("resolveLocalSource should not be called when trust rejects");
  }),
} satisfies ResolverServices;

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
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics, services },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(services.ensureCached).not.toHaveBeenCalled();
    expect(services.ensureWellKnownCached).not.toHaveBeenCalled();
  });

  it("blocks a disallowed well-known source BEFORE any network access", async () => {
    await expect(
      resolveSkill(
        "foo",
        { source: "https://untrusted.example.com/skills" },
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics, services },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(services.ensureCached).not.toHaveBeenCalled();
    expect(services.ensureWellKnownCached).not.toHaveBeenCalled();
  });

  it("validates the expanded source under a non-default host (regression: shorthand+gitlab bypass)", async () => {
    // User trusts GitHub's "anthropics" but configures gitlab as the default host.
    // Shorthand "anthropics/skills" must NOT pass trust here — the actual clone
    // would target gitlab.com/anthropics/skills, which the policy never authorized.
    await expect(
      resolveSkill(
        "foo",
        { source: "anthropics/skills" },
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics, defaultRepositorySource: "gitlab", services },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(services.ensureCached).not.toHaveBeenCalled();
  });

  it("does NOT enforce trust when the opt is omitted (today's behavior)", async () => {
    // No trust opt → resolver should proceed to network. Mock throws a sentinel
    // so we can verify network was attempted (rather than trust short-circuiting).
    await expect(
      resolveSkill("foo", { source: "evil-org/evil-skills" }, { stateDir: STATE_DIR, services }),
    ).rejects.toThrowError(/ensureCached should not be called/);

    expect(services.ensureCached).toHaveBeenCalledTimes(1);
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
        { stateDir: STATE_DIR, trust: allowOnlyAnthropics, services },
      ),
    ).rejects.toBeInstanceOf(TrustError);

    expect(services.ensureCached).not.toHaveBeenCalled();
    expect(services.ensureWellKnownCached).not.toHaveBeenCalled();
  });

  it("does NOT enforce trust when the opt is omitted", async () => {
    await expect(
      resolveWildcardSkills({ source: "evil-org/evil-skills" }, { stateDir: STATE_DIR, services }),
    ).rejects.toThrowError(/ensureCached should not be called/);

    expect(services.ensureCached).toHaveBeenCalledTimes(1);
  });
});
