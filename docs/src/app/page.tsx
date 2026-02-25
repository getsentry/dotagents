function Terminal({ children }: { children: React.ReactNode }) {
  return (
    <div className="terminal">
      <div className="terminal-header">
        <span className="terminal-dot red" />
        <span className="terminal-dot yellow" />
        <span className="terminal-dot green" />
      </div>
      <div className="terminal-body">{children}</div>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <div className="hero">
        <p className="tagline">Package Manager for .agents</p>
        <p className="tagline-sub">
          Declare skill dependencies in <code>agents.toml</code>, lock versions
          for reproducibility, and let every tool discover skills from one place.
        </p>
        <div className="cta-buttons">
          <a href="/cli" className="btn btn-primary">
            Get Started
          </a>
          <a
            href="https://github.com/getsentry/dotagents"
            className="btn btn-secondary"
          >
            GitHub
          </a>
        </div>
      </div>

      <section className="section" id="why">
        <h2>Why dotagents?</h2>
        <div className="feature-grid">
          <div className="feature">
            <h3>One source of truth</h3>
            <p>
              Skills live in <code>.agents/skills/</code> and symlink into{" "}
              <code>.claude/</code>, <code>.cursor/</code>, or wherever your
              tools expect them.
            </p>
          </div>
          <div className="feature">
            <h3>Reproducible</h3>
            <p>
              <code>agents.lock</code> pins exact commits and integrity hashes.{" "}
              <code>--frozen</code> in CI guarantees everyone runs the same
              skills.
            </p>
          </div>
          <div className="feature">
            <h3>Shareable</h3>
            <p>
              Skills are directories with a <code>SKILL.md</code>. Host them in
              any git repo, discover automatically, install with one command.
            </p>
          </div>
          <div className="feature">
            <h3>Multi-agent</h3>
            <p>
              Configure Claude, Cursor, Codex, VS Code, and OpenCode from a
              single <code>agents.toml</code>. Skills, MCP servers, and hooks.
            </p>
          </div>
        </div>
      </section>

      <section className="steps" id="quick-start">
        <h2>Quick Start</h2>
        <p>
          Run <code>init</code> to set up a new project. The interactive TUI
          walks you through selecting agents, gitignore preference, and trust
          policy.
        </p>
        <Terminal>
          <pre>
            <code className="cli">
              <span className="cli-dim">$</span> npx @sentry/dotagents init
            </code>
          </pre>
        </Terminal>
      </section>

      <section className="section" id="agents">
        <h2>Supported Agents</h2>
        <p>
          The <code>agents</code> array tells dotagents which tools to
          configure. Each agent gets skill symlinks, MCP server configs, and
          hook configs.
        </p>
        <pre>
          <code>agents = [&quot;claude&quot;, &quot;cursor&quot;]</code>
        </pre>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Config Dir</th>
              <th>MCP Config</th>
              <th>Hooks</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>claude</code>
              </td>
              <td>
                <code>.claude</code>
              </td>
              <td>
                <code>.mcp.json</code>
              </td>
              <td>
                <code>.claude/settings.json</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>cursor</code>
              </td>
              <td>
                <code>.cursor</code>
              </td>
              <td>
                <code>.cursor/mcp.json</code>
              </td>
              <td>
                <code>.cursor/hooks.json</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>codex</code>
              </td>
              <td>
                <code>.codex</code>
              </td>
              <td>
                <code>.codex/config.toml</code>
              </td>
              <td>--</td>
            </tr>
            <tr>
              <td>
                <code>vscode</code>
              </td>
              <td>
                <code>.vscode</code>
              </td>
              <td>
                <code>.vscode/mcp.json</code>
              </td>
              <td>
                <code>.claude/settings.json</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>opencode</code>
              </td>
              <td>
                <code>.claude</code>
              </td>
              <td>
                <code>opencode.json</code>
              </td>
              <td>--</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="section" id="adding-skills">
        <h2>Adding Skills</h2>
        <p>
          Use <code>dotagents add</code> to install skills from GitHub repos,
          git URLs, or local directories.
        </p>
        <pre>
          <code>{`# Add a single skill from a GitHub repo
dotagents add getsentry/skills --name find-bugs

# Add all skills from a repo
dotagents add getsentry/skills --all

# Pin to a specific version
dotagents add getsentry/warden@v1.0.0

# From a non-GitHub git server
dotagents add git:https://git.corp.dev/team/skills --name review

# From a local directory
dotagents add path:./my-skills/custom`}</code>
        </pre>
        <p>
          When a repo has one skill, it is added automatically. When multiple
          are found, use <code>--name</code> to pick one or{" "}
          <code>--all</code> to add them all as a wildcard entry.
        </p>
      </section>

      <section className="section" id="source-formats">
        <h2>Source Formats</h2>
        <table>
          <thead>
            <tr>
              <th>Format</th>
              <th>Example</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>GitHub</strong>
              </td>
              <td>
                <code>getsentry/skills</code>
              </td>
              <td>Auto-discovers skills by name</td>
            </tr>
            <tr>
              <td>
                <strong>Pinned</strong>
              </td>
              <td>
                <code>getsentry/skills@v1.0.0</code>
              </td>
              <td>Locked to a specific ref</td>
            </tr>
            <tr>
              <td>
                <strong>Git URL</strong>
              </td>
              <td>
                <code>git:https://git.corp.dev/repo</code>
              </td>
              <td>Non-GitHub git servers</td>
            </tr>
            <tr>
              <td>
                <strong>Local</strong>
              </td>
              <td>
                <code>path:./my-skills/custom</code>
              </td>
              <td>Local directory, relative to project root</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="section" id="configuration">
        <h2>Configuration</h2>
        <p>
          Full <code>agents.toml</code> example with skills, wildcards, MCP
          servers, and hooks:
        </p>
        <pre>
          <code>{`version = 1
gitignore = true
agents = ["claude", "cursor"]

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
          See the <a href="/cli">CLI reference</a> for all commands and flags,
          or the <a href="/security">Security page</a> for trust configuration.
        </p>
      </section>
    </>
  );
}
