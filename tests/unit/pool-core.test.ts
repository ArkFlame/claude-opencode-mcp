import { describe, expect, it } from "vitest";
import { areaOf, parsePorcelainZ, planCommits } from "../../src/git/auto-commit.js";
import {
  applyLimitHit,
  CONSECUTIVE_LIMIT_STOP,
  canStart,
  etaFor,
  hasStatusLine,
  hubNames,
  isLimitFailure,
  isLimitTail,
  type LaneState,
  LIMIT_BACKOFF_MS,
  pickLane,
  renderBrief,
  rsNamesIn,
  unitKeyOf,
} from "../../src/pool/core.js";
import { globToRegExp, splitUnitsGlob } from "../../src/pool/units.js";
import { buildPrompt, DEFAULT_FORBIDDEN_COMMANDS, validateForbid } from "../../src/runs/brief.js";

describe("pool conflicts", () => {
  it("extracts .rs basenames from unit text", () => {
    const names = rsNamesIn("Edit crates/x/src/blocks/door.rs and mod.rs, not foo.rsx.");
    expect([...names].sort()).toEqual(["door.rs", "mod.rs"]);
  });

  it("never runs two units that share an exclusive name", () => {
    const running = [{ key: "a", names: new Set(["door.rs"]) }];
    expect(canStart(new Set(["door.rs"]), running, new Set(), 2)).toBe(false);
    expect(canStart(new Set(["gate.rs"]), running, new Set(), 2)).toBe(true);
  });

  it("caps generic and hub names by per_file_cap instead of excluding them", () => {
    const running = [
      { key: "a", names: new Set(["mod.rs"]) },
      { key: "b", names: new Set(["mod.rs"]) },
    ];
    expect(canStart(new Set(["mod.rs"]), running, new Set(), 2)).toBe(false);
    expect(canStart(new Set(["mod.rs"]), running.slice(0, 1), new Set(), 2)).toBe(true);
    const hub = new Set(["core.rs"]);
    const onCore = [
      { key: "a", names: new Set(["core.rs"]) },
      { key: "b", names: new Set(["core.rs"]) },
    ];
    expect(canStart(new Set(["core.rs"]), onCore.slice(0, 1), hub, 2)).toBe(true);
    expect(canStart(new Set(["core.rs"]), onCore, hub, 2)).toBe(false);
  });

  it("flags names that appear in at least eight units as hubs", () => {
    const sets = Array.from({ length: 8 }, () => new Set(["core.rs", "x.rs"]));
    sets.push(new Set(["x.rs"]));
    expect([...hubNames(sets)].sort()).toEqual(["core.rs", "x.rs"]);
    expect([...hubNames(sets.slice(0, 7))]).toEqual([]);
  });
});

describe("lane selection and limit penalties", () => {
  const lane = (overrides: Partial<LaneState>): LaneState => ({
    name: "a",
    model: "p/m",
    cap: 2,
    effectiveCap: 2,
    hits: 0,
    backoffUntil: 0,
    ...overrides,
  });

  it("picks the first lane with a free slot that is not backing off", () => {
    const lanes = [lane({ name: "a", backoffUntil: 500 }), lane({ name: "b" })];
    expect(pickLane(lanes, new Map(), 100)?.name).toBe("b");
    expect(pickLane(lanes, new Map([["b", 2]]), 100)).toBeNull();
    expect(pickLane(lanes, new Map(), 600)?.name).toBe("a");
  });

  it("shrinks the lane by one and backs off 120 s times its hit count, never below zero", () => {
    const state = lane({ cap: 2, effectiveCap: 2 });
    applyLimitHit(state, 1_000);
    expect(state.effectiveCap).toBe(1);
    expect(state.backoffUntil).toBe(1_000 + LIMIT_BACKOFF_MS);
    applyLimitHit(state, 1_000);
    expect(state.effectiveCap).toBe(0);
    expect(state.backoffUntil).toBe(1_000 + 2 * LIMIT_BACKOFF_MS);
    applyLimitHit(state, 1_000);
    expect(state.effectiveCap).toBe(0);
  });

  it("matches the provider limit markers case-insensitively", () => {
    for (const text of [
      "usage limit reached",
      "Insufficient balance",
      "HTTP 429",
      "tier_limit_exceeded",
      "Provider blocked",
    ]) {
      expect(isLimitTail(text), text).toBe(true);
    }
    expect(isLimitTail("all tests pass")).toBe(false);
  });

  it("ignores limit words in a run that finished with a Status line", () => {
    const tail = "discussed the timeout path\nStatus: PASS\n";
    expect(hasStatusLine(tail)).toBe(true);
    expect(isLimitFailure(0, tail)).toBe(false);
    expect(isLimitFailure(1, tail)).toBe(true);
    expect(isLimitFailure(0, "rate limit exceeded")).toBe(true);
  });

  it("stops after six consecutive hits", () => {
    expect(CONSECUTIVE_LIMIT_STOP).toBe(6);
  });
});

describe("pool reporting helpers", () => {
  it("computes ETA from completions in the last ten minutes", () => {
    const now = 1_000_000;
    const finished = [now - 60_000, now - 120_000, now - 700_000];
    const eta = etaFor(10, finished, now);
    expect(eta.perMinute).toBeCloseTo(0.2, 5);
    expect(eta.etaMinutes).toBeCloseTo(50, 5);
    expect(etaFor(3, [], now).etaMinutes).toBeNull();
  });

  it("names units from their file name and renders placeholders", () => {
    expect(unitKeyOf("/x/units/door-open.md")).toBe("door-open");
    expect(unitKeyOf("/x/units/weird name!.md")).toBe("weird-name");
    expect(
      renderBrief("{{UNIT_PATH}} {{UNIT_NAME}} {{UNIT_KEY}}", {
        path: "/p",
        name: "n.md",
        key: "k",
      }),
    ).toBe("/p n.md k");
  });
});

describe("unit globs", () => {
  it("requires an absolute glob with wildcards in the file name only", () => {
    expect(() => splitUnitsGlob("units/*.md")).toThrow();
    expect(() => splitUnitsGlob("/a/*/units/*.md")).toThrow();
    expect(() => splitUnitsGlob("/a/units/readme.md")).toThrow();
    expect(splitUnitsGlob("/a/units/*.md")).toEqual({ dir: "/a/units", pattern: "*.md" });
  });

  it("matches file names with * and ? only", () => {
    const matcher = globToRegExp("u-?.md*");
    expect(matcher.test("u-1.md")).toBe(true);
    expect(matcher.test("u-12.md")).toBe(false);
    expect(matcher.test("ux1.md")).toBe(false);
  });
});

describe("shared-checkout brief options", () => {
  it("defaults the forbid list and rejects non-command entries", () => {
    expect(validateForbid(undefined)).toEqual(DEFAULT_FORBIDDEN_COMMANDS);
    expect(validateForbid(["git", "npm"])).toEqual(["git", "npm"]);
    expect(() => validateForbid(["rm -rf"])).toThrow();
  });
});

describe("auto-commit planning", () => {
  it("groups paths by crate or docs area with a conventional subject", () => {
    const plans = planCommits([
      "crates/pumpkin-world/src/a.rs",
      "crates/pumpkin-world/src/b.rs",
      "docs/QUEUE.md",
      "src/mcp/x.ts",
      "node_modules/x/index.js",
      ".env.local",
    ]);
    expect(plans.map((plan) => [plan.area, plan.type, plan.paths.length])).toEqual([
      ["docs", "docs", 1],
      ["mcp", "fix", 1],
      ["pumpkin-world", "fix", 2],
    ]);
    expect(plans[2]?.subject).toBe("fix(pumpkin-world): apply worker changes to 2 files");
  });

  it("maps paths to areas and parses rename entries", () => {
    expect(areaOf("README.md")).toBe("root");
    expect(areaOf(".github/workflows/ci.yml")).toBe("github");
    expect(parsePorcelainZ(" M src/a.ts\0R  new.ts\0old.ts\0?? docs/x.md\0")).toEqual([
      "src/a.ts",
      "new.ts",
      "docs/x.md",
    ]);
  });
});

describe("shared-mode prompts", () => {
  it("appends the forbid list only for shared runs", () => {
    const plain = buildPrompt({ header: null, task: "t", brief: null, readPaths: [] });
    expect(plain).not.toContain("# Shared checkout");
    const shared = buildPrompt({
      header: null,
      task: "t",
      brief: null,
      readPaths: [],
      shared: { forbid: ["git"] },
    });
    expect(shared).toContain("# Shared checkout");
    expect(shared).toContain("`git`");
  });
});
