import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunManager } from "../../src/runs/manager.js";
import { createRunOwner, type RunOwner } from "../../src/runs/owner.js";
import { type RunRecord, RunStore } from "../../src/runs/store.js";
import { createLogger } from "../../src/util/logger.js";

/** A pid that is certainly not alive on Linux (above the default pid_max). */
const DEAD_PID = 2147483646;
const OTHER = { id: "other-session", label: "claude-code#bbbb" };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(owner: RunOwner, maxParallel = 4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-owner-"));
  dirs.push(dir);
  const store = new RunStore(path.join(dir, "runs"));
  const manager = new RunManager({
    store,
    settings: {
      binary: "/nonexistent/opencode-bin",
      maxParallel,
      retry: false,
      timeoutMs: 600_000,
    },
    logger: createLogger({ file: path.join(dir, "bridge.log") }),
    owner,
  });
  return { store, manager };
}

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "r",
    name: "task",
    status: "running",
    cwd: "/repo",
    branch: null,
    agent: null,
    model: "opencode-go/x",
    model_note: null,
    allow_shared_cwd: false,
    attempts: 1,
    owner_pid: process.pid,
    pid: null,
    pgid: null,
    created: Date.now(),
    started: Date.now(),
    finished: null,
    last_activity: Date.now(),
    exit_code: null,
    signal: null,
    final_text: null,
    final_truncated: false,
    last_line: null,
    error: null,
    prompt_file: "/tmp/none.md",
    log_file: "/tmp/none.log",
    ...overrides,
  };
}

const me = () => createRunOwner({ env: { CLAUDE_OPENCODE_OWNER: "me-session" }, pid: process.pid });

describe("RunManager owner stamping", () => {
  it("stamps owner_id and owner_label on submitted runs", () => {
    const owner = me();
    // Zero slots: the run is recorded and queued but never spawns a process.
    const { manager } = setup(owner, 0);
    const submitted = manager.submit({
      name: "stamp",
      prompt: "p",
      cwd: "/repo-a",
      branch: null,
      agent: null,
      agentConfig: null,
      model: "opencode-go/x",
      modelNote: null,
      allowSharedCwd: true,
      timeoutMs: 600_000,
      idleMs: 600_000,
    });
    expect(submitted.owner_id).toBe("me-session");
    expect(submitted.owner_label).toBe(owner.label);
    void manager.abortAll();
  });
});

describe("RunManager scoped mutations and stale handling", () => {
  it("abort_all skips a live foreign run, and clears it only with scope all plus force", () => {
    const { store, manager } = setup(me());
    store.save(record({ id: "foreign", owner_id: OTHER.id, owner_label: OTHER.label }));
    manager.abortAll();
    expect(store.get("foreign")?.status).toBe("running");
    manager.abortAll({ scope: "all", force: true });
    expect(store.get("foreign")?.status).toBe("aborted");
  });

  it("never marks a live other session's run stale, even when it is overdue", () => {
    const { store, manager } = setup(me());
    const longAgo = Date.now() - 24 * 3600_000;
    store.save(
      record({
        id: "live-foreign",
        owner_id: OTHER.id,
        owner_label: OTHER.label,
        started: longAgo,
      }),
    );
    expect(manager.reapStale()).toBe(0);
    expect(store.get("live-foreign")?.status).toBe("running");
  });

  it("marks a run stale once its owner process is dead", () => {
    const { store, manager } = setup(me());
    store.save(
      record({
        id: "dead-foreign",
        owner_id: OTHER.id,
        owner_label: OTHER.label,
        owner_pid: DEAD_PID,
      }),
    );
    expect(manager.reapStale()).toBe(1);
    expect(store.get("dead-foreign")?.status).toBe("stale");
  });

  it("treats a legacy record with a dead owner pid as an orphan to reap", () => {
    const { store, manager } = setup(me());
    store.save(record({ id: "legacy-dead", owner_pid: DEAD_PID, owner_id: undefined }));
    expect(manager.reapStale()).toBe(1);
    expect(store.get("legacy-dead")?.status).toBe("stale");
  });

  it("keeps a legacy record owned by this process, and clears my queued orphan", () => {
    const { store, manager } = setup(me());
    store.save(record({ id: "legacy-mine", owner_pid: process.pid, owner_id: undefined }));
    store.save(record({ id: "orphan", status: "queued", started: null, owner_id: "me-session" }));
    expect(manager.reapStale()).toBe(1);
    expect(store.get("legacy-mine")?.status).toBe("running");
    expect(store.get("orphan")?.status).toBe("stale");
  });

  it("keeps another session's queued run instead of reaping it as an orphan", () => {
    const { store, manager } = setup(me());
    store.save(
      record({ id: "foreign-queued", status: "queued", started: null, owner_id: OTHER.id }),
    );
    expect(manager.reapStale()).toBe(0);
    expect(store.get("foreign-queued")?.status).toBe("queued");
  });
});

describe("RunManager shared cwd collision", () => {
  it("reports a live foreign run in the same cwd and queues an exclusive job behind it", () => {
    const { store, manager } = setup(me());
    store.save(
      record({ id: "holder", owner_id: OTHER.id, owner_label: OTHER.label, cwd: "/repo-shared" }),
    );
    expect(manager.collisionFor("/repo-shared")?.owner_label).toBe(OTHER.label);
    expect(manager.collisionFor("/elsewhere")).toBeNull();

    const submitted = manager.submit({
      name: "blocked",
      prompt: "p",
      cwd: "/repo-shared",
      branch: null,
      agent: null,
      agentConfig: null,
      model: "opencode-go/x",
      modelNote: null,
      allowSharedCwd: false,
      timeoutMs: 600_000,
      idleMs: 600_000,
    });
    expect(manager.queuePosition(submitted.id)).toBe(1);
    expect(manager.activeCount()).toBe(0);
    void manager.abortAll();
  });
});
