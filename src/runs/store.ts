import fs from "node:fs";
import path from "node:path";

export const RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "timeout",
  "aborted",
  "stale",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "done",
  "failed",
  "timeout",
  "aborted",
  "stale",
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface RunRecord {
  id: string;
  name: string;
  status: RunStatus;
  cwd: string;
  branch: string | null;
  agent: string | null;
  model: string;
  model_note: string | null;
  allow_shared_cwd: boolean;
  attempts: number;
  owner_pid: number;
  /** Owning Claude session (see owner.ts). Absent on records written before 1.5.0. */
  owner_id?: string | null;
  owner_label?: string | null;
  pid: number | null;
  pgid: number | null;
  created: number;
  started: number | null;
  finished: number | null;
  last_activity: number;
  exit_code: number | null;
  signal: string | null;
  final_text: string | null;
  final_truncated: boolean;
  last_line: string | null;
  error: string | null;
  prompt_file: string;
  log_file: string;
  /** Pool id when the run is a unit worker of pool mode (owned by its supervisor). */
  pool?: string | null;
  /** Classified failure (see errors.ts). Absent on records written before 1.6.0. */
  error_kind?: string | null;
  /** Raw error text as opencode reported it, before classification. */
  error_raw?: string | null;
  /** Hard timeout and idle limit of this run, in ms (1.6.0+). Absent: the settings apply. */
  timeout_ms?: number | null;
  idle_ms?: number | null;
  /** Queued runs expire after this many ms without starting (1.6.0+). */
  queue_ttl_ms?: number | null;
}

/** Persists one JSON file per run under the runs directory. Writes are atomic (tmp + rename). */
export class RunStore {
  constructor(readonly dir: string) {}

  private fileFor(id: string): string {
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error(`invalid run id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  save(record: RunRecord): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(record.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  get(id: string): RunRecord | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fileFor(id), "utf8")) as RunRecord;
      return isRunRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  list(): RunRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.created - a.created);
  }
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RunRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.status === "string" &&
    (RUN_STATUSES as readonly string[]).includes(record.status) &&
    typeof record.cwd === "string" &&
    typeof record.created === "number"
  );
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Guard against PID reuse: on Linux the live process must still be an opencode command. */
export function looksLikeOpencode(pid: number): boolean {
  if (!fs.existsSync("/proc")) return isProcessAlive(pid);
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("opencode");
  } catch {
    return false;
  }
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Group already gone.
  }
}
