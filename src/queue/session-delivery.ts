import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ModelRef } from "../opencode/run.js";
import {
  mutateMessage,
  nextDeliverable,
  type QueuedMessage,
  readInbox,
  settleAttempt,
  startAttempt,
} from "./inbox.js";

/** Pause before retrying a session delivery that OpenCode refused, scaled by attempt count. */
export const SESSION_RETRY_BASE_MS = 5_000;

export interface SessionDeliveryTarget {
  inboxFile: string;
  sessionId: string;
  agent: string;
  /** Builds the session workspace client and the model it runs on; called once per delivery. */
  prepare: () => Promise<{ client: OpencodeClient; model: ModelRef | null }>;
}

export interface DrainResult {
  delivered: number;
  failed: number;
  /** Set when the next attempt should be retried after this many ms. */
  retryInMs: number | null;
}

const draining = new Set<string>();
const retryTimers = new Map<string, NodeJS.Timeout>();

/**
 * Deliver every due queued message of one session, in order, through OpenCode's async prompt.
 * OpenCode appends the message to the session queue when it is busy and starts it when idle.
 * "now" messages abort the running prompt first. At most one drain per inbox runs at a time.
 */
export async function drainSessionInbox(
  target: SessionDeliveryTarget,
  now: () => number = Date.now,
): Promise<DrainResult> {
  const result: DrainResult = { delivered: 0, failed: 0, retryInMs: null };
  if (draining.has(target.inboxFile)) return result;
  draining.add(target.inboxFile);
  try {
    for (;;) {
      const next = nextDeliverable(readInbox(target.inboxFile), now());
      if (!next) break;
      const started = mutateMessage(target.inboxFile, next.id, startAttempt);
      if (!started) break;
      const outcome = await deliverOne(target, started, now());
      if (outcome.ok) {
        result.delivered += 1;
        continue;
      }
      result.failed += 1;
      const after = readInbox(target.inboxFile).find((message) => message.id === next.id);
      if (after?.status === "queued") {
        result.retryInMs = SESSION_RETRY_BASE_MS * Math.max(1, after.attempts);
        mutateMessage(target.inboxFile, next.id, (message) => ({
          ...message,
          next_attempt_at: now() + (result.retryInMs ?? 0),
        }));
      }
      break;
    }
  } finally {
    draining.delete(target.inboxFile);
  }
  return result;
}

async function deliverOne(
  target: SessionDeliveryTarget,
  message: QueuedMessage,
  at: number,
): Promise<{ ok: boolean }> {
  const fail = (error: string) => {
    mutateMessage(target.inboxFile, message.id, (current) =>
      settleAttempt(current, false, error, at),
    );
    return { ok: false };
  };
  let client: OpencodeClient;
  let model: ModelRef | null = null;
  try {
    const prepared = await target.prepare();
    client = prepared.client;
    model = prepared.model;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    if (message.mode === "now") {
      await client.session.abort({ path: { id: target.sessionId } }).catch(() => undefined);
    }
    const sent = await client.session.promptAsync({
      path: { id: target.sessionId },
      body: {
        ...(target.agent ? { agent: target.agent } : {}),
        parts: [{ type: "text", text: message.text }],
        ...(model ? { model } : {}),
      },
    });
    if (sent.error) return fail("OpenCode rejected the message.");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  mutateMessage(target.inboxFile, message.id, (current) => settleAttempt(current, true, null, at));
  return { ok: true };
}

/** Run a drain again after `delayMs`, at most one pending timer per inbox. */
export function scheduleSessionRetry(
  runId: string,
  delayMs: number,
  run: () => Promise<unknown>,
): void {
  if (retryTimers.has(runId)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(runId);
    void run().catch(() => undefined);
  }, delayMs);
  timer.unref?.();
  retryTimers.set(runId, timer);
}

export function cancelSessionRetry(runId: string): void {
  const timer = retryTimers.get(runId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(runId);
}
