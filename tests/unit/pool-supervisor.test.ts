import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KILL_GRACE_MS } from "../../src/pool/core.js";
import {
  type PoolConfig,
  poolDirFor,
  readPoolState,
  readUnit,
  stopFileFor,
  unitPaths,
  unitRecordId,
  writeUnit,
} from "../../src/pool/state.js";
import { PoolSupervisor, type SupervisorOps } from "../../src/pool/supervisor.js";
import { scanUnits } from "../../src/pool/units.js";
import { type RunRecord, RunStore } from "../../src/runs/store.js";

const dirs: string[] = [];
const MARKER = "STILL OPEN";
const POOL_ID = "abcdef0123";
const START = 1_000_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Spawn {
  pid: number;
  key: string;
  args: string[];
  exitFile: string;
  logFile: string;
}

/** Fake process layer: pids live in a set, the clock is manual, signals are recorded. */
class FakeOps implements SupervisorOps {
  clock = START;
  nextPid = 100;
  readonly alive = new Set<number>();
  readonly spawns: Spawn[] = [];
  readonly signals: Array<{ pgid: number; signal: string }> = [];

  now(): number {
    return this.clock;
  }

  spawn(request: { args: string[]; exitFile: string; logFile: string }) {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.alive.add(pid);
    const key = path.basename(request.exitFile, ".exit");
    this.spawns.push({
      pid,
      key,
      args: request.args,
      exitFile: request.exitFile,
      logFile: request.logFile,
    });
    return { pid, pgid: pid };
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  signal(pgid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pgid, signal });
    if (signal === "SIGKILL") this.alive.delete(pgid);
  }

  /** The worker ends: its exit file and log are written and its pid is gone. */
  end(key: string, exitCode: number, log = "done\nStatus: PASS\n"): void {
    const spawn = this.spawns
      .filter((entry) => entry.key === key && this.alive.has(entry.pid))
      .at(-1);
    if (!spawn) throw new Error(`no live worker for ${key}`);
    fs.writeFileSync(spawn.logFile, log);
    fs.writeFileSync(spawn.exitFile, `${exitCode}\n`);
    this.alive.delete(spawn.pid);
  }

  liveKeys(): string[] {
    return this.spawns.filter((entry) => this.alive.has(entry.pid)).map((entry) => entry.key);
  }
}

function setup(units: Record<string, string>, overrides: Partial<PoolConfig> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cop-pool-"));
  dirs.push(root);
  const unitsDir = path.join(root, "units");
  fs.mkdirSync(unitsDir);
  for (const [name, text] of Object.entries(units))
    fs.writeFileSync(path.join(unitsDir, name), text);
  const runsDir = path.join(root, "runs");
  const config: PoolConfig = {
    id: POOL_ID,
    unitsGlob: path.join(unitsDir, "*.md"),
    marker: MARKER,
    cwd: root,
    binary: "opencode",
    lanes: [{ name: "fast", model: "p/fast", cap: 2 }],
    perFileCap: 2,
    timeoutMs: 60_000,
    forbid: ["git", "cargo"],
    briefTemplate: "Work on {{UNIT_NAME}}.",
    runsDir,
    poolDir: poolDirFor(runsDir, POOL_ID),
    createdAt: START,
    ...overrides,
  };
  return { root, config, unitsDir };
}

function boot(units: Record<string, string>, overrides: Partial<PoolConfig> = {}) {
  const env = setup(units, overrides);
  const ops = new FakeOps();
  const supervisor = new PoolSupervisor(env.config, ops, 4242);
  supervisor.load(scanUnits(env.config.unitsGlob));
  return { ...env, ops, supervisor };
}

const OPEN = `# Unit\n${MARKER}\n`;

describe("pool scheduling", () => {
  it("runs at most the lane cap and skips closed units", () => {
    const { ops, supervisor } = boot({
      "a.md": OPEN,
      "b.md": OPEN,
      "c.md": OPEN,
      "closed.md": "# Unit\nDone\n",
    });
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "b"]);
    expect(supervisor.unit("closed")).toBeUndefined();
  });

  it("does not start two units that name the same exclusive .rs file", () => {
    const { ops, supervisor } = boot(
      {
        "a.md": `${OPEN}touch door.rs`,
        "b.md": `${OPEN}touch door.rs`,
        "c.md": `${OPEN}touch gate.rs`,
      },
      { lanes: [{ name: "fast", model: "p/fast", cap: 5 }] },
    );
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "c"]);
    ops.end("a", 0);
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "c", "b"]);
  });

  it("caps units naming one generic file by per_file_cap", () => {
    const { ops, supervisor } = boot(
      { "a.md": `${OPEN}mod.rs`, "b.md": `${OPEN}mod.rs`, "c.md": `${OPEN}mod.rs` },
      { lanes: [{ name: "fast", model: "p/fast", cap: 5 }], perFileCap: 2 },
    );
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  it("treats a unit with exit code 0 as finished and never relaunches it", () => {
    const env = setup({ "a.md": OPEN, "b.md": OPEN });
    fs.mkdirSync(env.config.poolDir, { recursive: true });
    fs.writeFileSync(unitPaths(env.config.poolDir, "a").exit, "0\n");
    const ops = new FakeOps();
    const supervisor = new PoolSupervisor(env.config, ops, 4242);
    supervisor.load(scanUnits(env.config.unitsGlob));
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["b"]);
    expect(supervisor.unit("a")?.state).toBe("done");
  });

  it("finishes the pool once every unit is done", () => {
    const { ops, supervisor, config } = boot({ "a.md": OPEN });
    supervisor.tick();
    ops.end("a", 0);
    expect(supervisor.tick()).toBe(false);
    expect(supervisor.poolStatus()).toBe("done");
    expect(readPoolState(config.poolDir)?.status).toBe("done");
  });
});

describe("provider limits", () => {
  it("requeues a limited unit, shrinks its lane and backs off before relaunching", () => {
    const { ops, supervisor, config } = boot(
      { "a.md": OPEN, "b.md": OPEN },
      {
        lanes: [{ name: "fast", model: "p/fast", cap: 2 }],
      },
    );
    supervisor.tick();
    ops.end("a", 1, "Error: usage limit reached\n");
    supervisor.tick();
    expect(supervisor.unit("a")?.state).toBe("queued");
    expect(supervisor.unit("a")?.limitHits).toBe(1);
    const lane = readPoolState(config.poolDir)?.lanes[0];
    expect(lane?.effective_cap).toBe(1);
    expect(lane?.backoff_until).toBe(START + 120_000);
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "b"]);

    ops.clock = START + 119_000;
    supervisor.tick();
    expect(ops.spawns.length).toBe(2);

    ops.end("b", 0);
    ops.clock = START + 120_000;
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "b", "a"]);
  });

  it("stops the whole pool after six consecutive limit hits", () => {
    const units = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`u${i}.md`, OPEN]));
    const { ops, supervisor, config } = boot(units, {
      lanes: [{ name: "fast", model: "p/fast", cap: 8 }],
    });
    supervisor.tick();
    for (const key of ops.liveKeys()) ops.end(key, 1, "rate limit exceeded\n");
    supervisor.tick();
    expect(supervisor.poolStatus()).toBe("limit-stopped");
    expect(readPoolState(config.poolDir)?.consecutive_hits).toBeGreaterThanOrEqual(6);
    expect(supervisor.tick()).toBe(false);
  });

  it("does not treat a limit word in a finished run as a limit", () => {
    const { ops, supervisor } = boot({ "a.md": OPEN });
    supervisor.tick();
    ops.end("a", 0, "discussed the timeout path\nStatus: PASS\n");
    supervisor.tick();
    expect(supervisor.unit("a")?.state).toBe("done");
  });
});

describe("hard timeout and aborts", () => {
  it("kills a timed-out worker group, requeues once, then fails the unit", () => {
    const { ops, supervisor, config } = boot({ "a.md": OPEN });
    supervisor.tick();
    const first = ops.spawns[0];
    expect(first).toBeDefined();
    ops.clock += config.timeoutMs + 1;
    supervisor.tick();
    expect(ops.signals).toContainEqual({ pgid: first?.pid, signal: "SIGTERM" });
    expect(supervisor.unit("a")?.state).toBe("killing");

    ops.alive.delete(first?.pid ?? -1);
    supervisor.tick();
    expect(supervisor.unit("a")?.attempts).toBe(2);
    expect(ops.spawns.length).toBe(2);

    ops.clock += config.timeoutMs + 1;
    supervisor.tick();
    const second = ops.spawns[1];
    ops.alive.delete(second?.pid ?? -1);
    supervisor.tick();
    expect(supervisor.unit("a")?.state).toBe("failed");
    expect(supervisor.unit("a")?.error).toBe("hard timeout");
    expect(ops.spawns.length).toBe(2);
  });

  it("escalates to SIGKILL when a killed worker survives the grace period", () => {
    const { ops, supervisor, config } = boot({ "a.md": OPEN });
    supervisor.tick();
    const pid = ops.spawns[0]?.pid ?? 0;
    ops.clock += config.timeoutMs + 1;
    supervisor.tick();
    ops.clock += KILL_GRACE_MS + 1;
    supervisor.tick();
    expect(ops.signals).toContainEqual({ pgid: pid, signal: "SIGKILL" });
  });

  it("aborts a single unit through its abort marker without relaunching it", () => {
    const { ops, supervisor, config } = boot(
      { "a.md": OPEN, "b.md": OPEN },
      { lanes: [{ name: "fast", model: "p/fast", cap: 1 }] },
    );
    supervisor.tick();
    fs.writeFileSync(unitPaths(config.poolDir, "a").abort, "abort\n");
    supervisor.tick();
    ops.alive.clear();
    supervisor.tick();
    expect(supervisor.unit("a")?.state).toBe("failed");
    expect(supervisor.unit("a")?.error).toBe("aborted");
    expect(fs.existsSync(unitPaths(config.poolDir, "a").abort)).toBe(false);
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a", "b"]);
  });

  it("stops every worker and marks the units aborted when the stop file appears", () => {
    const { ops, supervisor, config } = boot({ "a.md": OPEN, "b.md": OPEN });
    supervisor.tick();
    fs.writeFileSync(stopFileFor(config.poolDir), "stop\n");
    expect(supervisor.tick()).toBe(false);
    expect(supervisor.poolStatus()).toBe("stopped");
    expect(ops.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGTERM"]);
    expect(supervisor.unit("a")?.error).toBe("aborted");
    expect(readUnit(config.poolDir, "b")?.state).toBe("failed");
  });
});

describe("restart adoption", () => {
  it("adopts a live worker from an earlier supervisor instead of spawning a second one", () => {
    const env = setup({ "a.md": OPEN });
    fs.mkdirSync(env.config.poolDir, { recursive: true });
    writeUnit(env.config.poolDir, {
      key: "a",
      file: path.join(env.unitsDir, "a.md"),
      names: [],
      lane: "fast",
      state: "running",
      attempts: 1,
      timeouts: 0,
      limitHits: 0,
      pid: 555,
      pgid: 555,
      started: START - 10_000,
      finished: null,
      killedAt: null,
      exitCode: null,
      error: null,
    });
    const ops = new FakeOps();
    ops.alive.add(555);
    const supervisor = new PoolSupervisor(env.config, ops, 4242);
    supervisor.load(scanUnits(env.config.unitsGlob));
    supervisor.tick();
    expect(ops.spawns).toEqual([]);
    expect(supervisor.unit("a")?.state).toBe("running");

    ops.alive.delete(555);
    fs.writeFileSync(unitPaths(env.config.poolDir, "a").exit, "0\n");
    supervisor.tick();
    expect(supervisor.unit("a")?.state).toBe("done");
  });

  it("requeues a unit whose worker vanished without an exit code", () => {
    const env = setup({ "a.md": OPEN });
    fs.mkdirSync(env.config.poolDir, { recursive: true });
    writeUnit(env.config.poolDir, {
      key: "a",
      file: path.join(env.unitsDir, "a.md"),
      names: [],
      lane: "fast",
      state: "running",
      attempts: 1,
      timeouts: 0,
      limitHits: 0,
      pid: 777,
      pgid: 777,
      started: START,
      finished: null,
      killedAt: null,
      exitCode: null,
      error: null,
    });
    const ops = new FakeOps();
    const supervisor = new PoolSupervisor(env.config, ops, 4242);
    supervisor.load(scanUnits(env.config.unitsGlob));
    supervisor.tick();
    expect(ops.spawns.map((entry) => entry.key)).toEqual(["a"]);
    expect(supervisor.unit("a")?.attempts).toBe(2);
  });
});

describe("run store mirror", () => {
  it("publishes each unit as a pool run so list_runs and abort_all see it", () => {
    const { ops, supervisor, config } = boot({ "a.md": OPEN });
    supervisor.tick();
    const record = new RunStore(config.runsDir).get(unitRecordId(POOL_ID, "a")) as RunRecord | null;
    expect(record?.status).toBe("running");
    expect(record?.pool).toBe(POOL_ID);
    expect(record?.pid).toBe(ops.spawns[0]?.pid);
    ops.end("a", 0);
    supervisor.tick();
    expect(new RunStore(config.runsDir).get(unitRecordId(POOL_ID, "a"))?.status).toBe("done");
  });
});
