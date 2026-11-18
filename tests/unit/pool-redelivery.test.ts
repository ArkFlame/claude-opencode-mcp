import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PoolConfig, poolDirFor, unitRecordId } from "../../src/pool/state.js";
import { PoolSupervisor, type SupervisorOps } from "../../src/pool/supervisor.js";
import { scanUnits } from "../../src/pool/units.js";
import { cancelMessage, enqueueMessage, inboxFileFor, readInbox } from "../../src/queue/inbox.js";

const dirs: string[] = [];
const MARKER = "STILL OPEN";
const POOL_ID = "abcdef0123";
const START = 1_000_000;
const SESSION = "ses_resume_1";

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
  sessions = new Map<string, string>();
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
  sessionOf(key: string): string | null {
    return this.sessions.get(key) ?? null;
  }
  /** The newest live worker for a key exits with a code. */
  end(key: string, exitCode: number): void {
    const spawn = this.spawns
      .filter((entry) => entry.key === key && this.alive.has(entry.pid))
      .at(-1);
    if (!spawn) throw new Error(`no live worker for ${key}`);
    fs.writeFileSync(spawn.logFile, "done\n");
    fs.writeFileSync(spawn.exitFile, `${exitCode}\n`);
    this.alive.delete(spawn.pid);
  }
  /** The process dies without writing an exit file (after a kill). */
  vanish(key: string): void {
    const spawn = this.spawns
      .filter((entry) => entry.key === key && this.alive.has(entry.pid))
      .at(-1);
    if (spawn) this.alive.delete(spawn.pid);
  }
}

function setup(units: Record<string, string>, overrides: Partial<PoolConfig> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cop-redeliver-"));
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
    forbid: ["git"],
    briefTemplate: "Work on {{UNIT_NAME}}.",
    runsDir,
    poolDir: poolDirFor(runsDir, POOL_ID),
    createdAt: START,
    ...overrides,
  };
  return { root, config };
}

function boot(
  units: Record<string, string>,
  overrides: Partial<PoolConfig> = {},
  options: { redeliverOnly?: boolean } = {},
) {
  const env = setup(units, overrides);
  const ops = new FakeOps();
  const supervisor = new PoolSupervisor(env.config, ops, 4242, options);
  supervisor.load(scanUnits(env.config.unitsGlob));
  return { ...env, ops, supervisor };
}

function inboxFor(config: PoolConfig, key: string): string {
  return inboxFileFor(config.runsDir, unitRecordId(config.id, key));
}

const OPEN = `# Unit\n${MARKER}\n`;

/** A fresh supervisor, as queue_message starts one when the pool has already finished. */
function restart(env: { config: PoolConfig }, ops: FakeOps, redeliverOnly = true): PoolSupervisor {
  const supervisor = new PoolSupervisor(env.config, ops, 4343, { redeliverOnly });
  supervisor.load(scanUnits(env.config.unitsGlob));
  return supervisor;
}

describe("message delivery to pool units", () => {
  it("wakes a finished unit and resumes its session with the queued message", () => {
    const env = boot({ "a.md": OPEN });
    const { config, ops } = env;
    ops.sessions.set("a", SESSION);
    env.supervisor.tick();
    ops.end("a", 0);
    expect(env.supervisor.tick()).toBe(false);
    expect(env.supervisor.unit("a")?.state).toBe("done");

    enqueueMessage(inboxFor(config, "a"), { text: "also fix the tests", now: START });
    const supervisor = restart(env, ops);
    supervisor.tick();

    expect(ops.spawns).toHaveLength(2);
    expect(ops.spawns[1]?.args.slice(0, 3)).toEqual(["run", "--session", SESSION]);
    expect(ops.spawns[1]?.args.at(-1)).toBe("also fix the tests");
    expect(supervisor.unit("a")?.state).toBe("running");

    ops.end("a", 0);
    supervisor.tick();
    const [message] = readInbox(inboxFor(config, "a"));
    expect(message?.status).toBe("delivered");
    expect(supervisor.unit("a")?.state).toBe("done");
  });

  it("delivers queued messages one at a time in arrival order, each after the previous exits", () => {
    const { config, ops, supervisor } = boot({ "a.md": OPEN });
    ops.sessions.set("a", SESSION);
    supervisor.tick();
    enqueueMessage(inboxFor(config, "a"), { text: "first", now: START });
    enqueueMessage(inboxFor(config, "a"), { text: "second", now: START + 1 });
    supervisor.tick();
    expect(ops.spawns).toHaveLength(1);
    ops.end("a", 0);
    supervisor.tick();
    supervisor.tick();
    expect(ops.spawns.at(-1)?.args.at(-1)).toBe("first");
    expect(ops.spawns).toHaveLength(2);
    ops.end("a", 0);
    supervisor.tick();
    supervisor.tick();
    expect(ops.spawns.at(-1)?.args.at(-1)).toBe("second");
    ops.end("a", 0);
    expect(supervisor.tick()).toBe(false);
    expect(readInbox(inboxFor(config, "a")).map((message) => message.status)).toEqual([
      "delivered",
      "delivered",
    ]);
  });

  it("interrupts a running unit for a now message and redelivers right after the kill", () => {
    const { config, ops, supervisor } = boot({ "a.md": OPEN });
    ops.sessions.set("a", SESSION);
    supervisor.tick();
    expect(supervisor.unit("a")?.state).toBe("running");
    enqueueMessage(inboxFor(config, "a"), { text: "stop and report", mode: "now", now: START });

    supervisor.tick();
    expect(ops.signals).toEqual([{ pgid: 100, signal: "SIGTERM" }]);
    expect(supervisor.unit("a")?.state).toBe("killing");

    ops.vanish("a");
    supervisor.tick();
    expect(ops.spawns).toHaveLength(2);
    expect(ops.spawns[1]?.args.slice(0, 3)).toEqual(["run", "--session", SESSION]);
    expect(ops.spawns[1]?.args.at(-1)).toBe("stop and report");
    const [message] = readInbox(inboxFor(config, "a"));
    expect(message?.attempts).toBe(1);
    expect(message?.in_flight).toBe(true);
  });

  it("fails a message after three delivery attempts", () => {
    const env = boot({ "a.md": OPEN });
    const { config, ops } = env;
    ops.sessions.set("a", SESSION);
    env.supervisor.tick();
    ops.end("a", 0);
    env.supervisor.tick();
    enqueueMessage(inboxFor(config, "a"), { text: "retry me", now: START });

    const supervisor = restart(env, ops);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      supervisor.tick();
      ops.end("a", 1);
      supervisor.tick();
    }
    const [message] = readInbox(inboxFor(config, "a"));
    expect(message?.status).toBe("failed");
    expect(message?.attempts).toBe(3);
    const launched = ops.spawns.length;
    supervisor.tick();
    expect(ops.spawns).toHaveLength(launched);
  });

  it("does not deliver a cancelled message", () => {
    const env = boot({ "a.md": OPEN });
    const { config, ops } = env;
    ops.sessions.set("a", SESSION);
    env.supervisor.tick();
    ops.end("a", 0);
    env.supervisor.tick();
    const { message } = enqueueMessage(inboxFor(config, "a"), { text: "never", now: START });
    cancelMessage(inboxFor(config, "a"), message.id);
    restart(env, ops).tick();
    expect(ops.spawns).toHaveLength(1);
    expect(env.supervisor.unit("a")?.state).toBe("done");
  });

  it("serves redelivery ahead of fresh units and still respects the lane cap", () => {
    const env = boot(
      { "a.md": OPEN, "b.md": OPEN, "c.md": OPEN },
      { lanes: [{ name: "fast", model: "p/fast", cap: 1 }] },
    );
    const { config, ops, supervisor } = env;
    ops.sessions.set("a", SESSION);
    supervisor.tick();
    ops.end("a", 0);
    supervisor.tick();
    expect(supervisor.unit("b")?.state).toBe("running");
    expect(supervisor.unit("c")?.state).toBe("queued");

    enqueueMessage(inboxFor(config, "a"), { text: "for a", now: START });
    ops.end("b", 0);
    supervisor.tick();
    expect(ops.spawns.at(-1)?.key).toBe("a");
    expect(ops.spawns.at(-1)?.args.at(-1)).toBe("for a");
    expect(supervisor.unit("c")?.state).toBe("queued");
  });

  it("fails messages to a unit whose session cannot be found instead of rerunning its brief", () => {
    const env = boot({ "a.md": OPEN });
    const { config, ops } = env;
    env.supervisor.tick();
    ops.end("a", 0);
    env.supervisor.tick();
    enqueueMessage(inboxFor(config, "a"), { text: "lost session", now: START });
    restart(env, ops).tick();
    expect(ops.spawns).toHaveLength(1);
    const [message] = readInbox(inboxFor(config, "a"));
    expect(message?.status).toBe("failed");
    expect(message?.last_error).toMatch(/session not found/);
  });

  it("redeliver-only restarts launch only units with messages, never a stopped pool's others", () => {
    const env = boot({ "a.md": OPEN, "b.md": OPEN });
    const { config, ops } = env;
    ops.sessions.set("a", SESSION);
    env.supervisor.tick();
    ops.end("a", 0);
    ops.end("b", 0);
    env.supervisor.tick();
    expect(env.supervisor.unit("b")?.state).toBe("done");

    enqueueMessage(inboxFor(config, "a"), { text: "only a", now: START });
    const before = ops.spawns.length;
    const restarted = restart(env, ops);
    restarted.tick();
    expect(ops.spawns.slice(before).map((entry) => entry.key)).toEqual(["a"]);
    expect(restarted.unit("b")?.state).toBe("done");
  });
});
