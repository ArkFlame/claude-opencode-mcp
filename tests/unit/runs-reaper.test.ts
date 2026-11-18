import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunManager } from "../../src/runs/manager.js";
import { type RunRecord, RunStore } from "../../src/runs/store.js";
import { createLogger } from "../../src/util/logger.js";

const dirs: string[] = [];
const MIN = 60_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A manager with no slots: submitted runs stay queued and never spawn a process. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-reaper-"));
  dirs.push(dir);
  const store = new RunStore(dir);
  const logger = createLogger({ file: path.join(dir, "bridge.log") });
  const manager = new RunManager({
    store,
    logger,
    ownerPid: process.pid,
    settings: { binary: "opencode", maxParallel: 0, retry: false, timeoutMs: MIN },
  });
  return { store, manager };
}

function submit(manager: RunManager, overrides: { queueTtlMs?: number } = {}) {
  return manager.submit({
    name: "demo",
    prompt: "task",
    cwd: os.tmpdir(),
    branch: null,
    agent: null,
    agentConfig: null,
    model: "opencode-go/hy4-flash-free",
    modelNote: null,
    allowSharedCwd: true,
    timeoutMs: MIN,
    idleMs: MIN,
    ...overrides,
  });
}

function rewrite(store: RunStore, id: string, patch: Partial<RunRecord>): void {
  const current = store.get(id);
  if (!current) throw new Error(`missing run ${id}`);
  store.save({ ...current, ...patch });
}

describe("reaper clocks", () => {
  it("does not reap a queued run that is older than the hard timeout", () => {
    const { store, manager } = setup();
    const record = submit(manager);
    rewrite(store, record.id, { created: Date.now() - 10 * MIN });
    expect(manager.reapStale()).toBe(0);
    expect(store.get(record.id)?.status).toBe("queued");
  });

  it("reaps a queued run once its queue TTL has passed", () => {
    const { store, manager } = setup();
    const record = submit(manager, { queueTtlMs: 1_000 });
    rewrite(store, record.id, { created: Date.now() - 5_000 });
    expect(manager.reapStale()).toBe(1);
    expect(store.get(record.id)?.status).toBe("stale");
    expect(store.get(record.id)?.error).toContain("queue ttl exceeded");
    expect(manager.queuedCount()).toBe(0);
  });

  it("reaps a started run past its own hard timeout, measured from process start", () => {
    const { store, manager } = setup();
    store.save(
      baseRecord(manager, {
        id: "started-1",
        status: "running",
        created: Date.now() - 3 * 60 * MIN,
        started: Date.now() - 2 * 60 * MIN,
        timeout_ms: MIN,
      }),
    );
    expect(manager.reapStale()).toBe(1);
    expect(store.get("started-1")?.status).toBe("stale");
  });

  it("honours the run's own timeout instead of the settings default", () => {
    const { store, manager } = setup();
    store.save(
      baseRecord(manager, {
        id: "long-1",
        status: "running",
        started: Date.now() - 10 * MIN,
        timeout_ms: 3_600_000,
      }),
    );
    expect(manager.reapStale()).toBe(0);
    expect(store.get("long-1")?.status).toBe("running");
  });

  it("leaves a queued run that a live sibling process of the same session owns", () => {
    const { store, manager } = setup();
    // pid 1 is alive and is not this process, so this run sits in another process's queue.
    store.save(
      baseRecord(manager, {
        id: "sibling-1",
        status: "queued",
        owner_id: manager.owner.id,
        owner_pid: 1,
        created: Date.now() - 10 * MIN,
      }),
    );
    expect(manager.reapStale()).toBe(0);
    expect(store.get("sibling-1")?.status).toBe("queued");
  });
});

function baseRecord(manager: RunManager, overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-x",
    name: "demo",
    status: "queued",
    cwd: os.tmpdir(),
    branch: null,
    agent: null,
    model: "opencode-go/hy4-flash-free",
    model_note: null,
    allow_shared_cwd: true,
    attempts: 0,
    owner_pid: manager.owner.pid,
    owner_id: manager.owner.id,
    owner_label: null,
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
    prompt_file: "/dev/null",
    log_file: "/dev/null",
    ...overrides,
  };
}
