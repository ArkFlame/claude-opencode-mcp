/**
 * Failure classification shared by single runs and pool units. Pure functions, no I/O.
 *
 * `sqlite_*` kinds come from the opencode CLI's "Failed to execute statement" error. The bridge
 * only sees that opaque message, so the kind is a best guess from words such as SQLITE_FULL or
 * ENOSPC; the raw message is kept next to it for inspection.
 */

export const SQLITE_KINDS = ["sqlite_full", "sqlite_busy", "sqlite_other"] as const;
export type SqliteKind = (typeof SQLITE_KINDS)[number];

export type ErrorKind =
  | SqliteKind
  | "timeout"
  | "idle"
  | "aborted"
  | "spawn"
  | "exit"
  | "worker_lost"
  | "unknown";

const FULL_PATTERN = /SQLITE_FULL|ENOSPC|disk full|database or disk is full|no space left/i;
const BUSY_PATTERN =
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|\bbusy\b/i;
const OTHER_PATTERN = /Failed to execute statement|SQLITE_[A-Z_]+|\bsqlite\b/i;
const RAW_LINE_MAX = 500;

/** Classify opencode error text as a sqlite failure, or null when it is not one. */
export function classifySqlite(text: string): SqliteKind | null {
  if (FULL_PATTERN.test(text)) return "sqlite_full";
  if (BUSY_PATTERN.test(text)) return "sqlite_busy";
  if (OTHER_PATTERN.test(text)) return "sqlite_other";
  return null;
}

export function isSqliteKind(kind: string | null | undefined): kind is SqliteKind {
  return typeof kind === "string" && (SQLITE_KINDS as readonly string[]).includes(kind);
}

/** The last log line that carries a sqlite or disk error, bounded. Null when none does. */
export function extractErrorLine(text: string): string | null {
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    if (classifySqlite(line) !== null) return line.trim().slice(0, RAW_LINE_MAX);
  }
  return null;
}

/** error_kind for a finished run, from its end reason and raw error text. */
export function runErrorKind(input: {
  end: "exit" | "timeout" | "idle" | "aborted" | "spawn-error";
  exitCode: number | null;
  rawError: string | null;
  done: boolean;
}): ErrorKind | null {
  if (input.done) return null;
  if (input.end === "aborted") return "aborted";
  if (input.end === "timeout") return "timeout";
  if (input.end === "idle") return "idle";
  if (input.end === "spawn-error") return "spawn";
  const sqlite = input.rawError ? classifySqlite(input.rawError) : null;
  if (sqlite) return sqlite;
  if (input.exitCode === null) return "unknown";
  return input.exitCode === 0 ? "unknown" : "exit";
}
