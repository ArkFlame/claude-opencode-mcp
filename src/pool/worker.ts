import { spawn } from "node:child_process";
import fs from "node:fs";

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  exitFile: string;
}

export interface WorkerHandle {
  pid: number;
  pgid: number;
}

/**
 * The wrapper records the worker's exit code in the exit file so a supervisor restart can read
 * the outcome without a child handle. Arguments travel as argv entries, never through a shell parse.
 */
const WRAPPER =
  'exitfile=$0; "$@"; rc=$?; printf "%s\\n" "$rc" > "$exitfile.tmp" && mv -f "$exitfile.tmp" "$exitfile"; exit "$rc"';

/** Start a worker in its own session (detached => setsid), so it outlives the MCP server. */
export function spawnDetachedWorker(request: SpawnRequest): WorkerHandle {
  const logFd = fs.openSync(request.logFile, "w", 0o600);
  try {
    const child = spawn(
      "/bin/sh",
      ["-c", WRAPPER, request.exitFile, request.command, ...request.args],
      {
        cwd: request.cwd,
        env: request.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.on("error", () => {
      // A failed start leaves no pid; the caller turns that into a failed unit.
    });
    child.unref();
    if (!child.pid) throw new Error("worker process did not start");
    return { pid: child.pid, pgid: child.pid };
  } finally {
    fs.closeSync(logFd);
  }
}
