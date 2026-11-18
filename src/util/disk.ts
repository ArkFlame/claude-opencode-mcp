import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MIN_FREE_MB = 1024;
const BYTES_PER_MB = 1024 * 1024;

/** Free-space floor below which new runs are refused. Env: CLAUDE_OPENCODE_MIN_FREE_MB. */
export function minFreeMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAUDE_OPENCODE_MIN_FREE_MB?.trim();
  if (!raw) return DEFAULT_MIN_FREE_MB;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MIN_FREE_MB;
}

/** Directory opencode keeps its database, auth and state in (XDG data home). */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".local", "share"), "opencode");
}

/** Free megabytes available to unprivileged users on the filesystem holding `target`. */
export function freeMbAt(target: string): number | null {
  let probe = path.resolve(target);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const stats = fs.statfsSync(probe);
    return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / BYTES_PER_MB);
  } catch {
    return null;
  }
}

export interface LowDisk {
  path: string;
  free_mb: number;
  min_free_mb: number;
}

/** First path whose filesystem has less than `minMb` free. Unknown free space is not low. */
export function findLowDisk(
  paths: readonly string[],
  minMb: number,
  freeMb: (target: string) => number | null = freeMbAt,
): LowDisk | null {
  for (const target of paths) {
    const free = freeMb(target);
    if (free !== null && free < minMb) return { path: target, free_mb: free, min_free_mb: minMb };
  }
  return null;
}
