import { createHash } from "node:crypto";
import fs from "node:fs";
import { BridgeError } from "../errors.js";
import { isProcessAlive } from "./store.js";

/** Field 22 of /proc/<pid>/stat is starttime; after the last ")" it is the 20th field. */
const STAT_START_INDEX = 22 - 3;

export interface RunOwner {
  /** Stable per Claude Code session: survives an MCP server restart under the same parent. */
  id: string;
  /** Human name shown in list_runs; the MCP client name plus a short id unless overridden. */
  label: string;
  pid: number;
  ppid: number;
  started: number;
  /** Set when the MCP client reports its name; used only when no label override exists. */
  clientName: string | null;
  labelOverride: boolean;
}

export interface OwnerInput {
  env: NodeJS.ProcessEnv;
  pid?: number;
  ppid?: number;
  now?: number;
  readFile?: (file: string) => string;
}

const defaultRead = (file: string): string => fs.readFileSync(file, "utf8");

/** Start time (clock ticks since boot) of a process from /proc, or null when unavailable. */
export function procStartTicks(
  pid: number,
  readFile: (file: string) => string = defaultRead,
): string | null {
  try {
    const stat = readFile(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = fields[STAT_START_INDEX];
    return ticks && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/** Owner id: CLAUDE_OPENCODE_OWNER verbatim, else `<ppid>-<start of ppid>`, else `<pid>-<now>`. */
export function deriveOwnerId(input: OwnerInput): string {
  const override = input.env.CLAUDE_OPENCODE_OWNER?.trim();
  if (override) return override;
  const pid = input.pid ?? process.pid;
  const ppid = input.ppid ?? process.ppid;
  const start = procStartTicks(ppid, input.readFile);
  if (start) return `${ppid}-${start}`;
  return `${pid}-${input.now ?? Date.now()}`;
}

/** Four hex characters derived from the owner id, so labels stay short and stable. */
export function shortOwnerId(id: string): string {
  return createHash("sha1").update(id).digest("hex").slice(0, 4);
}

export function labelFor(
  owner: Pick<RunOwner, "id" | "clientName" | "labelOverride">,
  env: NodeJS.ProcessEnv,
): string {
  const override = env.CLAUDE_OPENCODE_LABEL?.trim();
  if (override) return override;
  return `${owner.clientName?.trim() || "mcp"}#${shortOwnerId(owner.id)}`;
}

export function createRunOwner(input: OwnerInput): RunOwner {
  const pid = input.pid ?? process.pid;
  const ppid = input.ppid ?? process.ppid;
  const id = deriveOwnerId({ ...input, pid, ppid });
  const owner: RunOwner = {
    id,
    label: "",
    pid,
    ppid,
    started: input.now ?? Date.now(),
    clientName: null,
    labelOverride: Boolean(input.env.CLAUDE_OPENCODE_LABEL?.trim()),
  };
  owner.label = labelFor(owner, input.env);
  return owner;
}

/** Apply the MCP client name reported at initialize. A label override from the environment wins. */
export function applyClientName(
  owner: RunOwner,
  clientName: string | undefined,
  env: NodeJS.ProcessEnv,
): void {
  owner.clientName = clientName?.trim() || null;
  owner.label = labelFor(owner, env);
}

/** Minimal shape of a stored run (or pool or message) that carries ownership. */
export interface OwnedRecord {
  owner_id?: string | null;
  owner_label?: string | null;
  owner_pid: number;
}

export interface OwnershipView {
  owner_id: string | null;
  owner_label: string | null;
  /** Owned by this session. */
  mine: boolean;
  /** Owned by another live session (or an unowned legacy record with a live foreign pid). */
  foreign: boolean;
}

/**
 * Who owns a record. New records carry owner_id. Legacy records (no owner_id) belong to whoever's
 * owner_pid equals this process; a legacy record whose pid is alive and different is foreign.
 */
export function ownershipOf(
  record: OwnedRecord,
  me: Pick<RunOwner, "id" | "pid" | "label">,
  alive: (pid: number) => boolean = isProcessAlive,
): OwnershipView {
  if (record.owner_id) {
    const mine = record.owner_id === me.id;
    return {
      owner_id: record.owner_id,
      owner_label: record.owner_label ?? (mine ? me.label : record.owner_id),
      mine,
      foreign: !mine,
    };
  }
  const mine = record.owner_pid === me.pid;
  return {
    owner_id: null,
    owner_label: mine ? me.label : `legacy pid ${record.owner_pid}`,
    mine,
    foreign: !mine && alive(record.owner_pid),
  };
}

export const SCOPES = ["mine", "all"] as const;
export type OwnerScope = (typeof SCOPES)[number];

export function filterByScope<T extends OwnedRecord>(
  records: T[],
  scope: OwnerScope,
  me: Pick<RunOwner, "id" | "pid" | "label">,
): T[] {
  if (scope === "all") return records;
  return records.filter((record) => ownershipOf(record, me).mine);
}

/** Refuse mutations on another session's record unless force is set. Reads never call this. */
export function assertMutable(
  record: OwnedRecord & { id?: string },
  me: Pick<RunOwner, "id" | "pid" | "label">,
  force: boolean | undefined,
): void {
  const view = ownershipOf(record, me);
  if (!view.foreign || force === true) return;
  const name = record.id ? `run ${record.id}` : "this record";
  throw new BridgeError(
    "PERMISSION_DENIED",
    `${name} belongs to ${view.owner_label}; pass force: true to act on it.`,
  );
}

export interface OwnerSummary {
  owner_id: string | null;
  label: string;
  runs: number;
  running: number;
}

/** Per-owner counts for list_runs with scope all. */
export function summarizeOwners(
  records: Array<OwnedRecord & { status: string }>,
  me: Pick<RunOwner, "id" | "pid" | "label">,
): OwnerSummary[] {
  const byKey = new Map<string, OwnerSummary>();
  for (const record of records) {
    const view = ownershipOf(record, me);
    const key = view.owner_id ?? `legacy:${view.owner_label}`;
    const entry = byKey.get(key) ?? {
      owner_id: view.owner_id,
      label: view.owner_label ?? "unowned",
      runs: 0,
      running: 0,
    };
    entry.runs += 1;
    if (record.status === "running") entry.running += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.runs - a.runs);
}
