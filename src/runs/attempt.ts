import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { stripAnsi } from "../util/text.js";
import { killProcessGroup } from "./store.js";

/** Grace between SIGTERM and SIGKILL for the whole process group. */
export const KILL_GRACE_MS = 3_000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LINE_BUFFER = 1024 * 1024;

export interface AttemptSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}

export interface AttemptLimits {
  timeoutMs: number;
  idleMs: number;
}

export type AttemptEnd = "exit" | "timeout" | "idle" | "aborted" | "spawn-error";

export interface AttemptResult {
  end: AttemptEnd;
  exitCode: number | null;
  signal: string | null;
  /** Final assistant text (text of the last assistant message seen). */
  text: string;
  errorMessage: string | null;
  lastLine: string | null;
  pid: number | null;
  pgid: number | null;
}

export interface AttemptHooks {
  onSpawn?: (pid: number) => void;
  onActivity?: (lastLine: string | null, at: number) => void;
}

/** Keep the last assistant message per message id, bounded in total size. */
class TextCollector {
  private readonly byMessage = new Map<string, string>();
  private bytes = 0;

  add(messageId: string, text: string): void {
    const previous = this.byMessage.get(messageId) ?? "";
    const room = MAX_TEXT_BYTES - this.bytes;
    if (room <= 0) return;
    const chunk = text.length > room ? text.slice(0, room) : text;
    this.bytes += chunk.length;
    this.byMessage.delete(messageId);
    this.byMessage.set(messageId, previous + chunk);
  }

  latest(): string {
    let last = "";
    for (const value of this.byMessage.values()) last = value;
    return last;
  }
}

function parseEventLine(line: string): { type: string; part?: any; error?: any } | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as { type: string }) : null;
  } catch {
    return null;
  }
}

/**
 * Run one OpenCode CLI attempt in its own process group. A watchdog ends the attempt when the
 * total runtime exceeds `timeoutMs` or when no stdout/stderr arrives for `idleMs`. Ending an
 * attempt sends SIGTERM to the group, then SIGKILL after KILL_GRACE_MS.
 */
export function runAttempt(
  spec: AttemptSpec,
  limits: AttemptLimits,
  hooks: AttemptHooks = {},
  abort?: AbortSignal,
): Promise<AttemptResult> {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(spec.logFile, { flags: "a", mode: 0o600 });
    const startedAt = Date.now();
    let lastActivity = startedAt;
    let end: AttemptEnd | null = null;
    let settled = false;
    let stdoutBuffer = "";
    let stderrTail = "";
    let lastLine: string | null = null;
    let errorMessage: string | null = null;
    const texts = new TextCollector();
    let child: ChildProcess;

    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      log.end();
      resolve({
        end: "spawn-error",
        exitCode: null,
        signal: null,
        text: "",
        errorMessage: error instanceof Error ? error.message : String(error),
        lastLine: null,
        pid: null,
        pgid: null,
      });
      return;
    }

    const pid = child.pid ?? null;
    const pgid = pid;
    if (pid !== null) hooks.onSpawn?.(pid);

    const touch = (line: string | null) => {
      lastActivity = Date.now();
      hooks.onActivity?.(line, lastActivity);
    };

    const terminateGroup = () => {
      if (pgid === null) {
        child.kill("SIGTERM");
      } else {
        killProcessGroup(pgid, "SIGTERM");
      }
      const timer = setTimeout(() => {
        if (pgid === null) child.kill("SIGKILL");
        else killProcessGroup(pgid, "SIGKILL");
      }, KILL_GRACE_MS);
      timer.unref();
    };

    const stop = (reason: AttemptEnd) => {
      if (end !== null) return;
      end = reason;
      terminateGroup();
    };

    const watchdog = setInterval(
      () => {
        const now = Date.now();
        if (now - startedAt >= limits.timeoutMs) stop("timeout");
        else if (now - lastActivity >= limits.idleMs) stop("idle");
      },
      Math.max(20, Math.min(1_000, Math.floor(limits.idleMs / 4))),
    );

    const onAbort = () => stop("aborted");
    if (abort?.aborted) onAbort();
    else abort?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (raw: string) => {
      const line = stripAnsi(raw).trim();
      if (!line) return;
      const shown = line.slice(0, 300);
      log.write(`${line}\n`);
      const event = parseEventLine(line);
      if (event?.type === "text" && typeof event.part?.text === "string") {
        texts.add(String(event.part.messageID ?? "default"), event.part.text);
      } else if (event?.type === "error") {
        errorMessage = JSON.stringify(event.error ?? event).slice(0, 2_000);
      }
      lastLine = shown;
      touch(shown);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        handleLine(stdoutBuffer.slice(0, index));
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        index = stdoutBuffer.indexOf("\n");
      }
      if (stdoutBuffer.length > MAX_LINE_BUFFER)
        stdoutBuffer = stdoutBuffer.slice(-MAX_LINE_BUFFER);
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      log.write(chunk);
      stderrTail = (stderrTail + chunk).slice(-2_000);
      const last = stripAnsi(chunk).trim().split("\n").pop() ?? "";
      touch(last ? last.slice(0, 300) : lastLine);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      abort?.removeEventListener("abort", onAbort);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      // Reap leftovers (standalone servers, grandchildren) that outlived the leader.
      if (pgid !== null) terminateGroup();
      log.end();
      const reason: AttemptEnd = spawnError ? "spawn-error" : (end ?? "exit");
      const failureDetail =
        errorMessage ??
        (spawnError ? spawnError.message : null) ??
        (code !== 0 && stderrTail.trim() ? stripAnsi(stderrTail).trim().slice(-800) : null);
      resolve({
        end: reason,
        exitCode: code,
        signal,
        text: texts.latest(),
        errorMessage: reason === "exit" && code === 0 ? null : failureDetail,
        lastLine,
        pid,
        pgid,
      });
    };

    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => {
      // Stdio can stay open while grandchildren live; do not wait for it past a short drain.
      setTimeout(() => finish(code, signal), 500).unref();
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
}
