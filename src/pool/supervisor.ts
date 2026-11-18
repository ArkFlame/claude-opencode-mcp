import fs from "node:fs";
import path from "node:path";
import {
  inboxFileFor,
  mutateMessage,
  nextDeliverable,
  type QueuedMessage,
  queuedOrder,
  readInbox,
  refundAttempt,
  settleAttempt,
  startAttempt,
  writeInbox,
} from "../queue/inbox.js";
import { buildResumeArgs, findSessionIdByTitle, unitSessionTitles } from "../queue/resume.js";
import { sharedSection } from "../runs/brief.js";
import { classifySqlite, extractErrorLine } from "../runs/errors.js";
import { buildRunArgs } from "../runs/manager.js";
import { isProcessAlive, killProcessGroup, RunStore } from "../runs/store.js";
import { findLowDisk, freeMbAt, type LowDisk, minFreeMb, opencodeDataDir } from "../util/disk.js";
import {
  applyLimitHit,
  CONSECUTIVE_LIMIT_STOP,
  canStart,
  DEFAULT_MAX_RETRIES,
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
  SQLITE_BACKOFF_MS,
  SQLITE_CONSECUTIVE_STOP,
  SQLITE_RESTORE_AFTER,
  UNIT_SCAN_MS,
  unitKeyOf,
} from "./core.js";
import {
  type PoolConfig,
  type PoolState,
  type PoolStatus,
  readControl,
  readExitCode,
  readPoolState,
  readTail,
  readUnit,
  stopFileFor,
  syncRunRecord,
  type UnitRecord,
  unitPaths,
  unitRecordId,
  writeControl,
  writePoolState,
  writeUnit,
} from "./state.js";
import { listUnitFiles, readUnitFile, scanUnits, type UnitFile } from "./units.js";
import { type SpawnRequest, spawnDetachedWorker, type WorkerHandle } from "./worker.js";

export const TICK_MS = 2_000;
/** Error recorded on a unit whose running attempt is interrupted by a "now" message. */
export const REDELIVER_NOW = "redeliver now";

/** Side effects the supervisor needs. Tests replace them; production uses the real process APIs. */
export interface SupervisorOps {
  now(): number;
  spawn(request: SpawnRequest): WorkerHandle;
  isAlive(pid: number): boolean;
  signal(pgid: number, signal: NodeJS.Signals): void;
  /** Free megabytes at a path; absent means no disk preflight (tests). */
  freeMb?(target: string): number | null;
  /** OpenCode session of a unit's latest run; needed to resume it with a queued message. */
  sessionOf?(key: string): string | null;
}

export const PROCESS_OPS: SupervisorOps = {
  now: () => Date.now(),
  spawn: spawnDetachedWorker,
  isAlive: (pid) => isProcessAlive(pid),
  signal: (pgid, signal) => killProcessGroup(pgid, signal),
  freeMb: freeMbAt,
  sessionOf: (key) => findSessionIdByTitle(unitSessionTitles(key)),
};

export interface SupervisorOptions {
  /**
   * Started only to deliver queued messages: units without a queued message keep their state
   * and are never launched, so a restart cannot rerun a stopped pool.
   */
  redeliverOnly?: boolean;
}

/**
 * Owns one pool: schedules unit workers onto lanes, watches them through exit files and pids,
 * and writes per-unit state so a restarted supervisor can adopt live workers. It also delivers
 * queued messages: a message wakes its unit, and a "now" message interrupts a running one.
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
  private consecutiveSqlite = 0;
  private sqliteSuccesses = 0;
  private pausedReason: string | null = null;
  private lastScan = Number.NEGATIVE_INFINITY;
  /** Unit files seen without an open marker, with the mtime they had when checked. */
  private readonly closedAt = new Map<string, number>();

  constructor(
    private readonly config: PoolConfig,
    private readonly ops: SupervisorOps,
    private readonly supervisorPid: number,
    private readonly options: SupervisorOptions = {},
  ) {
    this.store = new RunStore(config.runsDir);
    this.lanes = config.lanes.map((lane) => ({
      name: lane.name,
      model: lane.model,
      cap: lane.cap,
      effectiveCap: lane.cap,
      hits: 0,
      backoffUntil: 0,
      sqliteShrink: 0,
    }));
  }

  /** Load units, restore lane penalties from an earlier supervisor, and adopt live workers. */
  load(units: UnitFile[]): void {
    const now = this.ops.now();
    const prior: PoolState | null = readPoolState(this.config.poolDir);
    if (prior) {
      this.consecutiveHits = prior.consecutive_hits;
      this.consecutiveSqlite = prior.consecutive_sqlite ?? 0;
      this.sqliteSuccesses = prior.sqlite_successes ?? 0;
      for (const lane of this.lanes) {
        const saved = prior.lanes.find((entry) => entry.name === lane.name);
        if (!saved) continue;
        lane.effectiveCap = Math.min(lane.cap, saved.effective_cap);
        lane.hits = saved.hits;
        lane.backoffUntil = saved.backoff_until;
        lane.sqliteShrink = saved.sqlite_shrink ?? 0;
      }
    }
    for (const unit of units) {
      if (!unit.text.includes(this.config.marker)) continue;
      const key = unitKeyOf(unit.file);
      if (this.units.has(key)) {
        throw new Error(`two unit files map to the same key: ${key}`);
      }
      this.unitNames.set(key, rsNamesIn(unit.text));
      this.units.set(key, this.restore(key, unit.file, now));
    }
    this.recomputeHubs();
    for (const unit of this.units.values()) this.save(unit);
    this.persist();
  }

  /** Hub names come from the open (not done) units, so they follow units added later. */
  private recomputeHubs(): void {
    this.hubs = hubNames(
      [...this.units.values()]
        .filter((unit) => unit.state !== "done")
        .map((unit) => this.unitNames.get(unit.key) ?? new Set<string>()),
    );
  }

  /**
   * Pick up unit files that appeared since the last scan, explicit add_units, and retry requests.
   * The directory is rescanned at most every UNIT_SCAN_MS; the control file is read every tick.
   * A unit that already has exit 0 is never added again.
   */
  private refresh(now: number): void {
    const control = readControl(this.config.poolDir);
    if (control.retry_failed) {
      this.retryFailed();
      writeControl(this.config.poolDir, { ...control, retry_failed: false });
    }
    // A message-only restart never adopts new units.
    if (this.options.redeliverOnly || now - this.lastScan < UNIT_SCAN_MS) return;
    this.lastScan = now;
    let added = false;
    for (const unit of this.discover(control.add_units)) {
      this.addUnit(unit, now);
      added = true;
    }
    if (added) this.persist();
  }

  /** Open unit files that are not yet tracked, from the glob and the explicit list. */
  private discover(explicit: string[]): UnitFile[] {
    const found: UnitFile[] = [];
    const candidates = [
      ...listUnitFiles(this.config.unitsGlob),
      ...explicit.map((file) => ({ file, mtimeMs: this.mtimeOf(file) })),
    ];
    for (const { file, mtimeMs } of candidates) {
      if (this.units.has(unitKeyOf(file))) continue;
      if (this.closedAt.get(file) === mtimeMs) continue;
      const unit = readUnitFile(file);
      if (!unit || !unit.text.includes(this.config.marker)) {
        this.closedAt.set(file, mtimeMs);
        continue;
      }
      found.push(unit);
    }
    return found;
  }

  private mtimeOf(file: string): number {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return Number.NaN;
    }
  }

  private addUnit(unit: UnitFile, now: number): void {
    const key = unitKeyOf(unit.file);
    this.unitNames.set(key, rsNamesIn(unit.text));
    const record = this.restore(key, unit.file, now);
    this.units.set(key, record);
    this.recomputeHubs();
    this.save(record);
  }

  /** Requeue every failed unit except those the caller aborted. Exit-0 units are untouched. */
  private retryFailed(): void {
    let requeued = false;
    for (const unit of this.units.values()) {
      if (unit.state !== "failed" || unit.error === "aborted") continue;
      fs.rmSync(unitPaths(this.config.poolDir, unit.key).exit, { force: true });
      unit.state = "queued";
      unit.lane = null;
      unit.pid = null;
      unit.pgid = null;
      unit.exitCode = null;
      unit.error = null;
      unit.errorKind = null;
      unit.errorRaw = null;
      unit.finished = null;
      unit.timeouts = 0;
      unit.sqliteRetries = 0;
      unit.notBefore = null;
      this.save(unit);
      requeued = true;
    }
    // A pool that already reached done must run again to pick the requeued units up.
    if (requeued && this.status === "done") this.status = "running";
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
      message: null,
    };
    const next: UnitRecord = { ...base, file, names, message: base.message ?? null };
    if (exitCode === 0) {
      this.settleMessage(key, next.message ?? null, true, null, now);
      return {
        ...next,
        state: "done",
        exitCode: 0,
        pid: null,
        pgid: null,
        error: null,
        message: null,
      };
    }
    if (
      (next.state === "running" || next.state === "killing") &&
      next.pid !== null &&
      this.ops.isAlive(next.pid)
    ) {
      return { ...next, exitCode: null };
    }
    if (this.options.redeliverOnly && this.pendingFor(key, now) === null) {
      // Not part of a message restart: keep the recorded outcome untouched.
      this.settleMessage(key, next.message ?? null, false, "worker lost before delivery", now);
      return { ...next, message: null };
    }
    this.settleMessage(key, next.message ?? null, false, "worker lost before delivery", now);
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
      message: null,
    };
  }

  /** One scheduling pass. Returns false once the pool has nothing left to do. */
  tick(): boolean {
    const now = this.ops.now();
    if (this.status === "running" && fs.existsSync(stopFileFor(this.config.poolDir))) {
      this.stop("stopped", "stop requested", now);
      return false;
    }
    this.refresh(now);
    this.syncMessages(now);
    for (const unit of [...this.units.values()]) this.monitor(unit, now);
    if (this.status !== "running") return false;
    this.schedule(now);
    if (this.status !== "running") return false;
    const open = [...this.units.values()].filter((unit) => this.isOpen(unit, now));
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

  /** A unit keeps the loop alive while it runs, while it is queued, or while a message is due for it. */
  private isOpen(unit: UnitRecord, now: number): boolean {
    if (unit.state === "running" || unit.state === "killing") return true;
    if (this.pendingFor(unit.key, now) !== null) return true;
    return unit.state === "queued" && !this.options.redeliverOnly;
  }

  private inboxOf(key: string): string {
    return inboxFileFor(this.config.runsDir, unitRecordId(this.config.id, key));
  }

  private pendingFor(key: string, now: number): QueuedMessage | null {
    return nextDeliverable(readInbox(this.inboxOf(key)), now);
  }

  private sessionOf(key: string): string | null {
    return this.ops.sessionOf?.(key) ?? null;
  }

  /** Update a unit's in-flight message once its attempt has ended. */
  private settleMessage(
    key: string,
    id: string | null,
    delivered: boolean,
    error: string | null,
    now: number,
    refund = false,
  ): void {
    if (!id) return;
    mutateMessage(this.inboxOf(key), id, (message) =>
      refund ? refundAttempt(message) : settleAttempt(message, delivered, error, now),
    );
  }

  /**
   * Messages drive units back into the queue: a finished or failed unit with a queued message is
   * woken for a resume, and a "now" message interrupts a running unit. A unit whose OpenCode
   * session is unknown cannot be resumed, so its messages fail instead of rerunning the brief.
   */
  private syncMessages(now: number): void {
    for (const unit of this.units.values()) {
      const file = this.inboxOf(unit.key);
      const messages = readInbox(file);
      if (queuedOrder(messages).length === 0) continue;
      const next = nextDeliverable(messages, now);
      if (unit.state === "running") {
        if (next?.mode === "now" && unit.error !== REDELIVER_NOW) {
          unit.error = REDELIVER_NOW;
          this.beginKill(unit, now);
        }
        continue;
      }
      if (unit.state === "failed" && unit.error === "aborted" && next?.mode !== "now") {
        this.cancelQueued(file, "run was aborted");
        continue;
      }
      if (unit.state !== "done" && unit.state !== "failed") continue;
      if (unit.attempts > 0 && this.sessionOf(unit.key) === null) {
        this.failQueued(file, "opencode session not found for this unit");
        continue;
      }
      unit.state = "queued";
      unit.lane = null;
      unit.pid = null;
      unit.pgid = null;
      unit.killedAt = null;
      unit.error = null;
      unit.exitCode = null;
      unit.finished = null;
      unit.timeouts = 0;
      unit.message = null;
      fs.rmSync(unitPaths(this.config.poolDir, unit.key).exit, { force: true });
      this.save(unit);
    }
  }

  private cancelQueued(file: string, reason: string): void {
    this.changeQueued(file, (message) => ({ ...message, status: "cancelled", last_error: reason }));
  }

  private failQueued(file: string, reason: string): void {
    this.changeQueued(file, (message) => ({ ...message, status: "failed", last_error: reason }));
  }

  private changeQueued(file: string, change: (message: QueuedMessage) => QueuedMessage): void {
    const all = readInbox(file);
    let touched = false;
    const next = all.map((message) => {
      if (message.status !== "queued" || message.in_flight) return message;
      touched = true;
      return change(message);
    });
    if (touched) writeInbox(file, next);
  }

  private monitor(unit: UnitRecord, now: number): void {
    const paths = unitPaths(this.config.poolDir, unit.key);
    if (unit.state === "killing") {
      const alive = unit.pid !== null && this.ops.isAlive(unit.pid);
      if (!alive) {
        this.afterKill(unit, now);
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

  private afterKill(unit: UnitRecord, now: number): void {
    const message = unit.message ?? null;
    unit.message = null;
    this.settleMessage(unit.key, message, false, unit.error, now, unit.error === REDELIVER_NOW);
    unit.pid = null;
    unit.pgid = null;
    unit.lane = null;
    unit.killedAt = null;
    fs.rmSync(unitPaths(this.config.poolDir, unit.key).abort, { force: true });
    if (unit.error === "aborted") {
      unit.state = "failed";
      unit.finished = this.ops.now();
      unit.errorKind = "aborted";
    } else if (unit.timeouts >= MAX_TIMEOUTS) {
      unit.state = "failed";
      unit.finished = this.ops.now();
      unit.errorKind = "timeout";
    } else {
      unit.state = "queued";
    }
    this.save(unit);
  }

  private finish(unit: UnitRecord, exitCode: number | null, now: number): void {
    const paths = unitPaths(this.config.poolDir, unit.key);
    const tail = readTail(paths.log);
    const message = unit.message ?? null;
    unit.message = null;
    unit.pid = null;
    unit.pgid = null;
    if (isLimitFailure(exitCode, tail)) {
      this.settleMessage(unit.key, message, false, null, now, true);
      this.limitHit(unit, now);
      return;
    }
    const sqlite = exitCode === 0 ? null : classifySqlite(tail);
    if (sqlite) {
      this.settleMessage(unit.key, message, false, sqlite, now);
      this.sqliteHit(unit, exitCode, sqlite, extractErrorLine(tail), now);
      return;
    }
    const error = exitCode === 0 ? null : exitCode === null ? "worker lost" : `exit ${exitCode}`;
    this.settleMessage(unit.key, message, exitCode === 0, error, now);
    unit.exitCode = exitCode;
    unit.errorKind = null;
    unit.errorRaw = null;
    if (exitCode === 0) {
      unit.state = "done";
      unit.finished = now;
      unit.error = null;
      this.consecutiveHits = 0;
      this.noteSqliteSuccess();
    } else if (exitCode === null && unit.attempts < MAX_LOST_ATTEMPTS) {
      unit.state = "queued";
      unit.lane = null;
      unit.error = "worker lost; requeued";
    } else {
      unit.state = "failed";
      unit.finished = now;
      unit.error = error;
      unit.errorKind = exitCode === null ? "worker_lost" : "exit";
      unit.errorRaw = extractErrorLine(tail);
    }
    this.save(unit);
  }

  /**
   * A sqlite failure requeues the unit with backoff, shrinks its lane by one slot (never below
   * one), and counts toward stopping the pool. Units past max_retries fail with their error kind.
   */
  private sqliteHit(
    unit: UnitRecord,
    exitCode: number | null,
    kind: string,
    raw: string | null,
    now: number,
  ): void {
    const lane = this.lanes.find((entry) => entry.name === unit.lane);
    if (lane && lane.effectiveCap > 1) {
      lane.effectiveCap -= 1;
      lane.sqliteShrink += 1;
    }
    this.consecutiveSqlite += 1;
    this.sqliteSuccesses = 0;
    fs.rmSync(unitPaths(this.config.poolDir, unit.key).exit, { force: true });
    unit.exitCode = exitCode;
    unit.errorKind = kind;
    unit.errorRaw = raw;
    unit.lane = null;
    unit.sqliteRetries = (unit.sqliteRetries ?? 0) + 1;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (unit.sqliteRetries > maxRetries) {
      unit.state = "failed";
      unit.finished = now;
      unit.error = `${kind}; retries exhausted`;
      unit.notBefore = null;
    } else {
      unit.state = "queued";
      unit.error = `${kind}; requeued`;
      unit.notBefore = now + SQLITE_BACKOFF_MS * unit.sqliteRetries;
    }
    this.save(unit);
    if (this.consecutiveSqlite >= SQLITE_CONSECUTIVE_STOP) {
      this.stop(
        "limit-stopped",
        `${SQLITE_CONSECUTIVE_STOP} consecutive sqlite failures (${kind})`,
        now,
      );
    }
  }

  /** Any success ends a sqlite streak; enough of them give one shrunk slot back. */
  private noteSqliteSuccess(): void {
    this.consecutiveSqlite = 0;
    this.sqliteSuccesses += 1;
    if (this.sqliteSuccesses < SQLITE_RESTORE_AFTER) return;
    this.sqliteSuccesses = 0;
    const lane = this.lanes.find((entry) => entry.sqliteShrink > 0);
    if (!lane) return;
    lane.sqliteShrink -= 1;
    lane.effectiveCap = Math.min(lane.cap, lane.effectiveCap + 1);
  }

  /** Free disk under the cwd or the opencode data dir, when below the floor. Null when fine. */
  private lowDisk(): LowDisk | null {
    const freeMb = this.ops.freeMb;
    if (!freeMb) return null;
    return findLowDisk(
      [this.config.cwd, opencodeDataDir(process.env)],
      minFreeMb(process.env),
      freeMb,
    );
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
    // Units with a queued message go first (redelivery is high priority); the rest keep key order.
    const queued = [...this.units.values()]
      .filter((unit) => unit.state === "queued")
      .map((unit) => ({ unit, pending: this.pendingFor(unit.key, now) }))
      .filter((entry) => !this.options.redeliverOnly || entry.pending !== null)
      .sort(
        (a, b) =>
          Number(b.pending !== null) - Number(a.pending !== null) ||
          (b.pending?.priority ?? 0) - (a.pending?.priority ?? 0) ||
          a.unit.key.localeCompare(b.unit.key),
      );
    // Low disk pauses new launches; running workers are left alone.
    const low = this.lowDisk();
    this.pausedReason = low ? "disk_low" : null;
    if (low) return;
    for (const { unit } of queued) {
      if ((unit.notBefore ?? 0) > now) continue;
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
      const pending = this.pendingFor(unit.key, now);
      const sessionId = pending && unit.attempts > 0 ? this.sessionOf(unit.key) : null;
      if (pending && unit.attempts > 0 && sessionId === null) {
        // Resume is impossible until the session is visible again; try on a later tick.
        return;
      }
      fs.rmSync(paths.exit, { force: true });
      let args: string[];
      if (pending && sessionId) {
        args = buildResumeArgs({ model: lane.model, sessionId, text: pending.text });
        unit.message = pending.id;
        mutateMessage(this.inboxOf(unit.key), pending.id, startAttempt);
      } else {
        const brief = renderBrief(this.config.briefTemplate, {
          path: unit.file,
          name: path.basename(unit.file),
          key: unit.key,
        });
        const prompt = `${brief.trim()}\n\n${sharedSection(this.config.forbid)}\n`;
        fs.writeFileSync(paths.prompt, prompt, { mode: 0o600 });
        args = buildRunArgs({
          model: lane.model,
          agent: null,
          title: `pool ${unit.key}`,
          promptFile: paths.prompt,
        });
        unit.message = null;
      }
      const handle = this.ops.spawn({
        command: this.config.binary,
        args,
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
      unit.errorKind = null;
      unit.notBefore = null;
      unit.finished = null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.settleMessage(unit.key, unit.message ?? null, false, reason, now);
      unit.message = null;
      unit.state = "failed";
      unit.finished = now;
      unit.error = reason;
    }
    this.save(unit);
  }

  private stop(status: "stopped" | "limit-stopped", reason: string, now: number): void {
    this.status = status;
    this.reason = reason;
    for (const unit of this.running()) {
      if (unit.pgid !== null) this.ops.signal(unit.pgid, "SIGTERM");
      const message = unit.message ?? null;
      unit.message = null;
      this.settleMessage(unit.key, message, false, reason, now, status !== "stopped");
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
      owner_id: this.config.ownerId ?? null,
      owner_label: this.config.ownerLabel ?? null,
      updated: this.ops.now(),
      consecutive_hits: this.consecutiveHits,
      consecutive_sqlite: this.consecutiveSqlite,
      sqlite_successes: this.sqliteSuccesses,
      paused_reason: this.pausedReason,
      lanes: this.lanes.map((lane) => ({
        name: lane.name,
        model: lane.model,
        cap: lane.cap,
        effective_cap: lane.effectiveCap,
        hits: lane.hits,
        backoff_until: lane.backoffUntil,
        sqlite_shrink: lane.sqliteShrink,
      })),
    });
  }
}

/** Entry used by the detached supervisor process: load config, scan units, tick until done. */
export async function runSupervisor(
  configPath: string,
  ops: SupervisorOps = PROCESS_OPS,
  options: SupervisorOptions = {},
): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as PoolConfig;
  const supervisor = new PoolSupervisor(config, ops, process.pid, options);
  supervisor.load(scanUnits(config.unitsGlob));
  while (supervisor.tick()) {
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}
