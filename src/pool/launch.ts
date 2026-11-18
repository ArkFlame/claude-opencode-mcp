import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive, type RunRecord } from "../runs/store.js";
import {
  POOLS_SUBDIR,
  type PoolConfig,
  type PoolState,
  poolDirFor,
  readJson,
  readPoolState,
  stopFileFor,
  unitPaths,
  writeJsonAtomic,
} from "./state.js";

const SUPERVISOR_MARKER = "supervisor-entry";
export const REDELIVER_ONLY_FLAG = "--redeliver-only";

export function isSupervisorAlive(pid: number | null): boolean {
  if (pid === null || !isProcessAlive(pid)) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(SUPERVISOR_MARKER);
  } catch {
    // No /proc (non-Linux): trust the pid check alone.
    return !fs.existsSync("/proc");
  }
}

export interface StartPoolResult {
  pool_id: string;
  pool_dir: string;
  supervisor_pid: number | null;
  /** True when a live supervisor already owns this pool and was left in place. */
  reused: boolean;
}

/**
 * Start (or adopt) the detached supervisor for a pool. A live supervisor is never duplicated:
 * the call returns its pid and leaves the running config untouched.
 */
export function startPool(
  config: PoolConfig,
  options: { redeliverOnly?: boolean } = {},
): StartPoolResult {
  const poolDir = poolDirFor(config.runsDir, config.id);
  const prior = readPoolState(poolDir);
  if (prior?.status === "running" && isSupervisorAlive(prior.supervisor_pid)) {
    return {
      pool_id: config.id,
      pool_dir: poolDir,
      supervisor_pid: prior.supervisor_pid,
      reused: true,
    };
  }
  fs.mkdirSync(poolDir, { recursive: true, mode: 0o700 });
  fs.rmSync(stopFileFor(poolDir), { force: true });
  const configFile = path.join(poolDir, "config.json");
  writeJsonAtomic(configFile, { ...config, poolDir });

  const entry = fileURLToPath(new URL("./supervisor-entry.js", import.meta.url));
  const logFd = fs.openSync(path.join(poolDir, "supervisor.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [entry, configFile, ...(options.redeliverOnly ? [REDELIVER_ONLY_FLAG] : [])],
      {
        cwd: config.cwd,
        env: process.env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.on("error", () => {
      // Reported through pool_status: the supervisor never writes its pid.
    });
    child.unref();
    return {
      pool_id: config.id,
      pool_dir: poolDir,
      supervisor_pid: child.pid ?? null,
      reused: false,
    };
  } finally {
    fs.closeSync(logFd);
  }
}

/** Every pool directory under the runs directory, newest first. */
export function listPoolDirs(runsDir: string): string[] {
  const root = path.join(runsDir, POOLS_SUBDIR);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(path.join(dir, "pool.json")))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** Ask every running pool to stop: the supervisors kill their workers and exit. */
export function requestAllPoolStops(
  runsDir: string,
  include: (state: PoolState) => boolean = () => true,
): number {
  let count = 0;
  for (const dir of listPoolDirs(runsDir)) {
    const state = readPoolState(dir);
    if (state?.status !== "running" || !include(state)) continue;
    fs.writeFileSync(stopFileFor(dir), "stop\n", { mode: 0o600 });
    count += 1;
  }
  return count;
}

/** Mark one unit aborted. The owning supervisor kills its worker and does not relaunch it. */
export function requestUnitAbort(record: RunRecord): boolean {
  if (!record.pool) return false;
  const key = path.basename(record.log_file, ".log");
  const poolDir = path.dirname(record.log_file);
  if (!fs.existsSync(poolDir)) return false;
  fs.writeFileSync(unitPaths(poolDir, key).abort, "abort\n", { mode: 0o600 });
  return true;
}

export function readPoolConfig(poolDir: string): PoolConfig | null {
  return readJson<PoolConfig>(path.join(poolDir, "config.json"));
}
