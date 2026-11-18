import { poolDirFor } from "../pool/state.js";
import { buildPoolStatus } from "../pool/status.js";
import { RunStore } from "../runs/store.js";
import {
  eventsFileForPool,
  eventsFileForRun,
  isTerminalEvent,
  readEventsFrom,
  summarizeEvent,
} from "./log.js";

export const HEARTBEAT_MS = 60_000;
const POLL_MS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export interface FollowOptions {
  file: string;
  /** Body of a heartbeat line: counts that show the watched work is still alive. */
  snapshot: () => string;
  out: (line: string) => void;
  pollMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}

/**
 * Print each event as it lands and return 0 at the first terminal event (pool_done, pool_stopped
 * or run_done). A heartbeat line every minute says the watch is alive while nothing finishes.
 */
export async function followEvents(options: FollowOptions): Promise<number> {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  let offset = 0;
  let lastBeat = Date.now();
  for (;;) {
    if (options.signal?.aborted) return 130;
    const read = readEventsFrom(options.file, offset);
    offset = read.offset;
    for (const event of read.events) {
      options.out(summarizeEvent(event));
      if (isTerminalEvent(event.type)) return 0;
    }
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now();
      options.out(
        `${new Date(lastBeat).toISOString().slice(11, 19)} heartbeat ${options.snapshot()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
  }
}

export interface EventsCommandOptions {
  pool?: string | undefined;
  run?: string | undefined;
  runsDir: string;
  out?: (line: string) => void;
  signal?: AbortSignal;
}

/** The `events` subcommand: follow one pool or one run until it finishes. Exit code 2 on bad input. */
export async function runEventsCommand(options: EventsCommandOptions): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (Boolean(options.pool) === Boolean(options.run)) {
    process.stderr.write("events needs exactly one of --pool <id> or --run <id>\n");
    return 2;
  }
  const id = options.pool ?? options.run ?? "";
  if (!ID_PATTERN.test(id)) {
    process.stderr.write(`invalid id: ${id}\n`);
    return 2;
  }
  const base = {
    out,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (options.pool) {
    const poolDir = poolDirFor(options.runsDir, id);
    return followEvents({
      ...base,
      file: eventsFileForPool(poolDir),
      snapshot: () => poolSnapshot(poolDir),
    });
  }
  const store = new RunStore(options.runsDir);
  return followEvents({
    ...base,
    file: eventsFileForRun(options.runsDir, id),
    snapshot: () => `status=${store.get(id)?.status ?? "unknown"}`,
  });
}

function poolSnapshot(poolDir: string): string {
  const view = buildPoolStatus(poolDir);
  const { running, queued, done, failed } = view.counts;
  return `running=${running} queued=${queued} done=${done} failed=${failed} stale=${view.stale_workers.length} status=${view.status}`;
}
