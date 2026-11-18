import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { followEvents, runEventsCommand } from "../../src/events/follow.js";
import {
  appendEvent,
  eventsFileForPool,
  eventsFileForRun,
  readEventsFrom,
  summarizeEvent,
  waitForEvents,
} from "../../src/events/log.js";
import { poolDirFor } from "../../src/pool/state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRuns(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-events-"));
  dirs.push(dir);
  return dir;
}

describe("event log", () => {
  it("reads complete lines only and resumes from the returned offset", () => {
    const file = path.join(tempRuns(), "e.jsonl");
    appendEvent(file, "unit_started", { key: "a" });
    fs.appendFileSync(file, '{"type":"partial"');
    const first = readEventsFrom(file, 0);
    expect(first.events.map((event) => event.type)).toEqual(["unit_started"]);
    fs.appendFileSync(file, ',"x":1}\n');
    const second = readEventsFrom(file, first.offset);
    expect(second.events.map((event) => event.type)).toEqual(["partial"]);
  });

  it("summarizes one human line per event", () => {
    const line = summarizeEvent({ at: 0, type: "unit_failed", key: "a", error: "exit 1" });
    expect(line).toMatch(/^\d\d:\d\d:\d\d failed a: exit 1$/);
  });

  it("waits for a matching event that arrives after the call", async () => {
    const file = eventsFileForPool(poolDirFor(tempRuns(), "p1"));
    appendEvent(file, "unit_started", { key: "a" });
    const waiting = waitForEvents(file, { until: "any_finished", timeoutMs: 5_000, pollMs: 20 });
    setTimeout(() => appendEvent(file, "unit_done", { key: "a" }), 60);
    const result = await waiting;
    expect(result.timed_out).toBe(false);
    expect(result.events.map((event) => event.type)).toEqual(["unit_done"]);
  });

  it("times out when no matching event arrives", async () => {
    const result = await waitForEvents(path.join(tempRuns(), "none.jsonl"), {
      until: "all_done",
      timeoutMs: 50,
      pollMs: 10,
    });
    expect(result.timed_out).toBe(true);
  });
});

describe("events command", () => {
  it("follows a pool end to end and stops at pool_done", async () => {
    const runs = tempRuns();
    const file = eventsFileForPool(poolDirFor(runs, "p1"));
    appendEvent(file, "unit_started", { key: "a", lane: "fast" });
    appendEvent(file, "unit_done", { key: "a" });
    appendEvent(file, "pool_done", { total: 1, done: 1, failed: 0 });
    const lines: string[] = [];
    const code = await runEventsCommand({ pool: "p1", runsDir: runs, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.map((line) => line.slice(9))).toEqual([
      "started a on fast",
      "done a",
      "pool done: 1 done, 0 failed",
    ]);
  });

  it("follows a single run and stops at run_done", async () => {
    const runs = tempRuns();
    appendEvent(eventsFileForRun(runs, "r1"), "run_started", { run_id: "r1", attempt: 1 });
    appendEvent(eventsFileForRun(runs, "r1"), "run_done", { run_id: "r1", status: "done" });
    const lines: string[] = [];
    const code = await runEventsCommand({ run: "r1", runsDir: runs, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.map((line) => line.slice(9))).toEqual(["run r1 started", "run r1 done"]);
  });

  it("prints a heartbeat while nothing finishes and stops on abort", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const running = followEvents({
      file: path.join(tempRuns(), "quiet.jsonl"),
      snapshot: () => "running=1",
      out: (line) => lines.push(line),
      pollMs: 10,
      heartbeatMs: 30,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    expect(await running).toBe(130);
    expect(lines.some((line) => line.includes("heartbeat running=1"))).toBe(true);
  });

  it("rejects missing, ambiguous or unsafe ids with exit code 2", async () => {
    const runs = tempRuns();
    const out = () => undefined;
    expect(await runEventsCommand({ runsDir: runs, out })).toBe(2);
    expect(await runEventsCommand({ pool: "a", run: "b", runsDir: runs, out })).toBe(2);
    expect(await runEventsCommand({ pool: "../x", runsDir: runs, out })).toBe(2);
  });
});
