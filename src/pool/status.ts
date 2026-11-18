import fs from "node:fs";
import path from "node:path";
import { etaFor, isStale } from "./core.js";
import { isSupervisorAlive } from "./launch.js";
import { type PoolState, readPoolState, readUnit, type UnitRecord, unitPaths } from "./state.js";

export interface LaneStatus {
  name: string;
  model: string;
  cap: number;
  effective_cap: number;
  running: number;
  done: number;
  failed: number;
  hits: number;
  avg_seconds: number | null;
  backing_off_until: number | null;
}

export interface PoolStatusView {
  pool_id: string;
  pool_dir: string;
  status: PoolState["status"] | "unknown";
  reason: string | null;
  supervisor_alive: boolean;
  supervisor_pid: number | null;
  counts: { total: number; queued: number; running: number; done: number; failed: number };
  lanes: LaneStatus[];
  stale_workers: Array<{ key: string; lane: string | null; idle_seconds: number }>;
  rate_per_minute: number;
  eta_minutes: number | null;
}

function readUnits(poolDir: string): UnitRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(poolDir);
  } catch {
    return [];
  }
  const units: UnitRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "pool.json" || name === "config.json") continue;
    const unit = readUnit(poolDir, name.slice(0, -".json".length));
    if (unit && typeof unit.key === "string") units.push(unit);
  }
  return units.sort((a, b) => a.key.localeCompare(b.key));
}

function logIdleMs(poolDir: string, key: string, now: number): number | null {
  try {
    return now - fs.statSync(unitPaths(poolDir, key).log).mtimeMs;
  } catch {
    return null;
  }
}

/** Per-lane and pool-wide view computed from the state files only. Read-only. */
export function buildPoolStatus(poolDir: string, now = Date.now()): PoolStatusView {
  const state = readPoolState(poolDir);
  const units = readUnits(poolDir);
  const alive = isSupervisorAlive(state?.supervisor_pid ?? null);
  const counts = { total: units.length, queued: 0, running: 0, done: 0, failed: 0 };
  for (const unit of units) {
    if (unit.state === "queued") counts.queued += 1;
    else if (unit.state === "running" || unit.state === "killing") counts.running += 1;
    else if (unit.state === "done") counts.done += 1;
    else counts.failed += 1;
  }

  const lanes: LaneStatus[] = (state?.lanes ?? []).map((lane) => {
    const mine = units.filter((unit) => unit.lane === lane.name);
    const finished = mine.filter((unit) => unit.state === "done" && unit.started && unit.finished);
    const seconds = finished.map((unit) => ((unit.finished ?? 0) - (unit.started ?? 0)) / 1000);
    const avg =
      seconds.length > 0 ? seconds.reduce((sum, value) => sum + value, 0) / seconds.length : null;
    return {
      name: lane.name,
      model: lane.model,
      cap: lane.cap,
      effective_cap: lane.effective_cap,
      running: mine.filter((unit) => unit.state === "running" || unit.state === "killing").length,
      done: mine.filter((unit) => unit.state === "done").length,
      failed: mine.filter((unit) => unit.state === "failed").length,
      hits: lane.hits,
      avg_seconds: avg === null ? null : Math.round(avg),
      backing_off_until: lane.backoff_until > now ? lane.backoff_until : null,
    };
  });

  const stale: PoolStatusView["stale_workers"] = [];
  for (const unit of units) {
    if (unit.state !== "running") continue;
    const idle = logIdleMs(poolDir, unit.key, now);
    if (idle !== null && isStale(now - idle, now)) {
      stale.push({ key: unit.key, lane: unit.lane, idle_seconds: Math.round(idle / 1000) });
    }
  }

  const finishTimes = units
    .filter((unit) => unit.state === "done" && unit.finished !== null)
    .map((unit) => unit.finished as number);
  const open = counts.queued + counts.running;
  const eta = etaFor(open, finishTimes, now);

  return {
    pool_id: state?.id ?? path.basename(poolDir),
    pool_dir: poolDir,
    status: state?.status ?? "unknown",
    reason: state?.reason ?? null,
    supervisor_alive: alive,
    supervisor_pid: state?.supervisor_pid ?? null,
    counts,
    lanes,
    stale_workers: stale,
    rate_per_minute: Number(eta.perMinute.toFixed(3)),
    eta_minutes: eta.etaMinutes === null ? null : Math.round(eta.etaMinutes),
  };
}
