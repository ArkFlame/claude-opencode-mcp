import { execFile } from "node:child_process";
import { assertModelId } from "./names.js";

export const DEFAULT_RUN_MODEL = "opencode/hy4-flash-free";
const MODEL_LIST_TTL_MS = 5 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 60_000;

let cache: { binary: string; at: number; models: string[] } | null = null;

/** Parse `opencode models` output: one `provider/model` id per line. */
export function parseModelList(stdout: string): string[] {
  const seen = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._/:#-]+$/.test(line)) seen.add(line);
  }
  return [...seen];
}

/** Model ids from `opencode models`, cached for five minutes. Null when the CLI cannot list. */
export function listModels(
  binary: string,
  options: { refresh?: boolean } = {},
): Promise<string[] | null> {
  if (
    !options.refresh &&
    cache &&
    cache.binary === binary &&
    Date.now() - cache.at < MODEL_LIST_TTL_MS
  ) {
    return Promise.resolve(cache.models);
  }
  return new Promise((resolve) => {
    execFile(
      binary,
      ["models"],
      { timeout: MODEL_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const models = parseModelList(String(stdout));
        if (models.length === 0) {
          resolve(null);
          return;
        }
        cache = { binary, at: Date.now(), models };
        resolve(models);
      },
    );
  });
}

export interface ResolvedRunModel {
  model: string;
  /** Null when the requested model was used as given. */
  note: string | null;
}

/**
 * Pick the model for a run. A bare id (no provider) matches a unique listed provider/model.
 * A requested model that the CLI does not list falls back to the configured default.
 * When the list is unavailable the requested id is used unverified.
 */
export function resolveRunModel(
  requested: string | null,
  fallback: string,
  listed: string[] | null,
): ResolvedRunModel {
  const wanted = requested?.trim() || fallback;
  assertModelId(wanted);
  if (!listed) {
    return { model: wanted, note: requested ? "model list unavailable; used as given" : null };
  }
  if (listed.includes(wanted)) return { model: wanted, note: null };
  if (!wanted.includes("/")) {
    const matches = listed.filter((id) => id.endsWith(`/${wanted}`));
    if (matches.length === 1 && matches[0]) return { model: matches[0], note: null };
  }
  if (wanted === fallback) {
    return { model: wanted, note: `model ${wanted} is not in the opencode model list` };
  }
  const usable = listed.includes(fallback) ? fallback : wanted;
  return {
    model: usable,
    note: `requested model ${wanted} is not listed; fell back to ${usable}`,
  };
}
