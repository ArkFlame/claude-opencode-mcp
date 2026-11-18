import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";

export const DEFAULT_USAGE_LIMIT = 5_000;
export const MAX_USAGE_LIMIT = 50_000;
const MAX_PREFIX = 200;
const SQLITE_CLI_MAX_BUFFER = 256 * 1024 * 1024;

export interface UsageRow {
  session_id: string;
  title: string | null;
  data: string;
}

export interface ModelUsage {
  model: string;
  sessions: number;
  messages: number;
  median_output_tokens: number;
  mean_output_tokens: number;
  median_reasoning_tokens: number;
  mean_reasoning_tokens: number;
  /** reasoning / (output + reasoning), summed over messages. */
  reasoning_share: number;
  median_steps_per_session: number;
  median_ttft_ms: number | null;
  median_tokens_per_second: number | null;
}

export function defaultOpencodeDb(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

/** SQL literal for a LIKE prefix match. `%`, `_` and the escape character are escaped. */
export function titlePrefixClause(prefix: string | undefined): string {
  if (!prefix) return "";
  if (prefix.length > MAX_PREFIX || /[\0\r\n]/.test(prefix)) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `title_prefix must be at most ${MAX_PREFIX} plain characters.`,
    );
  }
  const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/'/g, "''");
  return ` AND s.title LIKE '${escaped}%' ESCAPE '\\'`;
}

export function buildUsageSql(limit: number, prefix: string | undefined): string {
  return [
    "SELECT m.session_id AS session_id, s.title AS title, m.data AS data",
    "FROM session_message m JOIN session_v2 s ON s.id = m.session_id",
    `WHERE m.type = 'assistant'${titlePrefixClause(prefix)}`,
    `ORDER BY m.time_created DESC LIMIT ${Math.trunc(limit)}`,
  ].join(" ");
}

type SqlRow = Record<string, unknown>;

/** Run a read-only query: node:sqlite when present (Node 22.13+), else the sqlite3 CLI in -readonly mode. */
async function runReadOnlyQuery(dbPath: string, sql: string): Promise<SqlRow[]> {
  let sqlite: typeof import("node:sqlite") | null = null;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    sqlite = null;
  }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as SqlRow[];
    } finally {
      db.close();
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      "sqlite3",
      ["-readonly", "-json", dbPath, sql],
      { maxBuffer: SQLITE_CLI_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(
            new BridgeError(
              "INTERNAL_ERROR",
              "sqlite3 query failed; install sqlite3 or use Node 22.13+.",
            ),
          );
          return;
        }
        const text = stdout.trim();
        resolve(text ? (JSON.parse(text) as SqlRow[]) : []);
      },
    );
  });
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

interface ParsedMessage {
  model: string;
  session: string;
  input: number;
  output: number;
  reasoning: number;
  ttftMs: number | null;
  tokensPerSecond: number | null;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseMessage(row: UsageRow): ParsedMessage | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tokens = data.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== "object") return null;
  const model = data.model as Record<string, unknown> | undefined;
  const time = (data.time ?? {}) as Record<string, unknown>;
  const modelId = typeof model?.id === "string" ? model.id : "unknown";
  const provider = typeof model?.providerID === "string" ? model.providerID : "unknown";
  const created = numberOr(time.created, NaN);
  const firstToken = numberOr(time.firstToken, NaN);
  const streamed = numberOr(time.streamed, NaN);
  const output = numberOr(tokens.output);
  const reasoning = numberOr(tokens.reasoning);
  const ttftMs =
    Number.isFinite(created) && Number.isFinite(firstToken) && firstToken >= created
      ? firstToken - created
      : null;
  const streamMs =
    Number.isFinite(streamed) && Number.isFinite(firstToken) ? streamed - firstToken : 0;
  const tokensPerSecond = output > 0 && streamMs > 0 ? output / (streamMs / 1000) : null;
  return {
    model: `${provider}/${modelId}`,
    session: row.session_id,
    input: numberOr(tokens.input),
    output,
    reasoning,
    ttftMs,
    tokensPerSecond,
  };
}

/** Group parsed assistant messages by model and reduce them to the reported figures. */
export function summarizeUsage(rows: UsageRow[]): ModelUsage[] {
  const groups = new Map<string, ParsedMessage[]>();
  for (const row of rows) {
    const parsed = parseMessage(row);
    if (!parsed) continue;
    const list = groups.get(parsed.model) ?? [];
    list.push(parsed);
    groups.set(parsed.model, list);
  }
  const result: ModelUsage[] = [];
  for (const [model, messages] of groups) {
    const bySession = new Map<string, { output: number; reasoning: number; steps: number }>();
    for (const message of messages) {
      const session = bySession.get(message.session) ?? { output: 0, reasoning: 0, steps: 0 };
      session.output += message.output;
      session.reasoning += message.reasoning;
      session.steps += 1;
      bySession.set(message.session, session);
    }
    const sessions = [...bySession.values()];
    const outputTotal = messages.reduce((sum, message) => sum + message.output, 0);
    const reasoningTotal = messages.reduce((sum, message) => sum + message.reasoning, 0);
    const ttft = messages
      .map((message) => message.ttftMs)
      .filter((value): value is number => value !== null);
    const tps = messages
      .map((message) => message.tokensPerSecond)
      .filter((value): value is number => value !== null);
    result.push({
      model,
      sessions: sessions.length,
      messages: messages.length,
      median_output_tokens: median(sessions.map((session) => session.output)),
      mean_output_tokens: mean(sessions.map((session) => session.output)),
      median_reasoning_tokens: median(sessions.map((session) => session.reasoning)),
      mean_reasoning_tokens: mean(sessions.map((session) => session.reasoning)),
      reasoning_share:
        outputTotal + reasoningTotal > 0
          ? Math.round((reasoningTotal / (outputTotal + reasoningTotal)) * 1000) / 1000
          : 0,
      median_steps_per_session: median(sessions.map((session) => session.steps)),
      median_ttft_ms: ttft.length > 0 ? median(ttft) : null,
      median_tokens_per_second: tps.length > 0 ? median(tps) : null,
    });
  }
  return result.sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model));
}

export interface UsageReport {
  db_path: string;
  title_prefix: string | null;
  messages_scanned: number;
  sessions: number;
  models: ModelUsage[];
  notes: string[];
}

export async function usageReport(options: {
  dbPath?: string | undefined;
  titlePrefix?: string | undefined;
  limit?: number | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<UsageReport> {
  const dbPath = path.resolve(options.dbPath ?? defaultOpencodeDb(options.env));
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    throw new BridgeError("WORKSPACE_NOT_FOUND", `opencode database not found: ${dbPath}`);
  }
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_USAGE_LIMIT, 1), MAX_USAGE_LIMIT);
  const rows = (await runReadOnlyQuery(
    dbPath,
    buildUsageSql(limit, options.titlePrefix),
  )) as unknown as UsageRow[];
  const models = summarizeUsage(rows);
  const sessions = new Set(rows.map((row) => row.session_id));
  return {
    db_path: dbPath,
    title_prefix: options.titlePrefix ?? null,
    messages_scanned: rows.length,
    sessions: sessions.size,
    models,
    notes: [
      `Newest ${limit} assistant messages. reasoning_share = reasoning / (output + reasoning).`,
      "Times are epoch milliseconds from the opencode database; the database is opened read-only.",
    ],
  };
}
