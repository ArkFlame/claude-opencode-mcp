import { describe, expect, it } from "vitest";
import {
  isTransientError,
  type RampConfig,
  RampGate,
  rampCap,
  rampConfigFromEnv,
  transientBackoffMs,
} from "../../src/runs/ramp.js";

const CONFIG: RampConfig = { initial: 8, step: 6, intervalMs: 20_000, gapMs: 300 };

describe("ramp schedule", () => {
  it("admits the initial batch at once and grows by step each interval", () => {
    expect(rampCap(0, CONFIG, 100)).toBe(8);
    expect(rampCap(19_999, CONFIG, 100)).toBe(8);
    expect(rampCap(20_000, CONFIG, 100)).toBe(14);
    expect(rampCap(40_000, CONFIG, 100)).toBe(20);
  });

  it("stops at the cap and disables itself when the interval is 0", () => {
    expect(rampCap(10_000_000, CONFIG, 10)).toBe(10);
    expect(rampCap(0, { ...CONFIG, intervalMs: 0 }, 50)).toBe(50);
  });

  it("halves the step through the scale", () => {
    expect(rampCap(20_000, CONFIG, 100, 0.5)).toBe(11);
  });

  it("spaces launches by the gap while ramping and admits at once after the cap", () => {
    const gate = new RampGate(CONFIG);
    expect(gate.admitAt(0, 0, 10)).toBeNull();
    gate.launched(0);
    expect(gate.admitAt(100, 1, 10)).toBe(300);
    expect(gate.admitAt(300, 1, 10)).toBeNull();
    expect(gate.admitAt(300, 10, 10)).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not space launches once the cap is reached", () => {
    const gate = new RampGate(CONFIG);
    gate.launched(0);
    expect(gate.admitAt(0, 1, 8)).toBeNull();
    expect(gate.admitAt(0, 2, 8)).toBeNull();
  });

  it("pauses admission after a streak of transient failures", () => {
    const gate = new RampGate(CONFIG);
    gate.noteTransient(1_000);
    gate.noteTransient(1_000);
    expect(gate.admitAt(1_000, 0, 10)).toBeNull();
    gate.noteTransient(1_000);
    expect(gate.admitAt(2_000, 0, 10)).toBe(31_000);
    expect(gate.admitAt(31_000, 0, 10)).toBeNull();
  });
});

describe("transient errors", () => {
  it("classifies store and connection failures as transient", () => {
    expect(isTransientError('{"message":"Failed to execute statement"}')).toBe(true);
    expect(isTransientError("UnexpectedStatus: 500 Internal Server Error")).toBe(true);
    expect(isTransientError("fetch failed: ECONNRESET")).toBe(true);
    expect(isTransientError("database is locked")).toBe(true);
  });

  it("ignores ordinary errors and empty text", () => {
    expect(isTransientError("rate limit exceeded, retry later")).toBe(false);
    expect(isTransientError("UnexpectedStatus: 404 Not Found")).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it("backs off 2s, 5s and 10s with plus or minus 20 percent jitter", () => {
    expect(transientBackoffMs(1, () => 0.5)).toBe(2_000);
    expect(transientBackoffMs(2, () => 0.5)).toBe(5_000);
    expect(transientBackoffMs(3, () => 0.5)).toBe(10_000);
    expect(transientBackoffMs(1, () => 0)).toBe(1_600);
    expect(transientBackoffMs(3, () => 0.999)).toBe(11_996);
  });
});

describe("ramp env", () => {
  it("uses the documented defaults and rejects out-of-range values", () => {
    expect(rampConfigFromEnv({})).toEqual({
      initial: 8,
      step: 6,
      intervalMs: 20_000,
      gapMs: 300,
    });
    expect(() => rampConfigFromEnv({ CLAUDE_OPENCODE_RAMP_STEP: "0" })).toThrow();
  });
});
