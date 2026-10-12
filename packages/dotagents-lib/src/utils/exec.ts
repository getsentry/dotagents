import { execFile } from "node:child_process";

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command and return stdout/stderr.
 * Non-interactive: sets GIT_TERMINAL_PROMPT=0 for git commands.
 */
const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Repository-local variables (`git rev-parse --local-env-vars`) and GIT_REFLOG_ACTION.
 * Inherited from a hook, they point git at the caller's repository instead of `cwd`.
 * GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT stay, as in git's own sanitize_repo_env.
 */
const GIT_REPO_LOCAL_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
  "GIT_REFLOG_ACTION",
]);

export function exec(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !GIT_REPO_LOCAL_ENV.has(name)),
      ),
      // Prevent git from prompting for credentials
      GIT_TERMINAL_PROMPT: "0",
      // Prevent git from asking for SSH key passphrases
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      ...opts?.env,
    };

    execFile(cmd, args, { cwd: opts?.cwd, env, maxBuffer: 50 * 1024 * 1024, timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const code = "code" in err && isNumber(err.code) ? err.code : null;
        reject(
          new ExecError(
            `${cmd} ${args.join(" ")} failed: ${stderr.trim() || err.message}`,
            code,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isNumber<Value>(value: Value): value is Value & number {
  return typeof value === "number";
}
