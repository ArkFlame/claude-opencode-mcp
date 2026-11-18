import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../util/logger.js";
import { type AttemptResult, KILL_GRACE_MS, runAttempt } from "./attempt.js";
import { runErrorKind } from "./errors.js";
import { foreignCwdHolder } from "./lock.js";
import { createRunOwner, type OwnerScope, ownershipOf, type RunOwner } from "./owner.js";
import type { RunSettings } from "./settings.js";
import {
  isProcessAlive,
  isTerminal,
  killProcessGroup,
  looksLikeOpencode,
  type RunRecord,
  type RunStatus,
  type RunStore,
} from "./store.js";

/** A run may outlive its own deadline by this much before the reaper treats it as stuck. */
const REAP_MARGIN_MS = 60_000;
/** Reaper and slot reconciliation period. Short so dead runs free their slot promptly. */
const REAP_INTERVAL_MS = 10_000;
/** Queue wait allowed when the caller gave no timeout_seconds: one hour. */
export const DEFAULT_QUEUE_TTL_MS = 3_600_000;
const PERSIST_THROTTLE_MS = 5_000;
const WAIT_TICK_MS = 2_000;

export interface SubmitInput {
  name: string;
  prompt: string;
  cwd: string;
  branch: string | null;
  agent: string | null;
  agentConfig: string | null;
  model: string;
  modelNote: string | null;
  allowSharedCwd: boolean;
  timeoutMs: number;
  idleMs: number;
  /** Longest a run may wait queued before it is reaped. Defaults to DEFAULT_QUEUE_TTL_MS. */
  queueTtlMs?: number;
}

interface Job {
  record: RunRecord;
  input: SubmitInput;
  abort: AbortController;
  lastPersist: number;
}

export interface RunManagerOptions {
  store: RunStore;
  settings: Pick<RunSettings, "binary" | "maxParallel" | "retry" | "timeoutMs">;
  logger: Logger;
  ownerPid?: number;
  /** Owning session; derived from the process environment when omitted. */
  owner?: RunOwner;
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Argument vector for `opencode run`. No shell: every value is one argv entry. */
export function buildRunArgs(input: {
  model: string;
  agent: string | null;
  title: string;
  promptFile: string;
}): string[] {
  const args = ["run", "--standalone", "--format", "json", "--auto", "-m", input.model];
  if (input.agent) args.push("--agent", input.agent);
  args.push(
    "--title",
    input.title.slice(0, 120),
    "--file",
    input.promptFile,
    "--",
    "Carry out the attached task brief exactly as written.",
  );
  return args;
}

export function summaryLine(records: RunRecord[], maxParallel: number): string {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.status] = (counts[record.status] ?? 0) + 1;
  const order: RunStatus[] = ["running", "queued", "done", "failed", "timeout", "stale", "aborted"];
  const parts = order
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${status}`);
  return `${parts.join(", ") || "no runs"} (max parallel ${maxParallel})`;
}

/** Hard limit of one run, from its process start: its own timeout, else the settings default. */
export function hardLimitOf(record: RunRecord, defaultMs: number): number {
  return (record.timeout_ms ?? defaultMs) + REAP_MARGIN_MS;
}

/** How long a queued run may wait: its own TTL, else its timeout, else the settings default. */
export function queueTtlOf(record: RunRecord, defaultMs: number): number {
  return record.queue_ttl_ms ?? record.timeout_ms ?? Math.max(defaultMs, DEFAULT_QUEUE_TTL_MS);
}

export class RunManager {
  private readonly active = new Map<string, Job>();
  private queue: Job[] = [];
  private readonly events = new EventEmitter();
  private readonly ownerPid: number;
  readonly owner: RunOwner;
  private reaper: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly options: RunManagerOptions) {
    this.owner = options.owner ?? createRunOwner({ env: process.env });
    this.ownerPid = options.ownerPid ?? this.owner.pid;
    this.events.setMaxListeners(200);
  }

  get store(): RunStore {
    return this.options.store;
  }

  get maxParallel(): number {
    return this.options.settings.maxParallel;
  }

  get settings(): RunManagerOptions["settings"] {
    return this.options.settings;
  }

  /** Reap leftovers from earlier processes and start the periodic reaper. */
  start(): void {
    this.reapStale();
    if (!this.reaper) {
      this.reaper = setInterval(() => this.reapStale(), REAP_INTERVAL_MS);
      this.reaper.unref();
    }
  }

  submit(input: SubmitInput): RunRecord {
    if (this.stopping) {
      throw new Error("the run manager is shutting down");
    }
    const id = newRunId();
    const dir = this.store.dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = path.join(dir, `${id}.prompt.md`);
    fs.writeFileSync(promptFile, input.prompt, { mode: 0o600 });
    const record: RunRecord = {
      id,
      name: input.name,
      status: "queued",
      cwd: input.cwd,
      branch: input.branch,
      agent: input.agent,
      model: input.model,
      model_note: input.modelNote,
      allow_shared_cwd: input.allowSharedCwd,
      attempts: 0,
      owner_pid: this.ownerPid,
      owner_id: this.owner.id,
      owner_label: this.owner.label,
      pid: null,
      pgid: null,
      created: Date.now(),
      started: null,
      finished: null,
      last_activity: Date.now(),
      exit_code: null,
      signal: null,
      final_text: null,
      final_truncated: false,
      last_line: null,
      error: null,
      prompt_file: promptFile,
      log_file: path.join(dir, `${id}.log`),
      timeout_ms: input.timeoutMs,
      idle_ms: input.idleMs,
      queue_ttl_ms: input.queueTtlMs ?? DEFAULT_QUEUE_TTL_MS,
    };
    this.store.save(record);
    this.queue.push({ record, input, abort: new AbortController(), lastPersist: 0 });
    this.pump();
    return this.store.get(id) ?? record;
  }

  /** 1-based queue position, or 0 when the run is not queued. */
  queuePosition(id: string): number {
    const index = this.queue.findIndex((job) => job.record.id === id);
    return index < 0 ? 0 : index + 1;
  }

  activeCount(): number {
    return this.active.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  private canStart(job: Job, foreign: RunRecord[]): boolean {
    if (job.input.allowSharedCwd) return true;
    for (const active of this.active.values()) {
      if (active.input.cwd === job.input.cwd) return false;
    }
    return foreignCwdHolder(foreign, job.input.cwd, this.owner) === null;
  }

  /** Live runs of other sessions that could hold a cwd. Read once per pump, only when queued. */
  private foreignRuns(): RunRecord[] {
    return this.queue.length > 0 ? this.store.list() : [];
  }

  /** A run of another live session that holds this cwd, so a new run there must wait. */
  collisionFor(cwd: string): RunRecord | null {
    return foreignCwdHolder(this.store.list(), cwd, this.owner);
  }

  private pump(): void {
    const foreign = this.foreignRuns();
    while (this.active.size < this.options.settings.maxParallel) {
      const index = this.queue.findIndex((job) => this.canStart(job, foreign));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (!job) return;
      this.active.set(job.record.id, job);
      void this.execute(job);
    }
  }

  private persist(record: RunRecord): void {
    try {
      this.store.save(record);
    } catch (error) {
      this.options.logger.warn("failed to persist run record", {
        run_id: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const { record, input } = job;
    const maxAttempts = this.options.settings.retry ? 2 : 1;
    let result: AttemptResult | null = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        record.attempts = attempt;
        record.status = "running";
        record.started = Date.now();
        record.last_activity = record.started;
        record.pid = null;
        record.pgid = null;
        record.error = null;
        this.persist(record);
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (input.agentConfig) env.OPENCODE_CONFIG_CONTENT = input.agentConfig;
        result = await runAttempt(
          {
            command: this.options.settings.binary,
            args: buildRunArgs({
              model: input.model,
              agent: input.agent,
              title: `${input.name} (${record.id})`,
              promptFile: record.prompt_file,
            }),
            cwd: input.cwd,
            env,
            logFile: record.log_file,
          },
          { timeoutMs: input.timeoutMs, idleMs: input.idleMs },
          {
            onSpawn: (pid) => {
              record.pid = pid;
              record.pgid = pid;
              this.persist(record);
            },
            onActivity: (line, at) => {
              record.last_activity = at;
              if (line) record.last_line = line;
              if (at - job.lastPersist >= PERSIST_THROTTLE_MS) {
                job.lastPersist = at;
                this.persist(record);
              }
            },
          },
          job.abort.signal,
        );
        if (job.abort.signal.aborted || result.end !== "exit" || result.text) break;
        this.options.logger.warn("run ended without a final reply", {
          run_id: record.id,
          attempt,
          exit_code: result.exitCode,
        });
      }
    } catch (error) {
      result = {
        end: "spawn-error",
        exitCode: null,
        signal: null,
        text: "",
        errorMessage: error instanceof Error ? error.message : String(error),
        lastLine: null,
        pid: null,
        pgid: null,
      };
    }
    this.finalize(job, result);
  }

  private finalize(job: Job, result: AttemptResult | null): void {
    const { record, input } = job;
    const end = result?.end ?? "spawn-error";
    let status: RunStatus;
    if (job.abort.signal.aborted) status = "aborted";
    else if (end === "timeout" || end === "idle") status = "timeout";
    else if (end === "exit" && result?.text && result.exitCode === 0) status = "done";
    else status = "failed";

    record.status = status;
    record.finished = Date.now();
    record.pid = null;
    record.pgid = null;
    record.exit_code = result?.exitCode ?? null;
    record.signal = result?.signal ?? null;
    record.final_text = result?.text ? result.text : null;
    record.final_truncated = (result?.text.length ?? 0) > 256 * 1024;
    if (result?.lastLine) record.last_line = result.lastLine;
    record.error_raw = result?.errorMessage ?? null;
    record.error_kind = runErrorKind({
      end: job.abort.signal.aborted ? "aborted" : end,
      exitCode: record.exit_code,
      rawError: record.error_raw,
      done: status === "done",
    });
    if (status === "aborted") record.error = "aborted";
    else if (end === "timeout")
      record.error = `hard timeout after ${Math.round(input.timeoutMs / 1000)}s`;
    else if (end === "idle") record.error = `no output for ${Math.round(input.idleMs / 1000)}s`;
    else if (status === "failed")
      record.error = result?.errorMessage ?? "run ended without a final reply";
    this.persist(record);
    this.active.delete(record.id);
    this.options.logger.info("run finished", {
      run_id: record.id,
      status,
      attempts: record.attempts,
    });
    this.events.emit("finished", record.id);
    this.pump();
  }

  /** Abort one run. Queued runs are dropped; active runs get SIGTERM then SIGKILL. */
  abort(id: string): RunRecord | null {
    const queuedIndex = this.queue.findIndex((job) => job.record.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      if (job) {
        job.record.status = "aborted";
        job.record.error = "aborted before start";
        job.record.finished = Date.now();
        this.persist(job.record);
        this.events.emit("finished", id);
      }
      return this.store.get(id);
    }
    const job = this.active.get(id);
    if (job) {
      job.abort.abort();
      return this.store.get(id);
    }
    const stored = this.store.get(id);
    if (stored && !isTerminal(stored.status)) {
      this.reapRecord(stored, "aborted by request", "aborted");
      this.events.emit("finished", id);
      return this.store.get(id);
    }
    return stored;
  }

  /**
   * Abort this session's runs. Another live session's records are skipped unless scope is all
   * and force is set. Unowned legacy records are orphans and are always cleared.
   */
  abortAll(options: { scope?: OwnerScope; force?: boolean } = {}): {
    queued: number;
    running: number;
    reaped: number;
  } {
    const includeForeign = options.scope === "all" && options.force === true;
    const queued = this.queue.length;
    for (const job of [...this.queue]) this.abort(job.record.id);
    const running = this.active.size;
    for (const id of [...this.active.keys()]) this.abort(id);
    let reaped = 0;
    for (const record of this.store.list()) {
      if (isTerminal(record.status) || this.active.has(record.id)) continue;
      if (!includeForeign && ownershipOf(record, this.owner).foreign) continue;
      this.abort(record.id);
      reaped += 1;
    }
    return { queued, running, reaped };
  }

  /**
   * Mark orphaned, overdue or queue-expired runs stale and kill their process groups. Returns the
   * count. The hard timeout counts from process start and uses the run's own limit. A queued run
   * never hits it: it has its own queue TTL, and a live queue owned by another process is left alone.
   */
  reapStale(now = Date.now()): number {
    let count = 0;
    for (const record of this.store.list()) {
      if (isTerminal(record.status) || this.active.has(record.id)) continue;
      const queued = this.queue.find((job) => job.record.id === record.id);
      if (queued) {
        if (now - record.created > queueTtlOf(record, this.options.settings.timeoutMs)) {
          this.queue = this.queue.filter((job) => job !== queued);
          this.reapRecord(record, "queue ttl exceeded before start; run reaped", "stale");
          count += 1;
        }
        continue;
      }
      if (record.pool) {
        // Pool workers belong to their supervisor. Reap only when neither it nor the worker lives.
        const pgid = record.pgid ?? record.pid;
        const orphaned = !isProcessAlive(record.owner_pid) && (!pgid || !isProcessAlive(pgid));
        if (orphaned) {
          this.reapRecord(record, "pool supervisor exited; worker gone", "stale");
          count += 1;
        }
        continue;
      }
      const view = ownershipOf(record, this.owner);
      // Only a dead owner makes a run stale. A live other session's run is never touched.
      const ownerGone = !isProcessAlive(record.owner_pid) && !this.adopt(record);
      if (view.foreign && !ownerGone) continue;
      // A queued record whose owner is this process but that is not in this queue lost its queue.
      // A live sibling process of the same session keeps its own queue, so its records stay.
      const lostQueue =
        record.status === "queued" && record.owner_pid === this.ownerPid && view.mine;
      const overdue =
        view.mine &&
        record.status === "running" &&
        record.started !== null &&
        now - record.started > hardLimitOf(record, this.options.settings.timeoutMs);
      if (!ownerGone && !lostQueue && !overdue) continue;
      const reason = ownerGone
        ? "owner process exited; run reaped"
        : lostQueue
          ? "queued run lost its queue; run reaped"
          : "exceeded hard timeout; run reaped";
      this.reapRecord(record, reason, "stale");
      count += 1;
    }
    if (count > 0) this.options.logger.info("reaped stale runs", { count });
    this.pump();
    return count;
  }

  /**
   * A restarted MCP server under the same Claude session re-adopts its own live runs: the
   * record's owner_pid moves to this process so the runs stay visible and abortable.
   */
  private adopt(record: RunRecord): boolean {
    if (record.owner_id !== this.owner.id) return false;
    const pgid = record.pgid ?? record.pid;
    if (!pgid || !isProcessAlive(pgid) || !looksLikeOpencode(pgid)) return false;
    record.owner_pid = this.ownerPid;
    record.owner_label = this.owner.label;
    this.persist(record);
    this.options.logger.info("re-adopted run after server restart", { run_id: record.id });
    return true;
  }

  private reapRecord(record: RunRecord, reason: string, status: RunStatus): void {
    const pgid = record.pgid ?? record.pid;
    if (pgid && isProcessAlive(pgid) && looksLikeOpencode(pgid)) {
      killProcessGroup(pgid, "SIGTERM");
      const timer = setTimeout(() => killProcessGroup(pgid, "SIGKILL"), KILL_GRACE_MS);
      timer.unref();
    }
    record.status = status;
    record.error = reason;
    record.finished = Date.now();
    record.pid = null;
    record.pgid = null;
    this.persist(record);
    this.events.emit("finished", record.id);
  }

  /** Wait until this process has no active runs (after abort), bounded by `ms`. */
  async waitForActive(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (this.active.size > 0 && Date.now() < deadline) {
      await this.nextEvent(Math.min(WAIT_TICK_MS, deadline - Date.now()));
    }
    return this.active.size === 0;
  }

  /** Wait until any listed run is terminal, or until `seconds` elapse. Never busy-polls. */
  async waitAny(
    ids: string[],
    seconds: number,
  ): Promise<{ finished: RunRecord[]; pending: string[]; unknown: string[]; timed_out: boolean }> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      // A run of another session may have finished since the last check, freeing a cwd.
      this.pump();
      const snapshot = this.collect(ids);
      const done = snapshot.finished.length > 0 || snapshot.pending.length === 0;
      if (done || Date.now() >= deadline) {
        return { ...snapshot, timed_out: !done };
      }
      await this.nextEvent(Math.min(WAIT_TICK_MS, deadline - Date.now()));
    }
  }

  private collect(ids: string[]): { finished: RunRecord[]; pending: string[]; unknown: string[] } {
    const finished: RunRecord[] = [];
    const pending: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const record = this.store.get(id);
      if (!record) unknown.push(id);
      else if (isTerminal(record.status)) finished.push(record);
      else pending.push(id);
    }
    return { finished, pending, unknown };
  }

  private nextEvent(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off("finished", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.events.on("finished", done);
    });
  }

  /** Stop accepting work, abort everything in flight. Child processes die with the group. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.reaper) clearInterval(this.reaper);
    for (const job of this.queue.splice(0)) this.abort(job.record.id);
    for (const id of this.active.keys()) this.abort(id);
  }

  /** Synchronous last resort for process `exit`: SIGKILL every group this process started. */
  killAllSync(): void {
    for (const job of this.active.values()) {
      const pgid = job.record.pgid;
      if (pgid) killProcessGroup(pgid, "SIGKILL");
      job.record.status = "aborted";
      job.record.error = "server shut down";
      job.record.finished = Date.now();
      job.record.pid = null;
      job.record.pgid = null;
      this.persist(job.record);
    }
  }
}
