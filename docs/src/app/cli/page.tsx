import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CLI - dotagents",
  description: "dotagents CLI reference",
};

function CliCommand({
  name,
  synopsis,
  description,
  options,
  examples,
}: {
  name: string;
  synopsis: string;
  description: React.ReactNode;
  options?: { flag: string; description: string }[];
  examples?: string[];
}) {
  return (
    <div className="cli-command" id={name}>
      <h3>
        <code>dotagents {name}</code>
      </h3>
      <pre>
        <code>{synopsis}</code>
      </pre>
      <p>{description}</p>
      {options && options.length > 0 && (
        <ul className="cli-options">
          {options.map((opt) => (
            <li key={opt.flag}>
              <code>{opt.flag}</code> {opt.description}
            </li>
          ))}
        </ul>
      )}
      {examples && examples.length > 0 && (
        <pre>
          <code>{examples.join("\n")}</code>
        </pre>
      )}
    </div>
  );
}

export default function CliPage() {
  return (
    <>
      <section className="section" id="usage" style={{ borderTop: "none" }}>
        <h2>Usage</h2>
        <pre>
          <code>dotagents [--user] &lt;command&gt; [options]</code>
        </pre>
      </section>

      <section className="section" id="global-options">
        <h2>Global Options</h2>
        <ul>
          <li>
            <code>--user</code> Operate on user scope (
            <code>~/.agents/</code>) instead of the current project
          </li>
          <li>
            <code>--help</code>, <code>-h</code> Show help
          </li>
          <li>
            <code>--version</code>, <code>-V</code> Show version
          </li>
        </ul>
      </section>

      <section className="section" id="commands">
        <h2>Commands</h2>

        <CliCommand
          name="init"
          synopsis="dotagents init [--agents claude,cursor] [--force]"
          description={
            <>
              Initialize a new project with <code>agents.toml</code> and{" "}
              <code>.agents/skills/</code>. Interactive mode prompts for agent
              targets and trust policy. Sets up gitignore entries automatically.
            </>
          }
          options={[
            {
              flag: "--agents <list>",
              description:
                "Comma-separated agent targets (claude, cursor, codex, vscode, opencode)",
            },
            {
              flag: "--force",
              description: "Overwrite existing agents.toml",
            },
          ]}
          examples={[
            "dotagents init",
            "dotagents init --agents claude,cursor",
            "dotagents --user init",
          ]}
        />

        <CliCommand
          name="install"
          synopsis="dotagents install [--force]"
          description="Install all skill dependencies from agents.toml. Resolves sources, copies skills, writes lockfile, creates symlinks, generates MCP and hook configs. Always fetches latest unless a ref is pinned."
          options={[
            {
              flag: "--force",
              description:
                "Re-resolve and re-install all skills, ignoring cache",
            },
          ]}
          examples={[
            "dotagents install",
            "dotagents install --force    # bypass cache",
          ]}
        />

        <CliCommand
          name="add"
          synopsis="dotagents add <source> [--name <name>] [--ref <ref>] [--all]"
          description={
            <>
              Add a skill dependency and install it. Auto-discovers skills in
              the repo. When a repo has one skill, it is added automatically.
              When multiple are found, use <code>--name</code> to pick one or{" "}
              <code>--all</code> to add them all as a wildcard entry. Shorthand{" "}
              <code>owner/repo</code> resolves via{" "}
              <code>defaultRepositorySource</code> in{" "}
              <code>agents.toml</code>.
            </>
          }
          options={[
            {
              flag: "--name <name>",
              description: "Specify which skill to add (alias: --skill)",
            },
            {
              flag: "--ref <ref>",
              description: "Pin to a specific tag, branch, or commit",
            },
            {
              flag: "--all",
              description:
                'Add all skills from the source as a wildcard entry (name = "*")',
            },
          ]}
          examples={[
            "# Single skill from GitHub",
            "dotagents add getsentry/skills --name find-bugs",
            "",
            "# All skills from a repo",
            "dotagents add getsentry/skills --all",
            "",
            "# Pinned to a version",
            "dotagents add getsentry/warden@v1.0.0",
            "",
            "# Explicit GitLab URL",
            "dotagents add https://gitlab.com/group/repo --name find-bugs",
            "",
            "# Non-GitHub git server",
            "dotagents add git:https://git.corp.dev/team/skills --name review",
            "",
            "# Local directory",
            "dotagents add path:./my-skills/custom",
          ]}
        />

        <CliCommand
          name="remove"
          synopsis="dotagents remove <name>"
          description={
            <>
              Remove a skill from <code>agents.toml</code>, delete from disk,
              and update the lockfile. For wildcard-sourced skills, adds to the{" "}
              <code>exclude</code> list instead of removing the entire wildcard
              entry.
            </>
          }
          examples={["dotagents remove find-bugs"]}
        />

        <CliCommand
          name="sync"
          synopsis="dotagents sync"
          description="Reconcile project state without network access. Adopts orphaned skills, regenerates gitignore, repairs symlinks and MCP/hook configs. Reports issues as warnings or errors."
        />

        <CliCommand
          name="mcp add"
          synopsis="dotagents mcp add <name> --command <cmd> [--args <a>...] [--env <VAR>...]
dotagents mcp add <name> --url <url> [--header <Key:Value>...] [--env <VAR>...]"
          description={
            <>
              Add an MCP server declaration to <code>agents.toml</code> and run{" "}
              <code>install</code> to generate agent configs. Specify exactly one
              transport: <code>--command</code> for stdio or <code>--url</code>{" "}
              for HTTP.
            </>
          }
          options={[
            {
              flag: "--command <cmd>",
              description: "Command to execute (stdio transport)",
            },
            {
              flag: "--args <arg>",
              description: "Command argument (repeatable)",
            },
            {
              flag: "--url <url>",
              description: "Server URL (HTTP transport)",
            },
            {
              flag: "--header <Key:Value>",
              description: "HTTP header (repeatable, url servers only)",
            },
            {
              flag: "--env <VAR>",
              description:
                "Environment variable name to pass through (repeatable)",
            },
          ]}
          examples={[
            "# Stdio server",
            "dotagents mcp add github --command npx --args -y --args @modelcontextprotocol/server-github --env GITHUB_TOKEN",
            "",
            "# HTTP server with auth header",
            "dotagents mcp add remote --url https://mcp.example.com/sse --header Authorization:Bearer\\ tok",
          ]}
        />

        <CliCommand
          name="mcp remove"
          synopsis="dotagents mcp remove <name>"
          description={
            <>
              Remove an MCP server declaration from <code>agents.toml</code> and
              run <code>install</code> to regenerate agent configs.
            </>
          }
          examples={["dotagents mcp remove github"]}
        />

        <CliCommand
          name="mcp list"
          synopsis="dotagents mcp list [--json]"
          description={
            <>
              Show declared MCP servers. Use <code>--json</code> for
              machine-readable output.
            </>
          }
          examples={[
            "dotagents mcp list",
            "dotagents mcp list --json",
          ]}
        />

        <CliCommand
          name="trust add"
          synopsis="dotagents trust add <source>"
          description={
            <>
              Add a trusted source to <code>[trust]</code> in{" "}
              <code>agents.toml</code>. The type is inferred automatically:{" "}
              <code>owner/repo</code> for repos, names with <code>.</code> for
              domains, and bare names for GitHub orgs.
            </>
          }
          examples={[
            "dotagents trust add getsentry",
            "dotagents trust add external-org/specific-repo",
            "dotagents trust add git.corp.example.com",
          ]}
        />

        <CliCommand
          name="trust remove"
          synopsis="dotagents trust remove <source>"
          description={
            <>
              Remove a trusted source from <code>[trust]</code> in{" "}
              <code>agents.toml</code>. Matching is case-insensitive.
            </>
          }
          examples={["dotagents trust remove getsentry"]}
        />

        <CliCommand
          name="trust list"
          synopsis="dotagents trust list [--json]"
          description={
            <>
              Show trusted sources with their type. Use <code>--json</code> for
              machine-readable output.
            </>
          }
          examples={[
            "dotagents trust list",
            "dotagents trust list --json",
          ]}
        />

        <CliCommand
          name="doctor"
          synopsis="dotagents doctor [--fix]"
          description="Check project health and fix issues. Verifies gitignore setup, installed skills, symlinks, and detects legacy config fields. Useful for migrating to a new version of dotagents."
          options={[
            {
              flag: "--fix",
              description: "Auto-fix issues where possible",
            },
          ]}
          examples={[
            "dotagents doctor          # check for issues",
            "dotagents doctor --fix    # fix what it can",
          ]}
        />

        <CliCommand
          name="list"
          synopsis="dotagents list [--json]"
          description={
            <>
              Show installed skills and status. Use <code>--json</code> for
              machine-readable output.
            </>
          }
          options={[
            {
              flag: "✓",
              description: "Installed and present in lockfile",
            },
            {
              flag: "✗",
              description: "In config but not installed",
            },
            {
              flag: "?",
              description: "Installed but not in lockfile",
            },
          ]}
        />
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
        <h2>Configuration (agents.toml)</h2>

        <h3>Top-level Fields</h3>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Default</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>version</code>
              </td>
              <td>integer</td>
              <td>--</td>
              <td>
                Schema version. Always <code>1</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>agents</code>
              </td>
              <td>string[]</td>
              <td>
                <code>[]</code>
              </td>
              <td>
                Agent targets: <code>claude</code>, <code>cursor</code>,{" "}
                <code>codex</code>, <code>vscode</code>,{" "}
                <code>opencode</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>defaultRepositorySource</code>
              </td>
              <td>string</td>
              <td>
                <code>github</code>
              </td>
              <td>
                Host used for shorthand <code>owner/repo</code> sources. Valid values: <code>github</code> or <code>gitlab</code>.
              </td>
            </tr>
          </tbody>
        </table>

        <h3>Skills</h3>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Required</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>name</code>
              </td>
              <td>string</td>
              <td>Yes</td>
              <td>
                Skill identifier. Use <code>&quot;*&quot;</code> for wildcard.
              </td>
            </tr>
            <tr>
              <td>
                <code>source</code>
              </td>
              <td>string</td>
              <td>Yes</td>
              <td>
                <code>owner/repo</code>, <code>owner/repo@ref</code>,{" "}
                GitHub/GitLab URL, <code>git:url</code>, or <code>path:relative</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>ref</code>
              </td>
              <td>string</td>
              <td>No</td>
              <td>Tag, branch, or commit SHA to pin</td>
            </tr>
            <tr>
              <td>
                <code>path</code>
              </td>
              <td>string</td>
              <td>No</td>
              <td>Subdirectory within repo (when auto-discovery fails)</td>
            </tr>
            <tr>
              <td>
                <code>exclude</code>
              </td>
              <td>string[]</td>
              <td>No</td>
              <td>Skills to skip (wildcard entries only)</td>
            </tr>
          </tbody>
        </table>

        <h3>MCP Servers</h3>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Required</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>name</code>
              </td>
              <td>string</td>
              <td>Yes</td>
              <td>Unique server identifier</td>
            </tr>
            <tr>
              <td>
                <code>command</code>
              </td>
              <td>string</td>
              <td>Stdio</td>
              <td>Command to execute</td>
            </tr>
            <tr>
              <td>
                <code>args</code>
              </td>
              <td>string[]</td>
              <td>No</td>
              <td>Command arguments</td>
            </tr>
            <tr>
              <td>
                <code>url</code>
              </td>
              <td>string</td>
              <td>HTTP</td>
              <td>Server URL</td>
            </tr>
            <tr>
              <td>
                <code>headers</code>
              </td>
              <td>table</td>
              <td>No</td>
              <td>HTTP headers (url servers only, not needed with OAuth)</td>
            </tr>
            <tr>
              <td>
                <code>env</code>
              </td>
              <td>string[]</td>
              <td>No</td>
              <td>Environment variable names to pass through</td>
            </tr>
          </tbody>
        </table>

        <h3>Hooks</h3>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Required</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>event</code>
              </td>
              <td>string</td>
              <td>Yes</td>
              <td>
                <code>PreToolUse</code>, <code>PostToolUse</code>,{" "}
                <code>UserPromptSubmit</code>, <code>Stop</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>matcher</code>
              </td>
              <td>string</td>
              <td>No</td>
              <td>Tool name filter</td>
            </tr>
            <tr>
              <td>
                <code>command</code>
              </td>
              <td>string</td>
              <td>Yes</td>
              <td>Shell command to execute</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="section" id="scopes">
        <h2>Scopes</h2>
        <h3>Project Scope (default)</h3>
        <p>
          Operates on the current project. Requires <code>agents.toml</code> at
          the project root. Skills go to <code>.agents/skills/</code>, lockfile
          to <code>agents.lock</code>.
        </p>
        <h3>User Scope (--user)</h3>
        <p>
          Manages skills shared across all projects. Files live in{" "}
          <code>~/.agents/</code> (override with <code>DOTAGENTS_HOME</code>).
          Symlinks go to <code>~/.claude/skills/</code> and{" "}
          <code>~/.cursor/skills/</code>.
        </p>
        <pre>
          <code>{`dotagents --user init
dotagents --user add getsentry/skills --all
dotagents --user install`}</code>
        </pre>
        <p>
          When no <code>agents.toml</code> exists and you are not inside a git
          repo, dotagents falls back to user scope automatically.
        </p>
      </section>

      <section className="section" id="environment">
        <h2>Environment Variables</h2>
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>DOTAGENTS_STATE_DIR</code>
              </td>
              <td>
                Override cache location (default: <code>~/.local/dotagents</code>
                )
              </td>
            </tr>
            <tr>
              <td>
                <code>DOTAGENTS_HOME</code>
              </td>
              <td>
                Override user-scope location (default: <code>~/.agents</code>)
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
