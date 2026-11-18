import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import { AutoCommitter, MAX_INTERVAL_S, MIN_INTERVAL_S } from "../../git/auto-commit.js";
import { PER_FILE_CAP_DEFAULT } from "../../pool/core.js";
import { isSupervisorAlive, listPoolDirs, startPool } from "../../pool/launch.js";
import {
  type LaneConfig,
  type PoolConfig,
  poolDirFor,
  poolIdFor,
  readPoolState,
} from "../../pool/state.js";
import { buildPoolStatus } from "../../pool/status.js";
import { scanUnits, splitUnitsGlob } from "../../pool/units.js";
import { validateForbid } from "../../runs/brief.js";
import { assertModelId, assertRunName } from "../../runs/names.js";
import { assertMutable, filterByScope, ownershipOf, type RunOwner } from "../../runs/owner.js";
import { assertInsideRoots, defaultAllowedRoot, repoRootOf } from "../../runs/worktree.js";
import { DEFAULT_USAGE_LIMIT, MAX_USAGE_LIMIT, usageReport } from "../../usage/stats.js";
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
        "Provider limit errors requeue the unit, shrink that lane by one and back off; six consecutive hits stop the pool.",
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
        forbid: z
          .array(z.string().max(40))
          .max(20)
          .optional()
          .describe('Commands workers must not run (default ["git", "cargo"]).'),
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
          forbid: validateForbid(args.forbid),
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
        const started = startPool(config);
        return {
          ...started,
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
        return {
          scope,
          pools: dirs.map((dir) => ({ ...buildPoolStatus(dir), ...poolOwnership(dir, me) })),
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
