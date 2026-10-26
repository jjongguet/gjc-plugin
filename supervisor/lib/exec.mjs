// Bounded command execution for the supervisor.
//
// Every collector and intervention goes through one runner so tests can inject
// fixtures and so a missing binary or a timeout is a recorded result instead of
// an exception that kills the loop.
import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * @param {string} command absolute path or PATH-resolved name
 * @param {string[]} args
 * @param {{timeoutMs?: number, env?: Record<string, string>, cwd?: string}} [options]
 * @returns {Promise<{ok: boolean, command: string, args: string[], code: number|null, signal: string|null, stdout: string, stderr: string, error: string|null}>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          command,
          args,
          code: error?.code === undefined ? (error ? null : 0) : typeof error.code === "number" ? error.code : null,
          signal: error?.signal ?? null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error ? (error.code === "ENOENT" ? "command_not_found" : error.killed ? "timeout" : error.message) : null,
        });
      },
    );
  });
}

/** Runner shape used by every collector: `runner(command, args, options)`. */
export const defaultRunner = runCommand;
