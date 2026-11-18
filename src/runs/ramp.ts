/**
 * Staggered start for OpenCode launches and transient-failure handling.
 *
 * A burst of simultaneous launches trips opencode's sqlite store ("Failed to execute statement",
 * 5xx, ECONNRESET). The gate admits a few launches first, then more on a fixed schedule. Pure
 * schedule math lives here; RampGate keeps the small amount of state the schedulers need.
 */
import { BridgeError } from "../errors.js";

export const RAMP_INITIAL_DEFAULT = 8;
export const RAMP_STEP_DEFAULT = 6;
export const RAMP_INTERVAL_MS_DEFAULT = 20_000;
export const LAUNCH_GAP_MS_DEFAULT = 300;

export const TRANSIENT_PATTERN =
  /Failed to execute statement|UnexpectedStatus: 5\d\d|ECONNRESET|database is locked|SQLITE/i;
/** Retries per run for transient errors, separate from the normal retry. */
export const TRANSIENT_MAX_RETRIES = 3;
/** Backoff before retry 1, 2 and 3. */
export const TRANSIENT_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
/** Transient failures in a row across runs that pause admission and halve the ramp step. */
export const TRANSIENT_STREAK_PAUSE = 3;
export const TRANSIENT_PAUSE_MS = 30_000;

export interface RampConfig {
  initial: number;
  step: number;
  /** 0 disables the ramp: the full cap is admitted at once. */
  intervalMs: number;
  /** Minimum spacing between launches while the ramp is below its cap. */
  gapMs: number;
}

/** True when opencode error text is a transient store or connection failure. */
export function isTransientError(text: string | null | undefined): boolean {
  return typeof text === "string" && TRANSIENT_PATTERN.test(text);
}

/**
 * Jittered backoff before transient retry `retry` (1-based). `random` returns [0, 1) and is
 * injectable so tests stay deterministic. The jitter is +-20 percent.
 */
export function transientBackoffMs(retry: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(retry, 1), TRANSIENT_BACKOFF_MS.length) - 1;
  const base = TRANSIENT_BACKOFF_MS[index] ?? TRANSIENT_BACKOFF_MS[0];
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** Resolve after `ms`, or at once when `signal` aborts first. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Launch cap `elapsedMs` after a cold start. `scale` shrinks the step after transient pauses. */
export function rampCap(elapsedMs: number, config: RampConfig, max: number, scale = 1): number {
  if (config.intervalMs <= 0) return max;
  const steps = Math.max(0, Math.floor(elapsedMs / config.intervalMs));
  const step = Math.max(1, Math.floor(config.step * scale));
  return Math.min(max, config.initial + step * steps);
}

/** Next instant after `elapsedMs` at which the cap grows, measured from the cold start. */
export function nextRampStepAt(elapsedMs: number, config: RampConfig): number {
  const steps = Math.floor(elapsedMs / config.intervalMs) + 1;
  return steps * config.intervalMs;
}

function envInt(env: NodeJS.ProcessEnv, name: string, min: number, max: number, fallback: number) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BridgeError("CONFIG_INVALID", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/** Ramp settings from CLAUDE_OPENCODE_RAMP_* and CLAUDE_OPENCODE_LAUNCH_GAP_MS. */
export function rampConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RampConfig {
  return {
    initial: envInt(env, "CLAUDE_OPENCODE_RAMP_INITIAL", 1, 64, RAMP_INITIAL_DEFAULT),
    step: envInt(env, "CLAUDE_OPENCODE_RAMP_STEP", 1, 64, RAMP_STEP_DEFAULT),
    intervalMs: envInt(
      env,
      "CLAUDE_OPENCODE_RAMP_INTERVAL_MS",
      0,
      3_600_000,
      RAMP_INTERVAL_MS_DEFAULT,
    ),
    gapMs: envInt(env, "CLAUDE_OPENCODE_LAUNCH_GAP_MS", 0, 60_000, LAUNCH_GAP_MS_DEFAULT),
  };
}

/**
 * Admission state for one scheduler. The ramp restarts whenever the scheduler has nothing
 * active, so only a cold start or restart is staggered; once the cap is reached, freed slots
 * refill at once.
 */
export class RampGate {
  private epoch: number | null = null;
  private lastLaunch = Number.NEGATIVE_INFINITY;
  private pausedUntil = Number.NEGATIVE_INFINITY;
  private scale = 1;
  private transientStreak = 0;

  constructor(private readonly config: RampConfig) {}

  /**
   * Null when one more launch may start now. Otherwise the epoch-ms instant to check again, or
   * Infinity when only a freed slot can help.
   */
  admitAt(now: number, active: number, max: number): number | null {
    if (active === 0) this.epoch = now;
    if (active >= max) return Number.POSITIVE_INFINITY;
    if (now < this.pausedUntil) return this.pausedUntil;
    if (this.config.intervalMs <= 0) return null;
    const epoch = this.epoch ?? now;
    const elapsed = now - epoch;
    const cap = rampCap(elapsed, this.config, max, this.scale);
    if (active < cap) {
      if (cap < max && now - this.lastLaunch < this.config.gapMs) {
        return this.lastLaunch + this.config.gapMs;
      }
      return null;
    }
    return epoch + nextRampStepAt(elapsed, this.config);
  }

  launched(now: number): void {
    this.lastLaunch = now;
  }

  /** A run or unit finished without a transient error. Ends the streak. */
  noteOk(): void {
    this.transientStreak = 0;
  }

  /** A transient failure. Pauses admission and halves the step after a streak of them. */
  noteTransient(now: number): void {
    this.transientStreak += 1;
    if (this.transientStreak < TRANSIENT_STREAK_PAUSE) return;
    this.transientStreak = 0;
    this.pausedUntil = now + TRANSIENT_PAUSE_MS;
    this.scale = Math.max(1 / this.config.step, this.scale / 2);
  }
}
