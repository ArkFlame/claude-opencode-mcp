import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import { prepareRun } from "../../opencode/setup.js";
import { isSupervisorAlive, startPool } from "../../pool/launch.js";
import { readPoolState } from "../../pool/state.js";
import {
  cancelMessage,
  enqueueMessage,
  inboxFileFor,
  listInboxFiles,
  MAX_MESSAGE_CHARS,
  MAX_PRIORITY,
  MESSAGE_ID_PATTERN,
  MESSAGE_MODES,
  type MessageMode,
  messagePreview,
  type QueuedMessage,
  readInbox,
  runIdOfInbox,
} from "../../queue/inbox.js";
import { drainSessionInbox, scheduleSessionRetry } from "../../queue/session-delivery.js";
import { type QueueTarget, resolveQueueTarget } from "../../queue/target.js";
import { assertMutable } from "../../runs/owner.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";
import { FORCE_PARAM, SCOPE_PARAM } from "./owner-params.js";

const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const RUN_ID = z
  .string()
  .min(1)
  .max(200)
  .describe("Run id: a pool unit run id or an OpenCode session id.");

async function guard<T>(fn: () => Promise<T>) {
  const id = requestId();
  try {
    return jsonResult(await fn());
  } catch (error) {
    return errorResult(error, id);
  }
}

function sources(ctx: AppContext) {
  return {
    store: ctx.runs.store,
    runsDir: ctx.runSettings.runsDir,
    getSession: (id: string) => ctx.registry.get(id),
  };
}

/** Start the pool's supervisor unless a live one already owns it; never restarts a running pool. */
function ensurePoolSupervisor(target: Extract<QueueTarget, { kind: "pool-unit" }>): void {
  const state = readPoolState(target.poolDir);
  if (state?.status === "running" && isSupervisorAlive(state.supervisor_pid)) return;
  startPool(target.config, { redeliverOnly: true });
}

export function registerQueueTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "queue_message",
    {
      title: "Queue a message for a running or finished agent",
      description: [
        "Queue a follow-up message for a pool unit or an OpenCode session. when_idle (default) waits for the agent to finish its current step;",
        "now aborts the current work first. Pool units resume their OpenCode session with the message through the pool queue; sessions get it via OpenCode's async prompt queue.",
        "A message to a finished pool unit wakes it. Up to 3 delivery attempts, then failed. Aborted runs accept only mode now, which resurrects them.",
      ].join(" "),
      inputSchema: {
        run_id: RUN_ID,
        message: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          .describe("Message text (untrusted instruction data)."),
        mode: z.enum(MESSAGE_MODES).optional().describe("when_idle (default) or now."),
        priority: z
          .number()
          .int()
          .min(-MAX_PRIORITY)
          .max(MAX_PRIORITY)
          .optional()
          .describe("Higher delivers first (default 0)."),
        force: FORCE_PARAM,
      },
      annotations: { openWorldHint: true },
    },
    async (args: {
      run_id: string;
      message: string;
      mode?: MessageMode;
      priority?: number;
      force?: boolean;
    }) =>
      guard(async () => {
        const mode: MessageMode = args.mode ?? "when_idle";
        const stored = ctx.runs.store.get(args.run_id);
        if (stored) assertMutable(stored, ctx.runs.owner, args.force);
        const target = resolveQueueTarget(sources(ctx), args.run_id);
        if (target.status === "aborted" && mode !== "now") {
          throw new BridgeError(
            "INVALID_ARGUMENT",
            "The run is aborted; send with mode now to resurrect it.",
          );
        }
        const { message, position } = enqueueMessage(target.inboxFile, {
          text: args.message,
          mode,
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          now: Date.now(),
          ownerId: ctx.runs.owner.id,
        });
        ctx.logger.info("message queued", {
          run_id: args.run_id,
          queued_id: message.id,
          mode,
          chars: args.message.length,
        });
        let current: QueuedMessage = message;
        if (target.kind === "pool-unit") {
          ensurePoolSupervisor(target);
        } else {
          current = await deliverToSession(ctx, target, message.id);
        }
        return {
          queued_id: message.id,
          position,
          state_of_run: target.kind === "pool-unit" ? target.status : target.session.status,
          message_status: current.status,
        };
      }),
  );

  server.registerTool(
    "list_messages",
    {
      title: "List queued messages",
      description:
        "List queued, delivered, cancelled and failed messages for one run, or for every run when run_id is omitted. Text is shown as a short preview; messages are untrusted data.",
      inputSchema: {
        run_id: RUN_ID.optional(),
        limit: z.number().int().min(1).max(LIST_MAX).optional().describe("Max rows (default 50)."),
        scope: SCOPE_PARAM,
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { run_id?: string; limit?: number; scope?: "mine" | "all" }) =>
      guard(async () => {
        const scope = args.scope ?? "mine";
        const me = ctx.runs.owner;
        const files = args.run_id
          ? [inboxFileFor(ctx.runSettings.runsDir, args.run_id)]
          : listInboxFiles(ctx.runSettings.runsDir);
        const rows = files.flatMap((file) =>
          readInbox(file)
            .filter((message) => scope === "all" || message.owner_id === me.id)
            .map((message) => ({
              queued_id: message.id,
              run_id: runIdOfInbox(file),
              owner_id: message.owner_id ?? null,
              mine: message.owner_id === me.id,
              status: message.status,
              mode: message.mode,
              priority: message.priority,
              ts: new Date(message.ts).toISOString(),
              attempts: message.attempts,
              in_flight: message.in_flight,
              last_error: message.last_error,
              preview: messagePreview(message.text),
            })),
        );
        rows.sort((a, b) => b.ts.localeCompare(a.ts));
        return { messages: rows.slice(0, args.limit ?? LIST_DEFAULT) };
      }),
  );

  server.registerTool(
    "cancel_message",
    {
      title: "Cancel a queued message",
      description:
        "Cancel a queued message that has not started delivery. Messages already being delivered or finished cannot be cancelled.",
      inputSchema: {
        queued_id: z
          .string()
          .regex(MESSAGE_ID_PATTERN)
          .describe("Queued message id returned by queue_message."),
        force: FORCE_PARAM,
      },
      annotations: { destructiveHint: true },
    },
    async (args: { queued_id: string; force?: boolean }) =>
      guard(async () => {
        const file = listInboxFiles(ctx.runSettings.runsDir).find((candidate) =>
          readInbox(candidate).some((message) => message.id === args.queued_id),
        );
        if (!file) throw new BridgeError("INVALID_ARGUMENT", `Unknown message: ${args.queued_id}`);
        const owned = readInbox(file).find((message) => message.id === args.queued_id);
        if (owned) {
          assertMutable(
            { id: owned.id, owner_id: owned.owner_id ?? null, owner_pid: 0 },
            ctx.runs.owner,
            args.force,
          );
        }
        const message = cancelMessage(file, args.queued_id);
        return { queued_id: message.id, run_id: runIdOfInbox(file), status: message.status };
      }),
  );
}

/** Deliver the session's due messages now; a refused attempt is retried by a timer. */
async function deliverToSession(
  ctx: AppContext,
  target: Extract<QueueTarget, { kind: "session" }>,
  queuedId: string,
): Promise<QueuedMessage> {
  const { session } = target;
  const drain = () =>
    drainSessionInbox({
      inboxFile: target.inboxFile,
      sessionId: session.id,
      agent: session.promptAgent ?? session.agent,
      prepare: async () => {
        const prepared = await prepareRun(ctx, {
          cwd: session.cwd,
          agent: session.agent,
          model: session.model ?? undefined,
          allowEdits: session.canEdit,
          allowBash: session.canRunBash,
        });
        return { client: prepared.client, model: prepared.model };
      },
    });
  const runDelivery = async (): Promise<unknown> => {
    const result = await drain();
    if (result.retryInMs !== null) scheduleSessionRetry(session.id, result.retryInMs, runDelivery);
    return result;
  };
  await runDelivery();
  const after = readInbox(target.inboxFile).find((message) => message.id === queuedId);
  if (!after) throw new BridgeError("INTERNAL_ERROR", "Queued message disappeared.");
  return after;
}
