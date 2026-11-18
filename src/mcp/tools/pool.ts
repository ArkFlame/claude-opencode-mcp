import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import {
  eventsFileForPool,
  monitorCommandFor,
  summarizeEvent,
  waitForEvents,
} from "../../events/log.js";
import { AutoCommitter, MAX_INTERVAL_S, MIN_INTERVAL_S } from "../../git/auto-commit.js";
import { DEFAULT_MAX_RETRIES, PER_FILE_CAP_DEFAULT, unitKeyOf } from "../../pool/core.js";
import { isSupervisorAlive, listPoolDirs, startPool } from "../../pool/launch.js";
import {
  type LaneConfig,
  type PoolConfig,
  poolDirFor,
  poolIdFor,
  readControl,
  readPoolState,
  unitPaths,
  writeControl,
} from "../../pool/state.js";
import { buildPoolStatus } from "../../pool/status.js";
import {
  listUnitFiles,
  readUnitFile,
  scanUnits,
  splitUnitsGlob,
  type UnitFile,
} from "../../pool/units.js";
import { validateForbid } from "../../runs/brief.js";
import { assertModelId, assertRunName } from "../../runs/names.js";
import { assertMutable, filterByScope, ownershipOf, type RunOwner } from "../../runs/owner.js";
import { assertInsideRoots, defaultAllowedRoot, repoRootOf } from "../../runs/worktree.js";
import { DEFAULT_USAGE_LIMIT, MAX_USAGE_LIMIT, usageReport } from "../../usage/stats.js";
import { assertDiskFree, opencodeDataDir } from "../../util/disk.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";
import { FORCE_PARAM, SCOPE_PARAM } from "./owner-params.js";

const MAX_BRIEF_BYTES = 100 * 1024;
const MAX_LANES = 10;
const DEFAULT_TIMEOUT_S = 1_200;
const POOL_ID = z
  .string()
  .regex(/^[0-9a-f]{10}$/)
  .describe("Pool id returned by run_pool.");

async function guard<T>(fn: () => Promise<T>) {
  const id = requestId();
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error, id);
  }
}

/** Resolve a working directory the same way delegate_task does: exists, real path, inside roots. */
async function resolveWorkDir(ctx: AppContext, requested: string): Promise<string> {
  const resolved = path.resolve(requested.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new BridgeError("WORKSPACE_NOT_FOUND", `Working directory does not exist: ${resolved}`);
  }
  const real = fs.realpathSync(resolved);
  const repo = await repoRootOf(real).catch(() => real);
  const roots =
    ctx.runSettings.allowedRoots.length > 0
      ? ctx.runSettings.allowedRoots
      : [defaultAllowedRoot(repo)];
  assertInsideRoots(real, roots);
  return real;
}

function readBriefTemplate(file: string): string {
  if (!path.isAbsolute(file)) {
    throw new BridgeError("INVALID_PATH", "brief_template_path must be absolute.");
  }
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new BridgeError("INVALID_PATH", `brief template not found: ${file}`);
  if (stat.size > MAX_BRIEF_BYTES) {
    throw new BridgeError("INVALID_ARGUMENT", `brief template exceeds ${MAX_BRIEF_BYTES} bytes.`);
  }
  return fs.readFileSync(file, "utf8");
}

/** Ownership of a pool, read from its state file. Legacy pools are owned by their supervisor pid. */
function poolOwnership(dir: string, me: RunOwner) {
  const state = readPoolState(dir);
  const view = ownershipOf(
    {
      owner_id: state?.owner_id ?? null,
      owner_label: state?.owner_label ?? null,
      owner_pid: state?.supervisor_pid ?? 0,
    },
    me,
  );
  return {
    owner_id: view.owner_id,
    owner_label: view.owner_label,
    mine: view.mine,
    foreign: view.foreign,
  };
}

/** Pool directory for an id, or INVALID_ARGUMENT when no such pool exists. */
function requirePoolDir(runsDir: string, id: string): string {
  const dir = poolDirFor(runsDir, id);
  if (!fs.existsSync(dir)) throw new BridgeError("INVALID_ARGUMENT", `unknown pool: ${id}`);
  return dir;
}

/** Keys of open units (glob plus explicit paths) that have no unit state yet. */
function unitsNeedingState(
  poolDir: string,
  unitsGlob: string,
  marker: string,
  explicit: string[],
): string[] {
  const files: UnitFile[] = [];
  for (const entry of listUnitFiles(unitsGlob)) {
    const unit = readUnitFile(entry.file);
    if (unit) files.push(unit);
  }
  for (const file of explicit) {
    const unit = readUnitFile(file);
    if (unit) files.push(unit);
  }
  const keys = new Set<string>();
  for (const unit of files) {
    if (!unit.text.includes(marker)) continue;
    const key = unitKeyOf(unit.file);
    if (!fs.existsSync(unitPaths(poolDir, key).state)) keys.add(key);
  }
  return [...keys].sort();
}

export function registerPoolTools(server: McpServer, ctx: AppContext): void {
  const committer = new AutoCommitter({ runsDir: ctx.runSettings.runsDir });

  server.registerTool(
    "run_pool",
    {
      title: "Start a shared-checkout unit pool",
      description: [
        "Run one OpenCode worker per open unit file (a file that still contains `marker`) in a shared checkout, with lanes of models and per-lane caps.",
        "Units whose `<unit>.exit` is 0 are skipped. Units naming the same exclusive .rs file never run together; generic and hub files are capped by per_file_cap.",
        "The pool runs in a detached supervisor, so it survives this MCP server. Calling again with the same units_glob and cwd adopts the live pool.",
        "The supervisor rescans units_glob every 5 s, so new open unit files join the pool without a new call; add_units adds explicit paths. A unit with exit 0 is never run again.",
        "Provider limit errors requeue the unit, shrink that lane by one and back off; six consecutive hits stop the pool.",
        "Opencode sqlite failures requeue the unit with backoff up to max_retries and shrink its lane (never below one slot); six in a row stop the pool. Low free disk (CLAUDE_OPENCODE_MIN_FREE_MB) pauses launches.",
      ].join(" "),
      inputSchema: {
        units_glob: z
          .string()
          .min(1)
          .max(4_096)
          .describe(
            "Absolute glob for unit files; wildcards only in the file name, e.g. /repo/docs/units/*.md.",
          ),
        marker: z
          .string()
          .min(1)
          .max(200)
          .describe("Text a unit file must contain to count as open."),
        brief_template_path: z
          .string()
          .min(1)
          .max(4_096)
          .describe(
            "Absolute path to the worker brief. Placeholders: {{UNIT_PATH}}, {{UNIT_NAME}}, {{UNIT_KEY}}.",
          ),
        cwd: z.string().min(1).max(4_096).describe("Shared checkout the workers edit."),
        lanes: z
          .array(
            z.object({
              name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
              model: z.string().min(1).max(200),
              cap: z.number().int().min(0).max(64),
            }),
          )
          .min(1)
          .max(MAX_LANES)
          .describe("Lanes in priority order. Each has a model and a concurrency cap."),
        per_file_cap: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(
            `Max concurrent units naming one generic or hub file (default ${PER_FILE_CAP_DEFAULT}).`,
          ),
        timeout_s: z
          .number()
          .int()
          .min(60)
          .max(86_400)
          .optional()
          .describe(`Hard timeout per worker in seconds (default ${DEFAULT_TIMEOUT_S}).`),
        idle_timeout_seconds: z
          .number()
          .int()
          .min(60)
          .max(86_400)
          .optional()
          .describe(
            "Kill a worker whose log has not grown for this long (default CLAUDE_OPENCODE_IDLE_SECONDS, 300). Stale workers are reported after the same limit.",
          ),
        forbid: z
          .array(z.string().max(40))
          .max(20)
          .optional()
          .describe('Commands workers must not run (default ["git", "cargo"]).'),
        add_units: z
          .array(z.string().min(1).max(4_096))
          .max(500)
          .optional()
          .describe(
            "Absolute unit file paths to add to this pool, outside units_glob if needed. Picked up on the next scan.",
          ),
        retry_failed: z
          .boolean()
          .optional()
          .describe(
            "Requeue units that failed (not aborted). Applied by the live pool, or by a restarted one.",
          ),
        ramp: z
          .object({
            start: z.number().int().min(1).max(50),
            step: z.number().int().min(1).max(50),
            max: z.number().int().min(1).max(50),
            every_seconds: z.number().int().min(30).max(3_600),
            backoff_on_failures: z.number().int().min(1).max(50).optional(),
          })
          .optional()
          .describe(
            "Start lanes at `start` and add `step` slots every `every_seconds` while recent failures stay below backoff_on_failures (default 2). A spike cuts `step` back and pauses ramping for 10 min. Applies when the pool starts.",
          ),
        stale_action: z
          .enum(["report", "abort_requeue"])
          .optional()
          .describe(
            "Silent workers: report as stale (default), or abort and requeue the unit (up to max_retries).",
          ),
        max_retries: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe(
            `Retries for a unit hit by an opencode sqlite failure, with backoff (default ${DEFAULT_MAX_RETRIES}).`,
          ),
        force: FORCE_PARAM,
      },
      annotations: { openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const cwd = await resolveWorkDir(ctx, args.cwd);
        splitUnitsGlob(args.units_glob);
        const names = new Set<string>();
        const lanes: LaneConfig[] = args.lanes.map((lane) => {
          assertRunName(lane.name, "lane");
          if (names.has(lane.name))
            throw new BridgeError("INVALID_ARGUMENT", `duplicate lane: ${lane.name}`);
          names.add(lane.name);
          return { name: lane.name, model: assertModelId(lane.model), cap: lane.cap };
        });
        const briefTemplate = readBriefTemplate(args.brief_template_path);
        const id = poolIdFor(cwd, args.units_glob);
        const config: PoolConfig = {
          id,
          unitsGlob: args.units_glob,
          marker: args.marker,
          cwd,
          binary: ctx.runSettings.binary,
          lanes,
          perFileCap: args.per_file_cap ?? PER_FILE_CAP_DEFAULT,
          timeoutMs: (args.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000,
          idleMs: args.idle_timeout_seconds
            ? args.idle_timeout_seconds * 1000
            : ctx.runSettings.idleMs,
          forbid: validateForbid(args.forbid),
          maxRetries: args.max_retries ?? DEFAULT_MAX_RETRIES,
          ...(args.ramp
            ? {
                ramp: {
                  start: args.ramp.start,
                  step: args.ramp.step,
                  max: args.ramp.max,
                  everySeconds: args.ramp.every_seconds,
                  backoffOnFailures: args.ramp.backoff_on_failures ?? 2,
                },
              }
            : {}),
          staleAction: args.stale_action ?? "report",
          briefTemplate,
          runsDir: ctx.runSettings.runsDir,
          poolDir: poolDirFor(ctx.runSettings.runsDir, id),
          createdAt: Date.now(),
          ownerId: ctx.runs.owner.id,
          ownerLabel: ctx.runs.owner.label,
        };
        const units = scanUnits(args.units_glob);
        const open = units.filter((unit) => unit.text.includes(args.marker));
        const prior = readPoolState(config.poolDir);
        if (prior?.status === "running" && isSupervisorAlive(prior.supervisor_pid)) {
          assertMutable(
            {
              id,
              owner_id: prior.owner_id ?? null,
              owner_label: prior.owner_label ?? null,
              owner_pid: prior.supervisor_pid ?? 0,
            },
            ctx.runs.owner,
            args.force,
          );
        }
        assertDiskFree([cwd, opencodeDataDir(ctx.env)], ctx.env);
        const explicit = (args.add_units ?? []).map((file) => {
          if (!path.isAbsolute(file))
            throw new BridgeError("INVALID_PATH", `add_units must be absolute: ${file}`);
          return file;
        });
        const control = readControl(config.poolDir);
        writeControl(config.poolDir, {
          add_units: [...new Set([...control.add_units, ...explicit])],
          retry_failed: control.retry_failed || args.retry_failed === true,
        });
        const added = unitsNeedingState(config.poolDir, args.units_glob, args.marker, explicit);
        const started = startPool(config);
        return {
          ...started,
          monitor: {
            command: monitorCommandFor("pool", id),
            description:
              "Pass to Claude Code's Monitor tool: one notification per unit finish, failure, stale worker or lane change, and the stream ends when the pool is done.",
          },
          added_units: added,
          retry_failed: args.retry_failed === true,
          open_units: open.length,
          skipped_closed: units.length - open.length,
          lanes: lanes.map((lane) => ({ name: lane.name, model: lane.model, cap: lane.cap })),
          per_file_cap: config.perFileCap,
          timeout_s: config.timeoutMs / 1000,
          next: "Call pool_status with pool_id to follow progress.",
        };
      }),
  );

  server.registerTool(
    "pool_status",
    {
      title: "Pool progress",
      description:
        "Per-lane running, done, failed, provider hits and average seconds, queued count, stale workers (log idle over 300 s) and an ETA from the last 10 minutes of completions. Read-only.",
      inputSchema: {
        pool_id: POOL_ID.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Pools to list when pool_id is omitted (default 10)."),
        scope: SCOPE_PARAM,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const me = ctx.runs.owner;
        if (args.pool_id) {
          const dir = poolDirFor(ctx.runSettings.runsDir, args.pool_id);
          return { ...buildPoolStatus(dir), ...poolOwnership(dir, me) };
        }
        const scope = args.scope ?? "mine";
        const dirs = listPoolDirs(ctx.runSettings.runsDir)
          .filter((dir) => scope === "all" || poolOwnership(dir, me).mine)
          .slice(0, args.limit ?? 10);
        const pools = dirs.map((dir) => ({ ...buildPoolStatus(dir), ...poolOwnership(dir, me) }));
        const totals = { running: 0, queued: 0, done: 0, failed: 0, stale: 0, lane_cap: 0 };
        for (const pool of pools) {
          totals.running += pool.counts.running;
          totals.queued += pool.counts.queued;
          totals.done += pool.counts.done;
          totals.failed += pool.counts.failed;
          totals.stale += pool.stale_workers.length;
          totals.lane_cap += pool.lanes.reduce((sum, lane) => sum + lane.effective_cap, 0);
        }
        return { scope, totals: { ...totals, slots_in_use: totals.running }, pools };
      }),
  );

  server.registerTool(
    "wait_pool",
    {
      title: "Wait for pool events",
      description: [
        "Block (bounded, up to timeout_seconds, max 600) until a pool event matches `until`, then return the events and counts.",
        "until: any_finished (a unit finished or failed), failure, stale, or all_done (the pool is done).",
        "Pass the returned cursor as since on the next call so each event arrives once. Without since, only events after this call count.",
      ].join(" "),
      inputSchema: {
        pool_id: z.string().min(1).max(80),
        until: z.enum(["any_finished", "all_done", "failure", "stale"]).optional(),
        timeout_seconds: z.number().int().min(1).max(600).optional(),
        since: z
          .string()
          .regex(/^\d{1,12}$/)
          .optional()
          .describe("Cursor from the previous wait_pool call."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const dir = requirePoolDir(ctx.runSettings.runsDir, args.pool_id);
        const since = args.since === undefined ? undefined : Number(args.since);
        const waited = await waitForEvents(eventsFileForPool(dir), {
          until: args.until ?? "any_finished",
          ...(since === undefined ? {} : { since }),
          timeoutMs: (args.timeout_seconds ?? 300) * 1000,
        });
        const status = buildPoolStatus(dir);
        return {
          pool_id: args.pool_id,
          timed_out: waited.timed_out,
          cursor: String(waited.cursor),
          lines: waited.events.map(summarizeEvent),
          status: status.status,
          counts: status.counts,
          failed_units: status.failed_units,
          stale_workers: status.stale_workers,
        };
      }),
  );

  server.registerTool(
    "set_pool_cap",
    {
      title: "Change a live pool lane's cap",
      description:
        "Set one lane's concurrency cap on a running pool without restarting it. The live supervisor applies it on its next tick and emits a lane_cap_changed event. The next ramp step can move it again.",
      inputSchema: {
        pool_id: z.string().min(1).max(80),
        lane: z.string().min(1).max(80),
        cap: z.number().int().min(0).max(50),
      },
    },
    async (args) =>
      guard(async () => {
        const dir = requirePoolDir(ctx.runSettings.runsDir, args.pool_id);
        const state = readPoolState(dir);
        if (!state?.lanes.some((lane) => lane.name === args.lane)) {
          throw new BridgeError("INVALID_ARGUMENT", `unknown lane: ${args.lane}`);
        }
        const control = readControl(dir);
        writeControl(dir, {
          ...control,
          lane_caps: { ...(control.lane_caps ?? {}), [args.lane]: args.cap },
        });
        const status = buildPoolStatus(dir);
        return {
          pool_id: args.pool_id,
          lane: args.lane,
          cap: args.cap,
          supervisor_alive: status.supervisor_alive,
          applied: status.supervisor_alive ? "next supervisor tick" : "pending: no live supervisor",
        };
      }),
  );

  server.registerTool(
    "requeue_stale",
    {
      title: "Requeue stale workers",
      description:
        "Abort every silent worker of a pool and requeue its unit (up to max_retries per unit). Applied by the live supervisor on its next tick.",
      inputSchema: { pool_id: z.string().min(1).max(80) },
    },
    async (args) =>
      guard(async () => {
        const dir = requirePoolDir(ctx.runSettings.runsDir, args.pool_id);
        writeControl(dir, { ...readControl(dir), requeue_stale: true });
        return {
          pool_id: args.pool_id,
          requested: true,
          stale_workers: buildPoolStatus(dir).stale_workers,
        };
      }),
  );

  server.registerTool(
    "usage_stats",
    {
      title: "OpenCode usage by model",
      description: [
        "Read-only statistics from the opencode database: sessions, median and mean output and reasoning tokens, reasoning share, steps per session, time to first token and tokens per second, grouped by model.",
        "Filter with title_prefix to match session titles. The database is opened read-only and never written.",
      ].join(" "),
      inputSchema: {
        title_prefix: z
          .string()
          .max(200)
          .optional()
          .describe("Only sessions whose title starts with this text."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_USAGE_LIMIT)
          .optional()
          .describe(`Newest assistant messages to scan (default ${DEFAULT_USAGE_LIMIT}).`),
        db_path: z
          .string()
          .max(4_096)
          .optional()
          .describe("Absolute path to an opencode.db (default: the user's)."),
        scope: SCOPE_PARAM,
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const scope = args.scope ?? "mine";
        const runIds =
          scope === "mine"
            ? filterByScope(ctx.runs.store.list(), "mine", ctx.runs.owner).map((run) => run.id)
            : undefined;
        return usageReport({
          dbPath: args.db_path,
          titlePrefix: args.title_prefix,
          limit: args.limit,
          env: ctx.env,
          runIds,
        });
      }),
  );

  server.registerTool(
    "auto_commit",
    {
      title: "Auto-commit a shared checkout",
      description: [
        "Start, stop or inspect a background loop that commits pending changes of a shared checkout, one conventional subject-only commit per crate or docs area, then pushes the current branch.",
        "Stop with action=stop or by creating the stop file reported by status. The loop lives in this MCP server process.",
      ].join(" "),
      inputSchema: {
        action: z.enum(["start", "stop", "status"]).describe("What to do."),
        interval_s: z
          .number()
          .int()
          .min(MIN_INTERVAL_S)
          .max(MAX_INTERVAL_S)
          .optional()
          .describe("Seconds between passes (default 120)."),
        cwd: z
          .string()
          .min(1)
          .max(4_096)
          .optional()
          .describe("Shared checkout (required for start)."),
      },
      annotations: { destructiveHint: false },
    },
    async (args) =>
      guard(async () => {
        if (args.action === "start") {
          if (!args.cwd)
            throw new BridgeError("INVALID_ARGUMENT", "cwd is required to start auto_commit.");
          const cwd = await resolveWorkDir(ctx, args.cwd);
          return committer.start(cwd, args.interval_s);
        }
        if (args.action === "stop") return committer.stop();
        return committer.status();
      }),
  );
}
