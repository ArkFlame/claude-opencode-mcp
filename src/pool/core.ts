/** Pure scheduling rules for pool mode. No I/O here: everything is unit-tested with plain values. */

/** Names too common to mean a conflict on their own; they are capped by per_file_cap instead. */
export const GENERIC_RS_NAMES: ReadonlySet<string> = new Set([
  "mod.rs",
  "lib.rs",
  "main.rs",
  "tests.rs",
  "registry.rs",
]);

/** A .rs file named by this many open units is a hub: capped by per_file_cap, not exclusive. */
export const HUB_THRESHOLD = 8;
export const PER_FILE_CAP_DEFAULT = 2;
export const LIMIT_BACKOFF_MS = 120_000;
export const CONSECUTIVE_LIMIT_STOP = 6;
/** Sqlite failures in a row (no success between) that stop the pool. */
export const SQLITE_CONSECUTIVE_STOP = 6;
/** Successes needed to give back one slot taken by sqlite failures. */
export const SQLITE_RESTORE_AFTER = 5;
/** Requeue delay after a sqlite failure, multiplied by the unit's retry count. */
export const SQLITE_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const STALE_LOG_MS = 300_000;
export const RATE_WINDOW_MS = 600_000;
export const KILL_GRACE_MS = 5_000;
/** A unit lost without an exit code (supervisor restarted, process vanished) gets this many attempts. */
export const MAX_LOST_ATTEMPTS = 3;
/** One requeue after a hard timeout; the second timeout fails the unit. */
export const MAX_TIMEOUTS = 2;

/** Log-tail markers of provider limits and transient failures. Matches the spec list exactly. */
export const LIMIT_PATTERN =
  /usage limit|Insufficient balance|rate limit|429|timed out|timeout|tier_limit_exceeded|concurrency limit|rpm limit|Provider blocked/i;

const RS_NAME_PATTERN = /\b[A-Za-z0-9_]+\.rs\b/g;
const STATUS_LINE_PATTERN = /^Status:\s*(PASS|UNVERIFIED|BLOCKED|FAILED)\b/m;

export function rsNamesIn(text: string): Set<string> {
  return new Set(text.match(RS_NAME_PATTERN) ?? []);
}

/** Names that appear in at least `threshold` units. */
export function hubNames(
  unitNames: Iterable<ReadonlySet<string>>,
  threshold = HUB_THRESHOLD,
): Set<string> {
  const counts = new Map<string, number>();
  for (const names of unitNames) {
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const hubs = new Set<string>();
  for (const [name, count] of counts) if (count >= threshold) hubs.add(name);
  return hubs;
}

export interface RunningUnit {
  key: string;
  names: ReadonlySet<string>;
}

/**
 * Two units never run together when they share an exclusive .rs name. Generic and hub names
 * allow sharing up to perFileCap concurrent units.
 */
export function canStart(
  names: ReadonlySet<string>,
  running: readonly RunningUnit[],
  hubs: ReadonlySet<string>,
  perFileCap: number,
): boolean {
  for (const name of names) {
    const capped = GENERIC_RS_NAMES.has(name) || hubs.has(name);
    let sharing = 0;
    for (const unit of running) if (unit.names.has(name)) sharing += 1;
    if (capped) {
      if (sharing >= perFileCap) return false;
    } else if (sharing > 0) {
      return false;
    }
  }
  return true;
}

export interface LaneState {
  name: string;
  model: string;
  /** Configured cap. */
  cap: number;
  /** Cap after limit penalties; never below 0. */
  effectiveCap: number;
  hits: number;
  backoffUntil: number;
  /** Slots taken off by sqlite failures that a later success may give back. */
  sqliteShrink: number;
}

/** First lane (in config order) with a free slot that is not backing off. */
export function pickLane(
  lanes: readonly LaneState[],
  busy: ReadonlyMap<string, number>,
  now: number,
): LaneState | null {
  for (const lane of lanes) {
    if ((busy.get(lane.name) ?? 0) < lane.effectiveCap && now >= lane.backoffUntil) return lane;
  }
  return null;
}

/** Shrink the lane by one slot and back off 120 s times the lane's hit count. */
export function applyLimitHit(lane: LaneState, now: number): void {
  lane.hits += 1;
  lane.effectiveCap = Math.max(0, lane.effectiveCap - 1);
  lane.backoffUntil = now + LIMIT_BACKOFF_MS * lane.hits;
}

export function isLimitTail(tail: string): boolean {
  return LIMIT_PATTERN.test(tail);
}

export function hasStatusLine(tail: string): boolean {
  return STATUS_LINE_PATTERN.test(tail);
}

/** A limit marker only counts against a run that did not finish with its own Status line. */
export function isLimitFailure(exitCode: number | null, tail: string): boolean {
  return isLimitTail(tail) && (exitCode !== 0 || !hasStatusLine(tail));
}

export function isStale(lastActivityMs: number, now: number): boolean {
  return now - lastActivityMs > STALE_LOG_MS;
}

export function etaFor(
  open: number,
  finishTimes: readonly number[],
  now: number,
): { perMinute: number; etaMinutes: number | null } {
  const recent = finishTimes.filter((at) => at <= now && now - at <= RATE_WINDOW_MS).length;
  const perMinute = recent / (RATE_WINDOW_MS / 60_000);
  if (open === 0) return { perMinute, etaMinutes: 0 };
  return { perMinute, etaMinutes: perMinute > 0 ? open / perMinute : null };
}

export function renderBrief(
  template: string,
  vars: { path: string; name: string; key: string },
): string {
  return template
    .replaceAll("{{UNIT_PATH}}", vars.path)
    .replaceAll("{{UNIT_NAME}}", vars.name)
    .replaceAll("{{UNIT_KEY}}", vars.key);
}

/** Stable unit key from a file name: no extension, safe characters only, bounded length. */
export function unitKeyOf(file: string): string {
  const base = file.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const key = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return key || "unit";
}
