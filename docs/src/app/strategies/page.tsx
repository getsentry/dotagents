import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Update Strategies - dotagents",
  description: "Controlled vs. always-latest skill update strategies",
};

export default function StrategiesPage() {
  return (
    <>
      <section className="section" id="overview" style={{ borderTop: "none" }}>
        <h2>Two Ways to Manage Skills</h2>
        <p>
          How skills get updated depends on your team and how much control you
          need. dotagents supports two strategies: <strong>controlled</strong>{" "}
          for teams that want explicit version management, and{" "}
          <strong>always-latest</strong> for teams that want skills to stay
          current automatically.
        </p>
        <p>
          Pick one per project. Both work. The tradeoff is predictability vs.
          convenience.
        </p>
      </section>

      <section className="section" id="controlled">
        <h2>Controlled (Default)</h2>
        <p>
          The lockfile pins every skill to an exact git commit and integrity
          hash. Skills only change when someone explicitly runs{" "}
          <code>dotagents update</code> and commits the result.
        </p>

        <h3>How It Works</h3>
        <ol>
          <li>
            <code>dotagents install</code> resolves skills and writes{" "}
            <code>agents.lock</code> with pinned commits
          </li>
          <li>
            Commit <code>agents.lock</code> to git
          </li>
          <li>
            Teammates run <code>dotagents install</code> and get the exact same
            versions
          </li>
          <li>
            Update when ready with <code>dotagents update</code>, review the
            diff, commit
          </li>
        </ol>

        <h3>Config</h3>
        <pre>
          <code>{`version = 1
gitignore = true

[[skills]]
name = "*"
source = "myorg/skills"`}</code>
        </pre>
        <p>
          This is the default. <code>pin</code> defaults to <code>true</code>,
          so you don&apos;t need to set it.
        </p>

        <h3>CI</h3>
        <p>
          Use <code>--frozen</code> to guarantee CI runs the same skill versions
          as development:
        </p>
        <pre>
          <code>dotagents install --frozen</code>
        </pre>
        <p>
          Frozen mode fails if the lockfile is missing, stale, or if integrity
          hashes don&apos;t match. See the{" "}
          <a href="/security#frozen">Security page</a> for details.
        </p>

        <h3>Good For</h3>
        <ul>
          <li>Teams where skill changes should go through code review</li>
          <li>Projects that need reproducible builds</li>
          <li>Environments where CI must match local exactly</li>
        </ul>
      </section>

      <section className="section" id="always-latest">
        <h2>Always Latest</h2>
        <p>
          Skills fetch the latest version on every install. No lockfile churn, no
          update commands. When upstream publishes a new skill or changes an
          existing one, the next install picks it up.
        </p>
        <p>
          This is convenient but less predictable. A breaking change upstream
          will affect your project immediately.
        </p>

        <h3>Setup</h3>

        <p>
          <strong>1. Set <code>pin = false</code></strong>
        </p>
        <pre>
          <code>{`version = 1
gitignore = true
pin = false

[[skills]]
name = "*"
source = "myorg/skills"`}</code>
        </pre>
        <p>
          With <code>pin = false</code>, the lockfile tracks which skills are
          installed but omits commit SHAs and integrity hashes. Every{" "}
          <code>dotagents install</code> resolves the latest version.
        </p>

        <p>
          <strong>
            2. Gitignore generated files
          </strong>
        </p>
        <p>
          Two files change whenever the upstream skill set changes:{" "}
          <code>agents.lock</code> (tracks which skills are installed) and{" "}
          <code>.agents/.gitignore</code> (lists managed skill directories).
          To avoid committing those changes, add both to your{" "}
          <code>.gitignore</code>:
        </p>
        <pre>
          <code>{`# .gitignore
agents.lock
.agents/.gitignore`}</code>
        </pre>
        <p>
          Both files are still written locally{" "}
          &mdash; dotagents uses the lockfile to detect and prune stale skills,
          and the gitignore to exclude managed skill directories. They just
          won&apos;t show up in git.
        </p>

        <p>
          <strong>3. Auto-install after pulls</strong>
        </p>
        <p>
          Since the lockfile isn&apos;t committed, teammates need to run{" "}
          <code>dotagents install</code> to get skills. Automate this with a git
          hook, a Makefile target, or whatever fits your workflow.
        </p>
        <p>
          A git <code>post-merge</code> hook runs after every{" "}
          <code>git pull</code>:
        </p>
        <pre>
          <code>{`#!/bin/sh
# .git/hooks/post-merge
npx @sentry/dotagents install || echo "dotagents install failed — run it manually"`}</code>
        </pre>
        <p>
          Make it executable: <code>chmod +x .git/hooks/post-merge</code>
        </p>
        <p>
          Git hooks aren&apos;t shared via git, so each developer needs to set
          this up once. Tools like{" "}
          <a href="https://github.com/evilmartians/lefthook">lefthook</a> or{" "}
          <a href="https://typicode.github.io/husky/">husky</a> can automate
          that.
        </p>

        <h3>Good For</h3>
        <ul>
          <li>Teams that publish skills frequently and want fast rollout</li>
          <li>Projects where skill authors and consumers are the same people</li>
          <li>Solo developers who want zero maintenance</li>
        </ul>
      </section>

      <section className="section" id="comparison">
        <h2>Comparison</h2>
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Controlled</th>
              <th>Always Latest</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>pin</code>
              </td>
              <td>
                <code>true</code> (default)
              </td>
              <td>
                <code>false</code>
              </td>
            </tr>
            <tr>
              <td>Lockfile</td>
              <td>Committed</td>
              <td>Gitignored</td>
            </tr>
            <tr>
              <td>Update trigger</td>
              <td>
                <code>dotagents update</code>
              </td>
              <td>
                <code>dotagents install</code>
              </td>
            </tr>
            <tr>
              <td>CI reproducibility</td>
              <td>
                <code>--frozen</code>
              </td>
              <td>Not guaranteed</td>
            </tr>
            <tr>
              <td>Upstream breakage</td>
              <td>Only after explicit update</td>
              <td>Immediate on next install</td>
            </tr>
            <tr>
              <td>Git churn</td>
              <td>
                On <code>dotagents update</code>
              </td>
              <td>None</td>
            </tr>
          </tbody>
        </table>
      </section>
    </>
  );
}
