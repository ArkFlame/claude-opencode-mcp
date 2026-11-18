import { execFile } from "node:child_process";
import fs from "node:fs";
import { boundText, summarizeFinal } from "./output.js";
import type { RunRecord } from "./store.js";

const LOG_TAIL_BYTES = 4 * 1024;
const GIT_TIMEOUT_MS = 20_000;

function seconds(ms: number | null | undefined): number | null {
  return typeof ms === "number" ? Math.max(0, Math.round(ms / 1000)) : null;
}

/** One compact row for list_runs. */
export function runRow(
  record: RunRecord,
  now = Date.now(),
  queuedMessages = 0,
): Record<string, unknown> {
  const running = record.status === "running" || record.status === "queued";
  return {
    run_id: record.id,
    name: record.name,
    status: record.status,
    age_seconds: seconds(now - record.created),
    idle_seconds: running && record.started !== null ? seconds(now - record.last_activity) : null,
    cwd: record.cwd,
    branch: record.branch,
    attempts: record.attempts,
    last_line: record.last_line,
    queued_messages: queuedMessages,
  };
}

/** Full view for get_run and for finished delegate results. Text is bounded to 16 KB. */
export function runDetail(
  record: RunRecord,
  now = Date.now(),
  queuedMessages = 0,
): Record<string, unknown> {
  const summary = summarizeFinal(record.final_text);
  const text = record.final_text ? boundText(record.final_text) : null;
  return {
    run_id: record.id,
    name: record.name,
    status: record.status,
    agent: record.agent,
    model: record.model,
    model_note: record.model_note,
    cwd: record.cwd,
    branch: record.branch,
    attempts: record.attempts,
    age_seconds: seconds(now - record.created),
    started_at: record.started ? new Date(record.started).toISOString() : null,
    finished_at: record.finished ? new Date(record.finished).toISOString() : null,
    exit_code: record.exit_code,
    signal: record.signal,
    error: record.error,
    final: {
      status_line: summary.status,
      commit: summary.commit,
      tests: summary.tests,
      text: text?.text ?? null,
      truncated: text?.truncated ?? false,
      original_bytes: text?.originalBytes ?? 0,
    },
    queued_messages: queuedMessages,
    log_path: record.log_file,
  };
}

export function readLogTail(file: string, bytes = LOG_TAIL_BYTES): string {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return boundText(buffer.toString("utf8"), bytes).text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  dirty_files: number;
  diff_stat: string;
}

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? null : String(stdout).trim());
      },
    );
  });
}

/** Branch, head, dirty count and diff stat of a run's cwd. Best effort: nulls when git fails. */
export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  const [branch, head, status, stat] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    git(["log", "-1", "--format=%h %s"], cwd),
    git(["status", "--porcelain"], cwd),
    git(["diff", "--stat", "HEAD"], cwd),
  ]);
  return {
    branch,
    head,
    dirty_files: status ? status.split("\n").filter(Boolean).length : 0,
    diff_stat: boundText(stat ?? "", 2_048).text,
  };
}
