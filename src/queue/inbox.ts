import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { oneLine } from "../util/text.js";

export const MESSAGE_MODES = ["when_idle", "now"] as const;
export type MessageMode = (typeof MESSAGE_MODES)[number];

export const MESSAGE_STATUSES = ["queued", "delivered", "cancelled", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const MESSAGE_PREVIEW_CHARS = 200;
/** Finished messages kept per run for list_messages; queued ones are never pruned. */
export const MAX_FINISHED_MESSAGES = 200;
export const MAX_PRIORITY = 1_000;
const MAX_ERROR_CHARS = 300;

const INBOX_SUFFIX = ".inbox.jsonl";
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
export const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{12}$/;

export interface QueuedMessage {
  id: string;
  ts: number;
  mode: MessageMode;
  status: MessageStatus;
  priority: number;
  text: string;
  /** Delivery attempts started so far (limit hits are refunded). */
  attempts: number;
  /** True while a delivery attempt is running; such a message cannot be cancelled. */
  in_flight: boolean;
  last_error: string | null;
  delivered_at: number | null;
  /** Earliest time (ms) the next attempt may start. */
  next_attempt_at: number;
}

export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new BridgeError("INVALID_ARGUMENT", "run_id has an invalid format.");
  }
  return runId;
}

export function inboxFileFor(runsDir: string, runId: string): string {
  return path.join(runsDir, `${assertRunId(runId)}${INBOX_SUFFIX}`);
}

/** Inbox files currently present in the runs directory. */
export function listInboxFiles(runsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(INBOX_SUFFIX))
    .map((name) => path.join(runsDir, name));
}

function parseMessage(line: string): QueuedMessage | null {
  let value: Partial<QueuedMessage>;
  try {
    value = JSON.parse(line) as Partial<QueuedMessage>;
  } catch {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.text !== "string" ||
    typeof value.ts !== "number" ||
    !MESSAGE_STATUSES.includes(value.status as MessageStatus)
  ) {
    return null;
  }
  return {
    id: value.id,
    ts: value.ts,
    mode: MESSAGE_MODES.includes(value.mode as MessageMode)
      ? (value.mode as MessageMode)
      : "when_idle",
    status: value.status as MessageStatus,
    priority: typeof value.priority === "number" ? value.priority : 0,
    text: value.text,
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    in_flight: value.in_flight === true,
    last_error: typeof value.last_error === "string" ? value.last_error : null,
    delivered_at: typeof value.delivered_at === "number" ? value.delivered_at : null,
    next_attempt_at: typeof value.next_attempt_at === "number" ? value.next_attempt_at : 0,
  };
}

/** Read every message in an inbox. A missing file is an empty inbox; unreadable lines are skipped. */
export function readInbox(file: string): QueuedMessage[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const messages: QueuedMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseMessage(line);
    if (parsed) messages.push(parsed);
  }
  return messages;
}

/** Keep every queued message plus the newest finished ones, in file order. */
function pruned(messages: QueuedMessage[]): QueuedMessage[] {
  const finished = messages.filter((message) => message.status !== "queued");
  const keep = new Set(finished.slice(-MAX_FINISHED_MESSAGES));
  return messages.filter((message) => message.status === "queued" || keep.has(message));
}

/** Atomic rewrite: write a temp file next to the inbox, then rename it over the old one. */
export function writeInbox(file: string, messages: QueuedMessage[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const kept = pruned(messages);
  const body = kept.map((message) => JSON.stringify(message)).join("\n");
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, body ? `${body}\n` : "", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Queued messages in delivery order: priority first, then "now" before "when_idle", then arrival. */
export function queuedOrder(messages: QueuedMessage[]): QueuedMessage[] {
  return messages
    .filter((message) => message.status === "queued")
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) =>
        b.message.priority - a.message.priority ||
        Number(b.message.mode === "now") - Number(a.message.mode === "now") ||
        a.message.ts - b.message.ts ||
        a.index - b.index,
    )
    .map((entry) => entry.message);
}

/** The next message an attempt may start with: queued, not already in flight, and due. */
export function nextDeliverable(messages: QueuedMessage[], now: number): QueuedMessage | null {
  return (
    queuedOrder(messages).find((message) => !message.in_flight && message.next_attempt_at <= now) ??
    null
  );
}

export function countQueued(file: string): number {
  return readInbox(file).filter((message) => message.status === "queued").length;
}

export interface EnqueueInput {
  text: string;
  mode?: MessageMode;
  priority?: number;
  now: number;
}

export function validateMessageText(text: string): string {
  if (text.length === 0 || text.length > MAX_MESSAGE_CHARS || text.trim().length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `message must contain 1 to ${MAX_MESSAGE_CHARS} characters of text.`,
    );
  }
  return text;
}

export function enqueueMessage(
  file: string,
  input: EnqueueInput,
): { message: QueuedMessage; position: number } {
  validateMessageText(input.text);
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || Math.abs(priority) > MAX_PRIORITY) {
    throw new BridgeError("INVALID_ARGUMENT", `priority must be an integer in ±${MAX_PRIORITY}.`);
  }
  const message: QueuedMessage = {
    id: `msg_${crypto.randomBytes(6).toString("hex")}`,
    ts: input.now,
    mode: input.mode ?? "when_idle",
    status: "queued",
    priority,
    text: input.text,
    attempts: 0,
    in_flight: false,
    last_error: null,
    delivered_at: null,
    next_attempt_at: 0,
  };
  const all = [...readInbox(file), message];
  writeInbox(file, all);
  const position = queuedOrder(all).findIndex((entry) => entry.id === message.id) + 1;
  return { message, position };
}

/** Apply a change to one message and persist the inbox. Returns the new record or null when absent. */
export function mutateMessage(
  file: string,
  id: string,
  change: (message: QueuedMessage) => QueuedMessage,
): QueuedMessage | null {
  const all = readInbox(file);
  const index = all.findIndex((message) => message.id === id);
  if (index < 0) return null;
  const next = change(all[index] as QueuedMessage);
  all[index] = next;
  writeInbox(file, all);
  return next;
}

export function cancelMessage(file: string, id: string): QueuedMessage {
  const current = readInbox(file).find((message) => message.id === id);
  if (!current) throw new BridgeError("INVALID_ARGUMENT", `Unknown message: ${id}`);
  if (current.status !== "queued") {
    throw new BridgeError("INVALID_ARGUMENT", `message is already ${current.status}.`);
  }
  if (current.in_flight) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "message is being delivered and cannot be cancelled.",
    );
  }
  const next = mutateMessage(file, id, (message) => ({ ...message, status: "cancelled" }));
  return next as QueuedMessage;
}

export function startAttempt(message: QueuedMessage): QueuedMessage {
  return { ...message, attempts: message.attempts + 1, in_flight: true };
}

/** A limit hit or a redelivery interruption is not the message's fault: give the attempt back. */
export function refundAttempt(message: QueuedMessage): QueuedMessage {
  return { ...message, attempts: Math.max(0, message.attempts - 1), in_flight: false };
}

/** Record the outcome of an attempt. A failed attempt stays queued until the attempt limit. */
export function settleAttempt(
  message: QueuedMessage,
  delivered: boolean,
  error: string | null,
  now: number,
): QueuedMessage {
  if (delivered) {
    return {
      ...message,
      in_flight: false,
      status: "delivered",
      delivered_at: now,
      last_error: null,
    };
  }
  const exhausted = message.attempts >= MAX_DELIVERY_ATTEMPTS;
  return {
    ...message,
    in_flight: false,
    status: exhausted ? "failed" : "queued",
    last_error: error ? oneLine(error, MAX_ERROR_CHARS) : null,
  };
}

export function messagePreview(text: string): string {
  return oneLine(text, MESSAGE_PREVIEW_CHARS);
}

/** Run id an inbox file belongs to (inverse of inboxFileFor). */
export function runIdOfInbox(file: string): string {
  return path.basename(file).slice(0, -INBOX_SUFFIX.length);
}
