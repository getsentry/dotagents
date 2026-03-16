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
        <p className="tagline">Shared Tooling for Coding Agents</p>
        <p className="tagline-sub">
          Declare skill dependencies in <code>agents.toml</code>, install with
          one command, and let every tool discover skills from one place.
        </p>
        <div className="cta-buttons">
          <a href="/guide" className="btn btn-primary">
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
              tools expect them. Manage{" "}
              <a href="/guide#personal-skills">personal skills</a> across all
              your projects with <code>--user</code>.
            </p>
          </div>
          <div className="feature">
            <h3>One command to install</h3>
            <p>
              <code>agents.toml</code> is committed, managed skills are
              gitignored. Collaborators run <code>install</code> and get the
              same setup.
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
          Run <code>init</code> to set up a new project. The interactive setup
          walks you through selecting agents and trust policy.
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
          Use <code>dotagents add</code> to install skills from git repos or
          local directories.
        </p>
        <pre>
          <code>{`# Add a single skill from a GitHub repo
dotagents add getsentry/skills --name find-bugs

# Add all skills from a repo
dotagents add getsentry/skills --all

# Pin to a specific ref
dotagents add getsentry/warden@v1.0.0

# Add from GitLab
dotagents add https://gitlab.com/group/repo --name find-bugs

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
        <p>
          Shorthand <code>owner/repo</code> resolves using{" "}
          <code>defaultRepositorySource</code> in <code>agents.toml</code>{" "}
          (default: <code>github</code>).
        </p>
        <p>
          Read the <a href="/guide">Guide</a> for the full setup walkthrough,
          including trust policies, git hooks, and CI configuration.
        </p>
      </section>
    </>
  );
}
