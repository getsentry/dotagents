import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Security - dotagents",
  description: "Trust policies and security model for dotagents",
};

export default function SecurityPage() {
  return (
    <>
      <section className="section" id="trust" style={{ borderTop: "none" }}>
        <h2>Trust Policies</h2>
        <p>
          The <code>[trust]</code> section in <code>agents.toml</code> controls
          which skill sources are allowed. Trust is validated before any network
          operations in <code>add</code> and <code>install</code>. If a source
          does not match the policy, the command fails immediately.
        </p>

        <h3>No Trust Section (default)</h3>
        <p>
          When <code>[trust]</code> is absent, all sources are allowed. This is
          the default for backward compatibility.
        </p>
        <pre>
          <code>{`# No [trust] section — all sources allowed
version = 1
agents = ["claude"]

[[skills]]
name = "any-skill"
source = "anyone/any-repo"`}</code>
        </pre>

        <h3>Allowlist Mode</h3>
        <p>
          Add a <code>[trust]</code> section to restrict sources to an
          allowlist. A source passes if it matches any rule.
        </p>
        <pre>
          <code>{`[trust]
github_orgs = ["getsentry", "my-company"]
github_repos = ["external-org/one-approved-repo"]
git_domains = ["git.corp.example.com"]`}</code>
        </pre>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Matches</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>github_orgs</code>
              </td>
              <td>
                GitHub sources where the owner matches
              </td>
              <td>
                <code>&quot;getsentry&quot;</code> matches{" "}
                <code>getsentry/skills</code>,{" "}
                <code>getsentry/warden</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>github_repos</code>
              </td>
              <td>
                Exact <code>owner/repo</code> match
              </td>
              <td>
                <code>&quot;external-org/one-approved-repo&quot;</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>git_domains</code>
              </td>
              <td>
                Domain extracted from <code>git:</code> URLs
              </td>
              <td>
                <code>&quot;git.corp.example.com&quot;</code> matches{" "}
                <code>git:https://git.corp.example.com/team/repo</code>
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Local <code>path:</code> sources are always allowed regardless of
          trust configuration.
        </p>
        <p>
          You can also manage trusted sources from the CLI instead of editing
          TOML directly:
        </p>
        <pre>
          <code>{`dotagents trust add getsentry                    # trust a GitHub org
dotagents trust add external-org/specific-repo   # trust a specific repo
dotagents trust add git.corp.example.com         # trust a git domain
dotagents trust list                             # show trusted sources`}</code>
        </pre>

        <h3>Explicit Allow All</h3>
        <p>
          Use <code>allow_all = true</code> to make the intent explicit in
          shared repositories. This is functionally the same as omitting the
          section, but communicates that the choice was deliberate.
        </p>
        <pre>
          <code>{`[trust]
allow_all = true`}</code>
        </pre>
      </section>

      <section className="section" id="integrity">
        <h2>Integrity Verification</h2>
        <p>
          Every installed skill gets a SHA-256 integrity hash recorded in{" "}
          <code>agents.lock</code>. This hash is computed deterministically
          from the skill directory contents.
        </p>

        <h3>How It Works</h3>
        <ol>
          <li>Walk all files in the skill directory, sorted alphabetically</li>
          <li>SHA-256 hash each file&apos;s contents</li>
          <li>
            Concatenate{" "}
            <code>&lt;relative-path&gt;\0&lt;hex-hash&gt;\n</code> for each
            file
          </li>
          <li>SHA-256 hash the concatenation</li>
          <li>
            Base64-encode and prefix with <code>sha256-</code>
          </li>
        </ol>
        <pre>
          <code>{`[skills.find-bugs]
source = "getsentry/skills"
resolved_url = "https://github.com/getsentry/skills.git"
commit = "c8881564e75eff4faaecc82d1c3f13356851b6e7"
integrity = "sha256-FWmCLdOj+x+XffiEg7Bx19drylVypeKz8me9OA757js="`}</code>
        </pre>

        <h3>Verification</h3>
        <ul>
          <li>
            <code>dotagents list</code> shows <code>~</code> for skills whose
            contents have been modified since install
          </li>
          <li>
            <code>dotagents sync</code> verifies all integrity hashes and
            reports mismatches
          </li>
          <li>
            <code>dotagents install --frozen</code> fails if hashes don&apos;t
            match after install
          </li>
        </ul>
      </section>

      <section className="section" id="frozen">
        <h2>Frozen Installs (CI)</h2>
        <p>
          Use <code>--frozen</code> in CI to guarantee reproducible installs.
        </p>
        <pre>
          <code>dotagents install --frozen</code>
        </pre>
        <p>This mode:</p>
        <ul>
          <li>
            Fails if <code>agents.lock</code> does not exist
          </li>
          <li>
            Fails if any skill in <code>agents.toml</code> is missing from the
            lockfile
          </li>
          <li>Fails if integrity hashes don&apos;t match after install</li>
          <li>Does not modify the lockfile</li>
        </ul>
      </section>

      <section className="section" id="lockfile">
        <h2>Lockfile</h2>
        <p>
          <code>agents.lock</code> pins exact git commits and integrity hashes
          for every installed skill. It is auto-generated and should be
          committed to version control.
        </p>
        <pre>
          <code>{`# Auto-generated by dotagents. Do not edit.
version = 1

[skills.find-bugs]
source = "getsentry/skills"
resolved_url = "https://github.com/getsentry/skills.git"
resolved_path = "plugins/sentry-skills/skills/find-bugs"
commit = "c8881564e75eff4faaecc82d1c3f13356851b6e7"
integrity = "sha256-FWmCLdOj+x+XffiEg7Bx19drylVypeKz8me9OA757js="`}</code>
        </pre>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>source</code>
              </td>
              <td>Original source from agents.toml</td>
            </tr>
            <tr>
              <td>
                <code>resolved_url</code>
              </td>
              <td>Resolved git clone URL</td>
            </tr>
            <tr>
              <td>
                <code>resolved_path</code>
              </td>
              <td>Subdirectory within repo where skill was found</td>
            </tr>
            <tr>
              <td>
                <code>resolved_ref</code>
              </td>
              <td>Resolved ref name (omitted for default branch)</td>
            </tr>
            <tr>
              <td>
                <code>commit</code>
              </td>
              <td>Full 40-char SHA</td>
            </tr>
            <tr>
              <td>
                <code>integrity</code>
              </td>
              <td>SHA-256 content hash</td>
            </tr>
          </tbody>
        </table>
        <p>
          Local <code>path:</code> skills have <code>source</code> and{" "}
          <code>integrity</code> only.
        </p>
      </section>

      <section className="section" id="caching">
        <h2>Caching</h2>
        <p>
          Cloned repositories are cached at{" "}
          <code>~/.local/dotagents/</code> (override with{" "}
          <code>DOTAGENTS_STATE_DIR</code>).
        </p>
        <ul>
          <li>
            <strong>Unpinned repos</strong> (<code>owner/repo/</code>): shallow
            clone, refreshed after a 24-hour TTL
          </li>
          <li>
            <strong>Pinned refs</strong> (<code>owner/repo@sha/</code>):
            immutable, never re-fetched
          </li>
          <li>
            All git operations are non-interactive (
            <code>GIT_TERMINAL_PROMPT=0</code>)
          </li>
          <li>
            Use <code>dotagents install --force</code> to bypass cache
          </li>
        </ul>
      </section>
    </>
  );
}
