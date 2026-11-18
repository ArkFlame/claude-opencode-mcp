import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueMessage, readInbox } from "../../src/queue/inbox.js";
import { drainSessionInbox, type SessionDeliveryTarget } from "../../src/queue/session-delivery.js";

const dirs: string[] = [];
const NOW = 5_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeCall {
  kind: "abort" | "prompt";
  text?: string;
}

function fakeClient(refuse: boolean, calls: FakeCall[]) {
  return {
    session: {
      abort: async () => {
        calls.push({ kind: "abort" });
        return {};
      },
      promptAsync: async (options: { body: { parts: Array<{ text: string }> } }) => {
        calls.push({ kind: "prompt", text: options.body.parts[0]?.text });
        return refuse ? { error: { name: "APIError" } } : {};
      },
    },
  };
}

function target(file: string, client: unknown): SessionDeliveryTarget {
  return {
    inboxFile: file,
    sessionId: "ses_1",
    agent: "build",
    prepare: async () => ({ client: client as never, model: null }),
  };
}

function inbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-session-"));
  dirs.push(dir);
  return path.join(dir, "run.inbox.jsonl");
}

describe("session delivery", () => {
  it("sends due messages in order and marks them delivered", async () => {
    const file = inbox();
    enqueueMessage(file, { text: "one", now: NOW });
    enqueueMessage(file, { text: "two", now: NOW + 1 });
    const calls: FakeCall[] = [];
    const result = await drainSessionInbox(target(file, fakeClient(false, calls)), () => NOW + 2);
    expect(result).toEqual({ delivered: 2, failed: 0, retryInMs: null });
    expect(calls.map((call) => call.text)).toEqual(["one", "two"]);
    expect(readInbox(file).map((message) => message.status)).toEqual(["delivered", "delivered"]);
  });

  it("keeps a refused message queued with a retry time and attempt count", async () => {
    const file = inbox();
    const { message } = enqueueMessage(file, { text: "later", now: NOW });
    const calls: FakeCall[] = [];
    const result = await drainSessionInbox(target(file, fakeClient(true, calls)), () => NOW);
    expect(result.failed).toBe(1);
    expect(result.retryInMs).toBe(5_000);
    const [stored] = readInbox(file);
    expect(stored?.id).toBe(message.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.attempts).toBe(1);
    expect(stored?.next_attempt_at).toBe(NOW + 5_000);
    const again = await drainSessionInbox(target(file, fakeClient(false, calls)), () => NOW);
    expect(again.delivered).toBe(0);
  });

  it("aborts the running prompt before sending a now message", async () => {
    const file = inbox();
    enqueueMessage(file, { text: "urgent", mode: "now", now: NOW });
    const calls: FakeCall[] = [];
    await drainSessionInbox(target(file, fakeClient(false, calls)), () => NOW);
    expect(calls.map((call) => call.kind)).toEqual(["abort", "prompt"]);
  });
});
