import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelMessage,
  enqueueMessage,
  inboxFileFor,
  MAX_DELIVERY_ATTEMPTS,
  MAX_MESSAGE_CHARS,
  nextDeliverable,
  queuedOrder,
  readInbox,
  refundAttempt,
  settleAttempt,
  startAttempt,
  writeInbox,
} from "../../src/queue/inbox.js";
import {
  buildResumeArgs,
  findSessionIdByTitle,
  unitSessionTitles,
} from "../../src/queue/resume.js";

const dirs: string[] = [];
const NOW = 1_000_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-inbox-"));
  dirs.push(dir);
  return dir;
}

describe("inbox ordering and validation", () => {
  it("orders by priority, then now before when_idle, then arrival, and reports positions", () => {
    const file = path.join(tempDir(), "run-1.inbox.jsonl");
    const first = enqueueMessage(file, { text: "first", now: NOW });
    const second = enqueueMessage(file, { text: "second", now: NOW + 1 });
    const urgent = enqueueMessage(file, { text: "urgent", mode: "now", now: NOW + 2 });
    const boosted = enqueueMessage(file, { text: "boosted", priority: 5, now: NOW + 3 });

    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(urgent.position).toBe(1);
    expect(boosted.position).toBe(1);
    expect(queuedOrder(readInbox(file)).map((message) => message.text)).toEqual([
      "boosted",
      "urgent",
      "first",
      "second",
    ]);
  });

  it("rejects empty, whitespace-only and oversized text, and out-of-range priority", () => {
    const file = path.join(tempDir(), "run-2.inbox.jsonl");
    expect(() => enqueueMessage(file, { text: "", now: NOW })).toThrow(/1 to 20000/);
    expect(() => enqueueMessage(file, { text: "   ", now: NOW })).toThrow(/1 to 20000/);
    expect(() =>
      enqueueMessage(file, { text: "x".repeat(MAX_MESSAGE_CHARS + 1), now: NOW }),
    ).toThrow(/1 to 20000/);
    expect(() => enqueueMessage(file, { text: "ok", priority: 1.5, now: NOW })).toThrow(/integer/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects run ids that could escape the runs directory", () => {
    expect(() => inboxFileFor("/tmp/runs", "../etc")).toThrow(/invalid format/);
    expect(inboxFileFor("/tmp/runs", "pl0a1b2c3d4e-0011223344")).toBe(
      path.join("/tmp/runs", "pl0a1b2c3d4e-0011223344.inbox.jsonl"),
    );
  });

  it("writes atomically without leaving temp files behind", () => {
    const dir = tempDir();
    const file = path.join(dir, "run-3.inbox.jsonl");
    enqueueMessage(file, { text: "one", now: NOW });
    enqueueMessage(file, { text: "two", now: NOW + 1 });
    expect(fs.readdirSync(dir)).toEqual(["run-3.inbox.jsonl"]);
    expect(readInbox(file).map((message) => message.text)).toEqual(["one", "two"]);
  });

  it("skips corrupt lines instead of failing the whole inbox", () => {
    const file = path.join(tempDir(), "run-4.inbox.jsonl");
    enqueueMessage(file, { text: "kept", now: NOW });
    fs.appendFileSync(file, "{not json\n");
    expect(readInbox(file).map((message) => message.text)).toEqual(["kept"]);
  });
});

describe("cancel and attempt accounting", () => {
  it("cancels a queued message once and refuses in-flight or finished ones", () => {
    const file = path.join(tempDir(), "run-5.inbox.jsonl");
    const { message } = enqueueMessage(file, { text: "later", now: NOW });
    expect(cancelMessage(file, message.id).status).toBe("cancelled");
    expect(() => cancelMessage(file, message.id)).toThrow(/already cancelled/);

    const busy = enqueueMessage(file, { text: "busy", now: NOW });
    writeInbox(
      file,
      readInbox(file).map((entry) => (entry.id === busy.message.id ? startAttempt(entry) : entry)),
    );
    expect(() => cancelMessage(file, busy.message.id)).toThrow(/being delivered/);
  });

  it("fails a message after the attempt limit and refunds limit hits", () => {
    const base = {
      ...readInbox(writeAndRead("a")).at(0),
    } as ReturnType<typeof readInbox>[number];
    let message = base;
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      message = startAttempt(message);
      expect(message.attempts).toBe(attempt);
      message = settleAttempt(message, false, "exit 1", NOW);
    }
    expect(message.status).toBe("failed");
    expect(message.last_error).toBe("exit 1");

    const limited = refundAttempt(startAttempt(base));
    expect(limited.attempts).toBe(0);
    expect(limited.status).toBe("queued");
    expect(limited.in_flight).toBe(false);
  });

  it("keeps a message due only after its retry time", () => {
    const file = path.join(tempDir(), "run-6.inbox.jsonl");
    const { message } = enqueueMessage(file, { text: "wait", now: NOW });
    const later = { ...message, next_attempt_at: NOW + 5_000 };
    expect(nextDeliverable([later], NOW)).toBeNull();
    expect(nextDeliverable([later], NOW + 5_000)?.id).toBe(message.id);
  });
});

function writeAndRead(name: string): string {
  const file = path.join(tempDir(), `${name}.inbox.jsonl`);
  enqueueMessage(file, { text: "payload", now: NOW });
  return file;
}

describe("resume argv", () => {
  it("passes the message as one argv entry after --, never as a flag", () => {
    const text = '--auto; rm -rf / $(id) "quoted"';
    const args = buildResumeArgs({ model: "p/fast", sessionId: "ses_abc-1", text });
    expect(args.slice(0, 6)).toEqual(["run", "--session", "ses_abc-1", "--auto", "-m", "p/fast"]);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(text);
    expect(args.filter((entry) => entry === text)).toHaveLength(1);
  });

  it("rejects session ids with shell or flag characters", () => {
    expect(() => buildResumeArgs({ model: "p/m", sessionId: "ses x", text: "hi" })).toThrow(
      /session id/,
    );
    expect(() => buildResumeArgs({ model: "p/m", sessionId: "a;b", text: "hi" })).toThrow();
  });

  it("looks up the newest session by pool title read-only", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "opencode.db");
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE session (id TEXT, title TEXT)");
    db.exec(
      "INSERT INTO session VALUES ('ses_old', 'pool unit-7'), ('ses_other', 'other'), ('ses_new', 'pool:unit-7')",
    );
    db.close();
    expect(findSessionIdByTitle(unitSessionTitles("unit-7"), dbPath)).toBe("ses_new");
    expect(findSessionIdByTitle(["pool missing"], dbPath)).toBeNull();
    expect(findSessionIdByTitle(["pool unit-7"], path.join(dir, "absent.db"))).toBeNull();
  });
});
