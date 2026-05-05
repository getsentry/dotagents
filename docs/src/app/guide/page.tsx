import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Guide - dotagents",
  description: "Set up and use dotagents in your project",
};

export default function GuidePage() {
  return (
    <>
      <section className="section" id="setup" style={{ borderTop: "none" }}>
        <h2>Setup</h2>
        <p>
          Three commands to go from zero to working skills. Run these at the
          root of your repository.
        </p>

        <h3>1. Initialize</h3>
        <p>
          Create <code>agents.toml</code> and the <code>.agents/skills/</code>{" "}
          directory. The interactive setup prompts for which agent tools you use
          (Claude, Cursor, etc.).
        </p>
        <pre>
          <code>npx @sentry/dotagents init</code>
        </pre>
        <p>
          This also adds <code>agents.lock</code> and{" "}
          <code>.agents/.gitignore</code> to your root <code>.gitignore</code>.
          These are generated files that should not be committed.
        </p>

        <h3>2. Add Skills</h3>
        <p>
          Install skills from GitHub repos, git URLs, well-known HTTPS sources,
          or local directories.
        </p>
        <pre>
          <code>{`# Add a single skill
dotagents add getsentry/skills --name find-bugs

# Add all skills from a repo
dotagents add getsentry/skills --all

# Pin to a specific ref
dotagents add getsentry/warden@v1.0.0

# Add from a well-known HTTPS source
dotagents add https://cli.sentry.dev --name error-tracking`}</code>
        </pre>
        <p>
          Each skill is copied into <code>.agents/skills/</code> and symlinked
          to where your agent tools expect them. See the{" "}
          <a href="/cli#source-formats">CLI reference</a> for all source
          formats.
        </p>

        <h3>3. Install</h3>
        <p>
          After cloning the repo or pulling changes, run <code>install</code>{" "}
          to fetch or refresh managed skills. Managed skills are gitignored, so
          collaborators run this command locally.
        </p>
        <pre>
          <code>dotagents install</code>
        </pre>
        <p>
          This is also the update path. There is no separate update command.
        </p>
      </section>

      <section className="section" id="gitignore">
        <h2>What Gets Gitignored</h2>
        <p>
          dotagents manages gitignore automatically. Two generated files are
          kept out of version control:
        </p>
        <ul>
          <li>
            <code>agents.lock</code> &mdash; tracks which skills are managed
          </li>
          <li>
            <code>.agents/.gitignore</code> &mdash; excludes managed skill
            directories
          </li>
        </ul>
        <p>
          Custom skills you create directly in <code>.agents/skills/</code> are
          not gitignored. They&apos;re tracked by git normally, so collaborators
          get them without running install.
        </p>
      </section>

      <section className="section" id="trust">
        <h2>Trust Policies</h2>
        <p>
          By default, any source is allowed. For teams, add a{" "}
          <code>[trust]</code> section to restrict which sources can provide
          skills. Trust is validated before any network operations.
        </p>
        <pre>
          <code>{`# Trust a GitHub org
dotagents trust add getsentry

# Trust a specific repo
dotagents trust add external-org/specific-repo

# Trust a self-hosted git server
dotagents trust add git.corp.example.com`}</code>
        </pre>
        <p>
          See the <a href="/security">Security page</a> for the full trust
          configuration reference.
        </p>
      </section>

      <section className="section" id="git-hooks">
        <h2>Auto-install with Git Hooks</h2>
        <p>
          Since managed skills are gitignored, run{" "}
          <code>dotagents install</code> after pulling. A{" "}
          <code>post-merge</code> hook automates this:
        </p>
        <pre>
          <code>{`#!/bin/sh
# .git/hooks/post-merge
npx --yes @sentry/dotagents install || echo "dotagents install failed"
`}</code>
        </pre>
        <p>
          Make it executable: <code>chmod +x .git/hooks/post-merge</code>
        </p>
        <p>
          Git hooks aren&apos;t shared via git. Tools like{" "}
          <a href="https://github.com/evilmartians/lefthook">lefthook</a> or{" "}
          <a href="https://typicode.github.io/husky/">husky</a> can set them up
          for the whole team.
        </p>
      </section>

      <section className="section" id="sync">
        <h2>Keeping Things in Sync</h2>
        <p>
          Use <code>dotagents sync</code> for offline repair. It doesn&apos;t
          fetch anything from the network. Instead, it:
        </p>
        <ul>
          <li>Adopts truly local orphaned skills (installed but not declared)</li>
          <li>Prunes stale managed skills removed from config</li>
          <li>
            Regenerates <code>.agents/.gitignore</code>
          </li>
          <li>Repairs broken symlinks</li>
          <li>Fixes MCP and hook configs</li>
        </ul>
      </section>

      <section className="section" id="doctor">
        <h2>Diagnosing Issues</h2>
        <p>
          Use <code>dotagents doctor</code> to check project health. It
          identifies configuration issues and can fix them automatically.
        </p>
        <pre>
          <code>{`dotagents doctor        # check for issues
dotagents doctor --fix  # auto-fix what it can`}</code>
        </pre>
        <p>
          Checks for missing gitignore entries, legacy config fields, missing
          skills, and broken symlinks. Especially useful when migrating from an
          older version.
        </p>
      </section>

      <section className="section" id="personal-skills">
        <h2>Personal Skills</h2>
        <p>
          Project skills live in <code>agents.toml</code> and are shared with
          your team. Personal skills apply to all your projects &mdash; useful
          for tools and workflows only you need.
        </p>
        <p>
          Use <code>--user</code> to manage personal skills:
        </p>
        <pre>
          <code>{`dotagents --user init
dotagents --user add getsentry/skills --all
dotagents --user install`}</code>
        </pre>
        <p>
          Personal skills live in <code>~/.agents/</code> and symlink to{" "}
          <code>~/.claude/skills/</code> and <code>~/.cursor/skills/</code>.
          Override the location with <code>DOTAGENTS_HOME</code>.
        </p>
        <p>
          When you run dotagents outside a git repo without an{" "}
          <code>agents.toml</code>, it falls back to user scope automatically.
        </p>
      </section>

      <section className="section" id="configuration">
        <h2>Full Configuration Example</h2>
        <p>
          <code>agents.toml</code> with skills, wildcards, MCP servers, and
          hooks:
        </p>
        <pre>
          <code>{`version = 1
agents = ["claude", "cursor"]
minimum_release_age = 60
minimum_release_age_exclude = ["getsentry/*"]

[trust]
github_orgs = ["getsentry"]

# Individual skill
[[skills]]
name = "find-bugs"
source = "getsentry/skills"

# Pinned to a ref
[[skills]]
name = "warden-skill"
source = "getsentry/warden@v1.0.0"

# Well-known HTTPS source
[[skills]]
name = "error-tracking"
source = "https://cli.sentry.dev"

# Wildcard: all skills from a repo
[[skills]]
name = "*"
source = "myorg/skills"
exclude = ["deprecated-skill"]

# MCP server (stdio)
[[mcp]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = ["GITHUB_TOKEN"]

# MCP server (HTTP with OAuth)
[[mcp]]
name = "remote-api"
url = "https://mcp.example.com/sse"

# Hooks
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-lint-check"`}</code>
        </pre>
        <p>
          See the <a href="/cli#configuration">CLI reference</a> for all fields
          and options.
        </p>
      </section>
    </>
  );
}
