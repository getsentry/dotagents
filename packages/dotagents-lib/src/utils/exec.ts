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

export function exec(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      // Prevent git from prompting for credentials
      GIT_TERMINAL_PROMPT: "0",
      // Prevent git from asking for SSH key passphrases
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      ...opts?.env,
    };

    execFile(cmd, args, { cwd: opts?.cwd, env, maxBuffer: 50 * 1024 * 1024, timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const code = "code" in err ? (err.code as number | null) : null;
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
