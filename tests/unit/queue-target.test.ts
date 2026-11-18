import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { poolDirFor } from "../../src/pool/state.js";
import { resolveQueueTarget } from "../../src/queue/target.js";
import { type RunRecord, RunStore } from "../../src/runs/store.js";
import type { AgentSession } from "../../src/types/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cop-target-"));
  dirs.push(root);
  const runsDir = path.join(root, "runs");
  const store = new RunStore(runsDir);
  const sessions = new Map<string, AgentSession>();
  const sources = {
    store,
    runsDir,
    getSession: (id: string) => sessions.get(id) ?? null,
  };
  return { root, runsDir, store, sessions, sources };
}

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: "run-1",
    name: "run",
    status: "done",
    cwd: "/tmp",
    branch: null,
    agent: null,
    model: "p/m",
    model_note: null,
    allow_shared_cwd: true,
    attempts: 1,
    owner_pid: 1,
    pid: null,
    pgid: null,
    created: 1,
    started: 1,
    finished: 2,
    last_activity: 2,
    exit_code: 0,
    signal: null,
    final_text: null,
    final_truncated: false,
    last_line: null,
    error: null,
    prompt_file: "/tmp/p.md",
    log_file: "/tmp/run.log",
    ...overrides,
  };
}

describe("queue target resolution", () => {
  it("rejects run ids that are malformed or unknown", () => {
    const { sources } = setup();
    expect(() => resolveQueueTarget(sources, "../escape")).toThrow(/invalid format/);
    expect(() => resolveQueueTarget(sources, "missing-run")).toThrow(/Unknown run/);
  });

  it("refuses background CLI runs that are not pool units", () => {
    const { store, sources } = setup();
    store.save(record({ id: "cli-run-1" }));
    expect(() => resolveQueueTarget(sources, "cli-run-1")).toThrow(/not supported/);
  });

  it("resolves a pool unit record to its pool directory, key and config", () => {
    const { store, runsDir, sources } = setup();
    const poolId = "abcdef0123";
    const poolDir = poolDirFor(runsDir, poolId);
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(
      path.join(poolDir, "config.json"),
      JSON.stringify({ id: poolId, cwd: "/tmp", lanes: [] }),
    );
    store.save(
      record({
        id: `pl${poolId}-0011223344`,
        status: "running",
        pool: poolId,
        log_file: path.join(poolDir, "unit-9.log"),
      }),
    );
    const target = resolveQueueTarget(sources, `pl${poolId}-0011223344`);
    expect(target.kind).toBe("pool-unit");
    if (target.kind !== "pool-unit") return;
    expect(target.key).toBe("unit-9");
    expect(target.poolDir).toBe(poolDir);
    expect(target.config.id).toBe(poolId);
    expect(target.inboxFile).toBe(path.join(runsDir, `pl${poolId}-0011223344.inbox.jsonl`));
  });

  it("resolves an OpenCode session id when no run record matches", () => {
    const { sessions, sources } = setup();
    sessions.set("ses_1", {
      id: "ses_1",
      cwd: "/tmp",
      agent: "build",
      status: "completed",
    } as unknown as AgentSession);
    const target = resolveQueueTarget(sources, "ses_1");
    expect(target.kind).toBe("session");
    expect(target.status).toBe("completed");
  });
});
