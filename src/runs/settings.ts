import os from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import { DEFAULT_RUN_MODEL } from "./models.js";

export interface RunSettings {
  model: string;
  agent: string;
  timeoutMs: number;
  idleMs: number;
  maxParallel: number;
  retry: boolean;
  headerFile: string | null;
  /** Empty means: the parent directory of the repository (holds sibling *-wt dirs). */
  allowedRoots: string[];
  runsDir: string;
  binary: string;
}

function envInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BridgeError("CONFIG_INVALID", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function defaultRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_OPENCODE_RUNS_DIR?.trim();
  if (override) return path.resolve(override);
  const xdg = env.XDG_CACHE_HOME?.trim();
  const base = xdg || path.join(os.homedir(), ".cache");
  return path.join(base, "claude-opencode-mcp", "runs");
}

/** Merge config file values with environment overrides (env wins). */
export function resolveRunSettings(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): RunSettings {
  const runs = config.runs;
  const timeoutS = envInt(env, "CLAUDE_OPENCODE_TIMEOUT", 1, 86_400) ?? runs.timeout;
  const idleS = envInt(env, "CLAUDE_OPENCODE_IDLE_TIMEOUT", 1, 86_400) ?? runs.idleTimeout;
  const maxParallel = envInt(env, "CLAUDE_OPENCODE_MAX_PARALLEL", 1, 64) ?? runs.maxParallel;
  const model = env.CLAUDE_OPENCODE_MODEL?.trim() || runs.model || DEFAULT_RUN_MODEL;
  const headerRaw = env.CLAUDE_OPENCODE_BRIEF_HEADER?.trim() || runs.briefHeaderFile;
  const rootsRaw = env.CLAUDE_OPENCODE_ALLOWED_ROOTS?.trim();
  const allowedRoots = rootsRaw
    ? rootsRaw
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(entry))
    : config.workspace.allowedRoots.map((entry) => path.resolve(entry));
  return {
    model,
    agent: runs.agent,
    timeoutMs: timeoutS * 1000,
    idleMs: idleS * 1000,
    maxParallel,
    retry: runs.retry,
    headerFile: headerRaw ? path.resolve(headerRaw) : null,
    allowedRoots,
    runsDir: defaultRunsDir(env),
    binary: env.CLAUDE_OPENCODE_BIN?.trim() || config.opencode.binary || "opencode",
  };
}
