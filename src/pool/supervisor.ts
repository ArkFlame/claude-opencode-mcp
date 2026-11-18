import fs from "node:fs";
import path from "node:path";
import { sharedSection } from "../runs/brief.js";
import { buildRunArgs } from "../runs/manager.js";
import { isProcessAlive, killProcessGroup, RunStore } from "../runs/store.js";
import {
  applyLimitHit,
  CONSECUTIVE_LIMIT_STOP,
  canStart,
  hubNames,
  isLimitFailure,
  KILL_GRACE_MS,
  type LaneState,
  MAX_LOST_ATTEMPTS,
  MAX_TIMEOUTS,
  pickLane,
  type RunningUnit,
  renderBrief,
  rsNamesIn,
  unitKeyOf,
} from "./core.js";
import {
  type PoolConfig,
  type PoolState,
  type PoolStatus,
  readExitCode,
  readPoolState,
  readTail,
  readUnit,
  stopFileFor,
  syncRunRecord,
  type UnitRecord,
  unitPaths,
  writePoolState,
  writeUnit,
} from "./state.js";
import { scanUnits, type UnitFile } from "./units.js";
import { type SpawnRequest, spawnDetachedWorker, type WorkerHandle } from "./worker.js";

export const TICK_MS = 2_000;

/** Side effects the supervisor needs. Tests replace them; production uses the real process APIs. */
export interface SupervisorOps {
  now(): number;
  spawn(request: SpawnRequest): WorkerHandle;
  isAlive(pid: number): boolean;
  signal(pgid: number, signal: NodeJS.Signals): void;
}

export const PROCESS_OPS: SupervisorOps = {
  now: () => Date.now(),
  spawn: spawnDetachedWorker,
  isAlive: (pid) => isProcessAlive(pid),
  signal: (pgid, signal) => killProcessGroup(pgid, signal),
};

/**
 * Owns one pool: schedules unit workers onto lanes, watches them through exit files and pids,
 * and writes per-unit state so a restarted supervisor can adopt live workers.
 */
export class PoolSupervisor {
  private readonly units = new Map<string, UnitRecord>();
  private readonly unitNames = new Map<string, Set<string>>();
  private readonly lanes: LaneState[];
  private readonly store: RunStore;
  private hubs = new Set<string>();
  private status: PoolStatus = "running";
  private reason: string | null = null;
  private consecutiveHits = 0;

  constructor(
    private readonly config: PoolConfig,
    private readonly ops: SupervisorOps,
    private readonly supervisorPid: number,
  ) {
    this.store = new RunStore(config.runsDir);
    this.lanes = config.lanes.map((lane) => ({
      name: lane.name,
      model: lane.model,
      cap: lane.cap,
      effectiveCap: lane.cap,
      hits: 0,
      backoffUntil: 0,
    }));
  }

  /** Load units, restore lane penalties from an earlier supervisor, and adopt live workers. */
  load(units: UnitFile[]): void {
    const now = this.ops.now();
    const prior: PoolState | null = readPoolState(this.config.poolDir);
    if (prior) {
      this.consecutiveHits = prior.consecutive_hits;
      for (const lane of this.lanes) {
        const saved = prior.lanes.find((entry) => entry.name === lane.name);
        if (!saved) continue;
        lane.effectiveCap = Math.min(lane.cap, saved.effective_cap);
        lane.hits = saved.hits;
        lane.backoffUntil = saved.backoff_until;
      }
    }

    const open: UnitFile[] = [];
    for (const unit of units) {
      if (!unit.text.includes(this.config.marker)) continue;
      const key = unitKeyOf(unit.file);
      if (this.units.has(key)) {
        throw new Error(`two unit files map to the same key: ${key}`);
      }
      open.push(unit);
      this.unitNames.set(key, rsNamesIn(unit.text));
      this.units.set(key, this.restore(key, unit.file, now));
    }
    this.hubs = hubNames(
      open
        .filter((unit) => this.units.get(unitKeyOf(unit.file))?.state !== "done")
        .map((unit) => this.unitNames.get(unitKeyOf(unit.file)) ?? new Set<string>()),
    );
    for (const unit of this.units.values()) this.save(unit);
    this.persist();
  }

  private restore(key: string, file: string, now: number): UnitRecord {
    const paths = unitPaths(this.config.poolDir, key);
    const names = [...(this.unitNames.get(key) ?? [])];
    const exitCode = readExitCode(paths.exit);
    const prior = readUnit(this.config.poolDir, key);
    const base: UnitRecord = prior ?? {
      key,
      file,
      names,
      lane: null,
      state: "queued",
      attempts: 0,
      timeouts: 0,
      limitHits: 0,
      pid: null,
      pgid: null,
      started: null,
      finished: null,
      killedAt: null,
      exitCode: null,
      error: null,
    };
    const next: UnitRecord = { ...base, file, names };
    if (exitCode === 0) {
      return { ...next, state: "done", exitCode: 0, pid: null, pgid: null, error: null };
    }
    if (
      (next.state === "running" || next.state === "killing") &&
      next.pid !== null &&
      this.ops.isAlive(next.pid)
    ) {
      return { ...next, exitCode: null };
    }
    // Failed, lost or interrupted units are queued again; a re-run is an explicit retry.
    return {
      ...next,
      state: "queued",
      lane: null,
      pid: null,
      pgid: null,
      killedAt: null,
      timeouts: next.state === "failed" ? 0 : next.timeouts,
      exitCode: null,
      error: null,
    };
  }

  /** One scheduling pass. Returns false once the pool has nothing left to do. */
  tick(): boolean {
    const now = this.ops.now();
    if (this.status === "running" && fs.existsSync(stopFileFor(this.config.poolDir))) {
      this.stop("stopped", "stop requested", now);
      return false;
    }
    for (const unit of [...this.units.values()]) this.monitor(unit, now);
    if (this.status !== "running") return false;
    this.schedule(now);
    if (this.status !== "running") return false;
    const open = [...this.units.values()].filter(
      (unit) => unit.state === "queued" || unit.state === "running" || unit.state === "killing",
    );
    this.persist();
    if (open.length === 0) {
      this.status = "done";
      this.persist();
      return false;
    }
    return true;
  }

  poolStatus(): PoolStatus {
    return this.status;
  }

  unit(key: string): UnitRecord | undefined {
    return this.units.get(key);
  }

  private monitor(unit: UnitRecord, now: number): void {
    const paths = unitPaths(this.config.poolDir, unit.key);
    if (unit.state === "killing") {
      const alive = unit.pid !== null && this.ops.isAlive(unit.pid);
      if (!alive) {
        this.afterKill(unit);
      } else if (
        unit.pgid !== null &&
        unit.killedAt !== null &&
        now - unit.killedAt > KILL_GRACE_MS
      ) {
        this.ops.signal(unit.pgid, "SIGKILL");
      }
      return;
    }
    if (unit.state !== "running") return;
    if (fs.existsSync(paths.abort)) {
      unit.error = "aborted";
      this.beginKill(unit, now);
      return;
    }
    const exitCode = readExitCode(paths.exit);
    if (exitCode !== null) {
      this.finish(unit, exitCode, now);
      return;
    }
    if (unit.pid === null || !this.ops.isAlive(unit.pid)) {
      this.finish(unit, null, now);
      return;
    }
    if (unit.started !== null && now - unit.started > this.config.timeoutMs) {
      unit.timeouts += 1;
      unit.error = "hard timeout";
      this.beginKill(unit, now);
    }
  }

  private beginKill(unit: UnitRecord, now: number): void {
    unit.state = "killing";
    unit.killedAt = now;
    if (unit.pgid !== null) this.ops.signal(unit.pgid, "SIGTERM");
    this.save(unit);
  }

  private afterKill(unit: UnitRecord): void {
    unit.pid = null;
    unit.pgid = null;
    unit.lane = null;
    unit.killedAt = null;
    fs.rmSync(unitPaths(this.config.poolDir, unit.key).abort, { force: true });
    if (unit.error === "aborted") {
      unit.state = "failed";
      unit.finished = this.ops.now();
    } else if (unit.timeouts >= MAX_TIMEOUTS) {
      unit.state = "failed";
      unit.finished = this.ops.now();
    } else {
      unit.state = "queued";
    }
    this.save(unit);
  }

  private finish(unit: UnitRecord, exitCode: number | null, now: number): void {
    const paths = unitPaths(this.config.poolDir, unit.key);
    const tail = readTail(paths.log);
    unit.pid = null;
    unit.pgid = null;
    if (isLimitFailure(exitCode, tail)) {
      this.limitHit(unit, now);
      return;
    }
    unit.exitCode = exitCode;
    if (exitCode === 0) {
      unit.state = "done";
      unit.finished = now;
      unit.error = null;
      this.consecutiveHits = 0;
    } else if (exitCode === null && unit.attempts < MAX_LOST_ATTEMPTS) {
      unit.state = "queued";
      unit.lane = null;
      unit.error = "worker lost; requeued";
    } else {
      unit.state = "failed";
      unit.finished = now;
      unit.error = exitCode === null ? "worker lost" : `exit ${exitCode}`;
    }
    this.save(unit);
  }

  private limitHit(unit: UnitRecord, now: number): void {
    const lane = this.lanes.find((entry) => entry.name === unit.lane);
    if (lane) applyLimitHit(lane, now);
    fs.rmSync(unitPaths(this.config.poolDir, unit.key).exit, { force: true });
    unit.limitHits += 1;
    unit.state = "queued";
    unit.lane = null;
    unit.error = "provider limit; requeued";
    this.consecutiveHits += 1;
    this.save(unit);
    if (this.consecutiveHits >= CONSECUTIVE_LIMIT_STOP) {
      this.stop("limit-stopped", `${CONSECUTIVE_LIMIT_STOP} consecutive provider limit hits`, now);
    }
  }

  private schedule(now: number): void {
    if (this.lanes.every((lane) => lane.effectiveCap === 0)) {
      if (this.running().length === 0) {
        this.stop("limit-stopped", "every lane is capped at 0 by provider limits", now);
      }
      return;
    }
    const queued = [...this.units.values()]
      .filter((unit) => unit.state === "queued")
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const unit of queued) {
      const busy = this.busyByLane();
      const lane = pickLane(this.lanes, busy, now);
      if (!lane) return;
      if (fs.existsSync(unitPaths(this.config.poolDir, unit.key).abort)) {
        unit.error = "aborted";
        unit.state = "failed";
        unit.finished = now;
        fs.rmSync(unitPaths(this.config.poolDir, unit.key).abort, { force: true });
        this.save(unit);
        continue;
      }
      if (!canStart(new Set(unit.names), this.runningUnits(), this.hubs, this.config.perFileCap)) {
        continue;
      }
      this.launch(unit, lane, now);
    }
  }

  private launch(unit: UnitRecord, lane: LaneState, now: number): void {
    const paths = unitPaths(this.config.poolDir, unit.key);
    try {
      const brief = renderBrief(this.config.briefTemplate, {
        path: unit.file,
        name: path.basename(unit.file),
        key: unit.key,
      });
      const prompt = `${brief.trim()}\n\n${sharedSection(this.config.forbid)}\n`;
      fs.writeFileSync(paths.prompt, prompt, { mode: 0o600 });
      fs.rmSync(paths.exit, { force: true });
      const handle = this.ops.spawn({
        command: this.config.binary,
        args: buildRunArgs({
          model: lane.model,
          agent: null,
          title: `pool ${unit.key}`,
          promptFile: paths.prompt,
        }),
        cwd: this.config.cwd,
        env: { ...process.env },
        logFile: paths.log,
        exitFile: paths.exit,
      });
      unit.state = "running";
      unit.lane = lane.name;
      unit.pid = handle.pid;
      unit.pgid = handle.pgid;
      unit.started = now;
      unit.attempts += 1;
      unit.killedAt = null;
      unit.error = null;
      unit.finished = null;
    } catch (error) {
      unit.state = "failed";
      unit.finished = now;
      unit.error = error instanceof Error ? error.message : String(error);
    }
    this.save(unit);
  }

  private stop(status: "stopped" | "limit-stopped", reason: string, now: number): void {
    this.status = status;
    this.reason = reason;
    for (const unit of this.running()) {
      if (unit.pgid !== null) this.ops.signal(unit.pgid, "SIGTERM");
      unit.pid = null;
      unit.pgid = null;
      unit.lane = null;
      unit.killedAt = null;
      if (status === "stopped") {
        unit.state = "failed";
        unit.error = "aborted";
        unit.finished = now;
      } else {
        unit.state = "queued";
        unit.error = "pool stopped; requeued";
      }
      this.save(unit);
    }
    this.persist();
  }

  private running(): UnitRecord[] {
    return [...this.units.values()].filter(
      (unit) => unit.state === "running" || unit.state === "killing",
    );
  }

  private runningUnits(): RunningUnit[] {
    return this.running().map((unit) => ({ key: unit.key, names: new Set(unit.names) }));
  }

  private busyByLane(): Map<string, number> {
    const busy = new Map<string, number>();
    for (const unit of this.running()) {
      if (unit.lane) busy.set(unit.lane, (busy.get(unit.lane) ?? 0) + 1);
    }
    return busy;
  }

  private save(unit: UnitRecord): void {
    const now = this.ops.now();
    writeUnit(this.config.poolDir, unit);
    try {
      syncRunRecord(this.store, this.config.id, this.config, unit, this.supervisorPid, now);
    } catch {
      // The unit file is authoritative; a failed mirror only hides the run from list_runs.
    }
  }

  private persist(): void {
    writePoolState(this.config.poolDir, {
      id: this.config.id,
      status: this.status,
      reason: this.reason,
      supervisor_pid: this.supervisorPid,
      updated: this.ops.now(),
      consecutive_hits: this.consecutiveHits,
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        model: lane.model,
        cap: lane.cap,
        effective_cap: lane.effectiveCap,
        hits: lane.hits,
        backoff_until: lane.backoffUntil,
      })),
    });
  }
}

/** Entry used by the detached supervisor process: load config, scan units, tick until done. */
export async function runSupervisor(
  configPath: string,
  ops: SupervisorOps = PROCESS_OPS,
): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as PoolConfig;
  const supervisor = new PoolSupervisor(config, ops, process.pid);
  supervisor.load(scanUnits(config.unitsGlob));
  while (supervisor.tick()) {
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}
