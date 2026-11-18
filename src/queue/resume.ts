import fs from "node:fs";
import { createRequire } from "node:module";
import { BridgeError } from "../errors.js";
import { defaultOpencodeDb } from "../usage/stats.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SQLITE_CLI_TIMEOUT_MS = 5_000;

/**
 * argv for resuming a pool unit's OpenCode session with one message. The message is a single
 * argv entry after `--`, so it is never parsed as a flag and never goes through a shell.
 */
export function buildResumeArgs(input: {
  model: string;
  sessionId: string;
  text: string;
}): string[] {
  if (!SESSION_ID_PATTERN.test(input.sessionId)) {
    throw new BridgeError("INVALID_ARGUMENT", "session id has an invalid format.");
  }
  return [
    "run",
    "--session",
    input.sessionId,
    "--auto",
    "-m",
    input.model,
    "--format",
    "json",
    "--",
    input.text,
  ];
}

const requireModule = createRequire(import.meta.url);

/**
 * Newest OpenCode session whose title is one of `titles`, read-only. Uses node:sqlite when the
 * runtime has it and the sqlite3 CLI in -readonly mode otherwise. Any failure yields null.
 */
export function findSessionIdByTitle(
  titles: string[],
  dbPath: string = defaultOpencodeDb(),
): string | null {
  if (titles.length === 0 || !fs.existsSync(dbPath)) return null;
  const list = titles.map((title) => `'${title.replace(/'/g, "''")}'`).join(",");
  const sql = `SELECT id FROM session WHERE title IN (${list}) ORDER BY rowid DESC LIMIT 1`;
  try {
    const sqlite = requireModule("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(sql).get() as { id?: unknown } | undefined;
      return typeof row?.id === "string" && SESSION_ID_PATTERN.test(row.id) ? row.id : null;
    } finally {
      db.close();
    }
  } catch {
    // Fall through to the CLI when node:sqlite is missing or the open failed.
  }
  try {
    // Leaves the title list as the only dynamic text; titles are quoted above.
    const { execFileSync } = requireModule(
      "node:child_process",
    ) as typeof import("node:child_process");
    const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      timeout: SQLITE_CLI_TIMEOUT_MS,
    });
    const rows = JSON.parse(out.trim() || "[]") as Array<{ id?: unknown }>;
    const id = rows[0]?.id;
    return typeof id === "string" && SESSION_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Titles the pool launcher and older pool runs gave a unit's OpenCode session. */
export function unitSessionTitles(key: string): string[] {
  return [`pool ${key}`, `pool:${key}`];
}
