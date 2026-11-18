import fs from "node:fs";
import path from "node:path";

/**
 * Append-only JSONL event logs for pools (`<pool>/events.jsonl`) and single runs
 * (`<runs>/events/<id>.jsonl`). Writers are best effort; readers take complete lines only.
 */

export const EVENTS_FILE = "events.jsonl";
const READ_CHUNK_MAX = 1_048_576;
const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["pool_done", "pool_stopped", "run_done"]);

export interface EventRecord {
  at: number;
  type: string;
  [key: string]: unknown;
}

export type EventWaitUntil = "any_finished" | "all_done" | "failure" | "stale";

const WAIT_MATCHES: Record<EventWaitUntil, ReadonlySet<string>> = {
  any_finished: new Set(["unit_done", "unit_failed"]),
  all_done: new Set(["pool_done"]),
  failure: new Set(["unit_failed"]),
  stale: new Set(["stale"]),
};

export function eventsFileForPool(poolDir: string): string {
  return path.join(poolDir, EVENTS_FILE);
}

export function eventsFileForRun(runsDir: string, runId: string): string {
  return path.join(runsDir, "events", `${runId}.jsonl`);
}

/** Append one event. Failures are swallowed: monitoring must never fail the run or pool. */
export function appendEvent(file: string, type: string, data: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), type, ...data })}\n`);
  } catch {
    // Best effort by design: the emitting run or pool keeps going.
  }
}

export function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENTS.has(type);
}

function parseEvent(line: string): EventRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<EventRecord>;
    return typeof record.type === "string" ? (record as EventRecord) : null;
  } catch {
    return null;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Complete events after byte `offset`, and the offset just past the last complete line. */
export function readEventsFrom(
  file: string,
  offset: number,
): { events: EventRecord[]; offset: number } {
  const size = sizeOf(file);
  if (size < offset) return { events: [], offset: 0 };
  if (size === offset) return { events: [], offset };
  const length = Math.min(size - offset, READ_CHUNK_MAX);
  const buffer = Buffer.alloc(length);
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, length, offset);
  } catch {
    return { events: [], offset };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return { events: [], offset };
  const events: EventRecord[] = [];
  for (const line of buffer.subarray(0, lastNewline).toString("utf8").split("\n")) {
    const event = parseEvent(line);
    if (event) events.push(event);
  }
  return { events, offset: offset + lastNewline + 1 };
}

function text(value: unknown): string {
  return value === undefined || value === null ? "?" : String(value);
}

function describe(event: EventRecord): string {
  switch (event.type) {
    case "unit_started":
      return `started ${text(event.key)} on ${text(event.lane)}`;
    case "unit_done":
      return `done ${text(event.key)}`;
    case "unit_failed":
      return `failed ${text(event.key)}: ${text(event.error ?? event.error_kind)}`;
    case "unit_requeued":
      return `requeued ${text(event.key)}: ${text(event.reason)}`;
    case "stale":
      return `stale ${text(event.key)}: silent ${text(event.idle_seconds)}s`;
    case "lane_cap_changed":
      return `lane ${text(event.lane)} cap ${text(event.from)} -> ${text(event.to)} (${text(event.reason)})`;
    case "pool_done":
      return `pool done: ${text(event.done)} done, ${text(event.failed)} failed`;
    case "pool_stopped":
      return `pool stopped: ${text(event.reason)}`;
    case "run_started":
      return `run ${text(event.run_id)} started`;
    case "run_done":
      return `run ${text(event.run_id)} ${text(event.status)}${event.error ? `: ${text(event.error)}` : ""}`;
    default:
      return event.type;
  }
}

/** One human line per event, with a UTC clock. */
export function summarizeEvent(event: EventRecord): string {
  return `${new Date(event.at).toISOString().slice(11, 19)} ${describe(event)}`;
}

/** Shell command that streams a pool's or run's events, for Claude Code's Monitor tool. */
export function monitorCommandFor(kind: "pool" | "run", id: string): string {
  const entry = path.resolve(process.argv[1] ?? "claude-opencode-mcp");
  return `node ${JSON.stringify(entry)} events --${kind} ${id}`;
}

/**
 * Block (async, bounded) until an event matching `until` arrives after `since`, or the timeout
 * passes. Without `since` the wait starts at the current end of the file, so only new events count.
 */
export async function waitForEvents(
  file: string,
  options: { until: EventWaitUntil; since?: number; timeoutMs: number; pollMs?: number },
): Promise<{ events: EventRecord[]; cursor: number; timed_out: boolean }> {
  const matches = WAIT_MATCHES[options.until];
  const deadline = Date.now() + options.timeoutMs;
  let cursor = options.since ?? sizeOf(file);
  const collected: EventRecord[] = [];
  for (;;) {
    const read = readEventsFrom(file, cursor);
    cursor = read.offset;
    collected.push(...read.events);
    if (collected.some((event) => matches.has(event.type))) {
      return { events: collected, cursor, timed_out: false };
    }
    if (Date.now() >= deadline) return { events: collected, cursor, timed_out: true };
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1_000));
  }
}
