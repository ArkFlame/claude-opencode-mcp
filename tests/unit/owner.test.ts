import { describe, expect, it } from "vitest";
import { foreignCwdHolder } from "../../src/runs/lock.js";
import {
  applyClientName,
  assertMutable,
  createRunOwner,
  deriveOwnerId,
  filterByScope,
  labelFor,
  ownershipOf,
  procStartTicks,
  summarizeOwners,
} from "../../src/runs/owner.js";
import type { RunRecord } from "../../src/runs/store.js";

const ME = { id: "100-5555", label: "claude-code#aaaa", pid: 4321, ppid: 100 };
const OTHER = { id: "200-7777", label: "claude-code#bbbb" };

/** A /proc/<pid>/stat line whose comm contains spaces and a parenthesis, as real ones can. */
function statLine(comm: string, startTicks: string): string {
  const after = ["S", "1", "100", "100", "0", "-1", "4194560", "0", "0", "0", "0"];
  // Fields 3..21 come before starttime (field 22); pad so starttime lands on field 22.
  while (after.length < 19) after.push("0");
  after.push(startTicks);
  return `4321 (${comm}) ${after.join(" ")} 0 0 0`;
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    name: "task",
    status: "running",
    cwd: "/repo",
    branch: null,
    agent: null,
    model: "opencode-go/x",
    model_note: null,
    allow_shared_cwd: false,
    attempts: 1,
    owner_pid: ME.pid,
    pid: null,
    pgid: null,
    created: 1,
    started: 2,
    finished: null,
    last_activity: 2,
    exit_code: null,
    signal: null,
    final_text: null,
    final_truncated: false,
    last_line: null,
    error: null,
    prompt_file: "/tmp/p.md",
    log_file: "/tmp/p.log",
    ...overrides,
  };
}

describe("owner derivation", () => {
  it("reads the start time of the parent from /proc stat field 22", () => {
    const readFile = () => statLine("opencode worker", "987654");
    expect(procStartTicks(100, readFile)).toBe("987654");
  });

  it("returns null when /proc is unavailable", () => {
    expect(
      procStartTicks(100, () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  it("builds the id from ppid and its start time, stable across server restarts", () => {
    const readFile = () => statLine("claude", "42");
    const first = deriveOwnerId({ env: {}, pid: 500, ppid: 100, readFile });
    const restarted = deriveOwnerId({ env: {}, pid: 999, ppid: 100, readFile });
    expect(first).toBe("100-42");
    expect(restarted).toBe(first);
  });

  it("falls back to pid and time when the parent cannot be inspected", () => {
    const id = deriveOwnerId({
      env: {},
      pid: 500,
      ppid: 100,
      now: 77,
      readFile: () => {
        throw new Error("no proc");
      },
    });
    expect(id).toBe("500-77");
  });

  it("uses CLAUDE_OPENCODE_OWNER verbatim as the id", () => {
    expect(deriveOwnerId({ env: { CLAUDE_OPENCODE_OWNER: "my-session" }, pid: 1, ppid: 2 })).toBe(
      "my-session",
    );
  });

  it("labels with the client name plus a short id, and lets CLAUDE_OPENCODE_LABEL win", () => {
    const owner = createRunOwner({ env: {}, pid: 500, ppid: 100, now: 1, readFile: () => "" });
    expect(owner.label).toMatch(/^mcp#[0-9a-f]{4}$/);
    applyClientName(owner, "claude-code", {});
    expect(owner.label).toMatch(/^claude-code#[0-9a-f]{4}$/);
    expect(labelFor(owner, { CLAUDE_OPENCODE_LABEL: "docs-lane" })).toBe("docs-lane");
  });

  it("keeps the same short id for the same owner id", () => {
    const a = createRunOwner({ env: { CLAUDE_OPENCODE_OWNER: "s1" }, pid: 1, ppid: 2 });
    const b = createRunOwner({ env: { CLAUDE_OPENCODE_OWNER: "s1" }, pid: 9, ppid: 2 });
    applyClientName(a, "claude-code", {});
    applyClientName(b, "claude-code", {});
    expect(a.label).toBe(b.label);
  });
});

describe("ownership", () => {
  it("marks records with the same owner_id as mine and others as foreign", () => {
    const mine = ownershipOf({ owner_id: ME.id, owner_pid: 1 }, ME);
    const other = ownershipOf({ owner_id: OTHER.id, owner_label: OTHER.label, owner_pid: 1 }, ME);
    expect(mine).toMatchObject({ mine: true, foreign: false });
    expect(other).toMatchObject({ mine: false, foreign: true, owner_label: OTHER.label });
  });

  it("treats legacy records by owner_pid: equal is mine, a live other pid is foreign", () => {
    const alive = () => true;
    expect(ownershipOf({ owner_pid: ME.pid }, ME, alive).mine).toBe(true);
    expect(ownershipOf({ owner_pid: 77 }, ME, alive).foreign).toBe(true);
  });

  it("treats a legacy record whose owner is dead as unowned, neither mine nor foreign", () => {
    const view = ownershipOf({ owner_pid: 77 }, ME, () => false);
    expect(view).toMatchObject({ mine: false, foreign: false });
  });

  it("scopes lists to mine by default and keeps everything for all", () => {
    const records = [
      record({ id: "a", owner_id: ME.id }),
      record({ id: "b", owner_id: OTHER.id, owner_label: OTHER.label }),
      record({ id: "c", owner_pid: ME.pid, owner_id: undefined }),
    ];
    expect(filterByScope(records, "mine", ME).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterByScope(records, "all", ME)).toHaveLength(3);
  });

  it("refuses mutation of a foreign record unless force is set, and names the owner", () => {
    const foreign = { id: "run-9", owner_id: OTHER.id, owner_label: OTHER.label, owner_pid: 1 };
    expect(() => assertMutable(foreign, ME, undefined)).toThrow(/claude-code#bbbb/);
    expect(() => assertMutable(foreign, ME, false)).toThrow(/force: true/);
    expect(() => assertMutable(foreign, ME, true)).not.toThrow();
  });

  it("allows mutation of mine and of unowned legacy records", () => {
    expect(() => assertMutable({ owner_id: ME.id, owner_pid: 1 }, ME, undefined)).not.toThrow();
    const deadLegacy = { owner_pid: 2147483646, owner_id: null };
    expect(() => assertMutable(deadLegacy, ME, undefined)).not.toThrow();
  });

  it("summarizes runs and running counts per owner", () => {
    const summary = summarizeOwners(
      [
        record({ owner_id: ME.id, status: "running" }),
        record({ owner_id: ME.id, status: "done" }),
        record({ owner_id: OTHER.id, owner_label: OTHER.label, status: "running" }),
      ],
      ME,
    );
    expect(summary).toEqual([
      { owner_id: ME.id, label: ME.label, runs: 2, running: 1 },
      { owner_id: OTHER.id, label: OTHER.label, runs: 1, running: 1 },
    ]);
  });
});

describe("shared cwd collision across sessions", () => {
  it("finds a running foreign run in the same cwd and ignores mine and queued ones", () => {
    const holder = record({ id: "h", owner_id: OTHER.id, owner_label: OTHER.label, cwd: "/repo" });
    const records = [
      record({ id: "mine", owner_id: ME.id, cwd: "/repo" }),
      record({ id: "queued", owner_id: OTHER.id, status: "queued", cwd: "/repo" }),
      holder,
    ];
    expect(foreignCwdHolder(records, "/repo", ME)?.id).toBe("h");
    expect(foreignCwdHolder(records, "/elsewhere", ME)).toBeNull();
  });

  it("counts a shared-cwd foreign run as a holder too, like a local one", () => {
    const shared = record({
      id: "s",
      owner_id: OTHER.id,
      owner_label: OTHER.label,
      allow_shared_cwd: true,
    });
    expect(foreignCwdHolder([shared], "/repo", ME)?.id).toBe("s");
  });
});
