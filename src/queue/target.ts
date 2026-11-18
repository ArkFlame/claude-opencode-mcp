import path from "node:path";
import { BridgeError } from "../errors.js";
import { readPoolConfig } from "../pool/launch.js";
import { type PoolConfig, readUnit, type UnitRecord } from "../pool/state.js";
import type { RunStore } from "../runs/store.js";
import type { AgentSession } from "../types/index.js";
import { assertRunId, inboxFileFor } from "./inbox.js";

export type QueueTarget =
  | {
      kind: "pool-unit";
      runId: string;
      status: string;
      poolDir: string;
      key: string;
      config: PoolConfig;
      unit: UnitRecord | null;
      inboxFile: string;
    }
  | {
      kind: "session";
      runId: string;
      status: string;
      session: AgentSession;
      inboxFile: string;
    };

export interface TargetSources {
  store: RunStore;
  runsDir: string;
  getSession(id: string): AgentSession | null | undefined;
}

/** Resolve a run id to a pool unit (run record with a pool) or to an OpenCode session. */
export function resolveQueueTarget(sources: TargetSources, runId: string): QueueTarget {
  assertRunId(runId);
  const record = sources.store.get(runId);
  if (record) {
    if (!record.pool) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "queue_message delivers to pool units and OpenCode sessions; background CLI runs are not supported.",
      );
    }
    const poolDir = path.dirname(record.log_file);
    const config = readPoolConfig(poolDir);
    if (!config) throw new BridgeError("INVALID_ARGUMENT", `Pool config is missing for ${runId}.`);
    const key = path.basename(record.log_file, ".log");
    return {
      kind: "pool-unit",
      runId,
      status: record.status,
      poolDir,
      key,
      config,
      unit: readUnit(poolDir, key),
      inboxFile: inboxFileFor(sources.runsDir, runId),
    };
  }
  const session = sources.getSession(runId);
  if (session) {
    return {
      kind: "session",
      runId,
      status: session.status,
      session,
      inboxFile: inboxFileFor(sources.runsDir, runId),
    };
  }
  throw new BridgeError("INVALID_ARGUMENT", `Unknown run: ${runId}`);
}
