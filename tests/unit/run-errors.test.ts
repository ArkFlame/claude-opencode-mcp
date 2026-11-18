import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifySqlite,
  extractErrorLine,
  isSqliteKind,
  runErrorKind,
} from "../../src/runs/errors.js";
import { findLowDisk, minFreeMb, opencodeDataDir } from "../../src/util/disk.js";

const OPAQUE =
  '{"type":"error","error":{"name":"UnknownError","data":{"message":"Failed to execute statement"}}}';

describe("sqlite classification", () => {
  it("maps the opaque opencode message to sqlite_other", () => {
    expect(classifySqlite(OPAQUE)).toBe("sqlite_other");
  });

  it("maps full-disk wording to sqlite_full", () => {
    expect(classifySqlite("SQLITE_FULL: database or disk is full")).toBe("sqlite_full");
    expect(classifySqlite("write failed: ENOSPC")).toBe("sqlite_full");
  });

  it("maps lock wording to sqlite_busy", () => {
    expect(classifySqlite("SQLITE_BUSY: database is locked")).toBe("sqlite_busy");
  });

  it("returns null for ordinary provider errors", () => {
    expect(classifySqlite("usage limit reached")).toBeNull();
    expect(isSqliteKind(null)).toBe(false);
    expect(isSqliteKind("timeout")).toBe(false);
    expect(isSqliteKind("sqlite_busy")).toBe(true);
  });

  it("extracts the raw error line from a log", () => {
    const log = `{"type":"step_start"}\n${OPAQUE}\n`;
    expect(extractErrorLine(log)).toBe(OPAQUE);
    expect(extractErrorLine('{"type":"text"}')).toBeNull();
  });

  it("derives error_kind from the end reason first", () => {
    expect(runErrorKind({ end: "exit", exitCode: 1, rawError: OPAQUE, done: false })).toBe(
      "sqlite_other",
    );
    expect(runErrorKind({ end: "timeout", exitCode: null, rawError: OPAQUE, done: false })).toBe(
      "timeout",
    );
    expect(runErrorKind({ end: "exit", exitCode: 1, rawError: null, done: false })).toBe("exit");
    expect(runErrorKind({ end: "exit", exitCode: 0, rawError: null, done: true })).toBeNull();
  });
});

describe("disk preflight", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a path whose free space is below the floor and names it", () => {
    const low = findLowDisk(["/a", "/b"], 1024, (target) => (target === "/b" ? 10 : 9_000));
    expect(low).toEqual({ path: "/b", free_mb: 10, min_free_mb: 1024 });
  });

  it("treats unknown free space as not low", () => {
    expect(findLowDisk(["/x"], 1024, () => null)).toBeNull();
  });

  it("reads the floor from the environment with a 1024 MB default", () => {
    expect(minFreeMb({})).toBe(1024);
    expect(minFreeMb({ CLAUDE_OPENCODE_MIN_FREE_MB: "256" })).toBe(256);
    expect(minFreeMb({ CLAUDE_OPENCODE_MIN_FREE_MB: "nope" })).toBe(1024);
  });

  it("places the opencode data dir under XDG_DATA_HOME", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xdg-"));
    dirs.push(root);
    expect(opencodeDataDir({ XDG_DATA_HOME: root })).toBe(path.join(root, "opencode"));
  });
});
