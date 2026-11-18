import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunRecord, RunStatus, RunStore } from "../runs/store.js";

export interface LaneConfig {
  name: string;
  model: string;
  cap: number;
}

export interface PoolConfig {
  id: string;
  unitsGlob: string;
  marker: string;
  cwd: string;
  binary: string;
  lanes: LaneConfig[];
  perFileCap: number;
  timeoutMs: number;
  forbid: string[];
  briefTemplate: string;
  runsDir: string;
  poolDir: string;
  createdAt: number;
}

export type UnitState = "queued" | "running" | "killing" | "done" | "failed";

export interface UnitRecord {
  key: string;
  file: string;
  names: string[];
  lane: string | null;
  state: UnitState;
  attempts: number;
  timeouts: number;
  limitHits: number;
  pid: number | null;
  pgid: number | null;
  started: number | null;
  finished: number | null;
  killedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export type PoolStatus = "running" | "done" | "stopped" | "limit-stopped";

export interface PoolState {
  id: string;
  status: PoolStatus;
  reason: string | null;
  supervisor_pid: number | null;
  updated: number;
  consecutive_hits: number;
  lanes: Array<{
    name: string;
    model: string;
    cap: number;
    effective_cap: number;
    hits: number;
    backoff_until: number;
  }>;
}

export const POOLS_SUBDIR = "pools";

export function poolIdFor(cwd: string, unitsGlob: string): string {
  return createHash("sha1").update(`${cwd}\0${unitsGlob}`).digest("hex").slice(0, 10);
}

export function poolDirFor(runsDir: string, id: string): string {
  return path.join(runsDir, POOLS_SUBDIR, id);
}

export function unitRecordId(poolId: string, key: string): string {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 10);
  return `pl${poolId}-${hash}`;
}

export interface UnitPaths {
  state: string;
  log: string;
  exit: string;
  prompt: string;
  abort: string;
}

export function unitPaths(poolDir: string, key: string): UnitPaths {
  const base = path.join(poolDir, key);
  return {
    state: `${base}.json`,
    log: `${base}.log`,
    exit: `${base}.exit`,
    prompt: `${base}.prompt.md`,
    abort: `${base}.abort`,
  };
}

export function stopFileFor(poolDir: string): string {
  return path.join(poolDir, "stop");
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readExitCode(file: string): number | null {
  const text = readText(file);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isInteger(value) ? value : null;
}

/** Last `bytes` of a log file, or "" when missing. */
export function readTail(file: string, bytes = 16 * 1024): string {
  try {
    const { size } = fs.statSync(file);
    const length = Math.min(size, bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function readUnit(poolDir: string, key: string): UnitRecord | null {
  return readJson<UnitRecord>(unitPaths(poolDir, key).state);
}

export function writeUnit(poolDir: string, unit: UnitRecord): void {
  writeJsonAtomic(unitPaths(poolDir, unit.key).state, unit);
}

export function writePoolState(poolDir: string, state: PoolState): void {
  writeJsonAtomic(path.join(poolDir, "pool.json"), state);
}

export function readPoolState(poolDir: string): PoolState | null {
  return readJson<PoolState>(path.join(poolDir, "pool.json"));
}

const RECORD_STATUS: Record<UnitState, RunStatus> = {
  queued: "queued",
  running: "running",
  killing: "running",
  done: "done",
  failed: "failed",
};

/** Mirror a unit into the shared run store so list_runs and abort_all see pool workers. */
export function syncRunRecord(
  store: RunStore,
  poolId: string,
  config: Pick<PoolConfig, "cwd" | "poolDir" | "lanes" | "createdAt">,
  unit: UnitRecord,
  supervisorPid: number,
  now: number,
): void {
  const paths = unitPaths(config.poolDir, unit.key);
  const lane = config.lanes.find((entry) => entry.name === unit.lane) ?? config.lanes[0];
  const status = unit.error === "aborted" ? "aborted" : RECORD_STATUS[unit.state];
  const record: RunRecord = {
    id: unitRecordId(poolId, unit.key),
    name: `pool:${unit.key}`.slice(0, 61),
    status,
    cwd: config.cwd,
    branch: null,
    agent: null,
    model: lane?.model ?? "",
    model_note: null,
    allow_shared_cwd: true,
    attempts: unit.attempts,
    owner_pid: supervisorPid,
    pid: unit.state === "running" || unit.state === "killing" ? unit.pid : null,
    pgid: unit.state === "running" || unit.state === "killing" ? unit.pgid : null,
    created: config.createdAt,
    started: unit.started,
    finished: unit.finished,
    last_activity: now,
    exit_code: unit.exitCode,
    signal: null,
    final_text: null,
    final_truncated: false,
    last_line: null,
    error: unit.error,
    prompt_file: paths.prompt,
    log_file: paths.log,
    pool: poolId,
  };
  store.save(record);
}
