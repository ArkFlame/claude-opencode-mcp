import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyedMutex } from "../../src/runs/lock.js";
import { buildRunArgs, RunManager, summaryLine } from "../../src/runs/manager.js";
import { parseModelList, resolveRunModel } from "../../src/runs/models.js";
import { assertBaseRef, assertModelId, isValidRunName } from "../../src/runs/names.js";
import { boundText, MAX_RESULT_BYTES, summarizeFinal } from "../../src/runs/output.js";
import { type RunRecord, RunStore } from "../../src/runs/store.js";
import { createLogger } from "../../src/util/logger.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-core-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("run names", () => {
  it("accepts lowercase labels and rejects traversal, shell and uppercase input", () => {
    expect(isValidRunName("feature-1.a_b")).toBe(true);
    expect(isValidRunName("a".repeat(61))).toBe(true);
    for (const bad of ["", "-lead", "A", "../x", "a/b", "a;rm", "a b", "a".repeat(62), "x..y"]) {
      expect(isValidRunName(bad), bad).toBe(false);
    }
  });

  it("rejects bases that look like options or traversal", () => {
    expect(() => assertBaseRef("--upload-pack=evil")).toThrow();
    expect(() => assertBaseRef("main..x")).toThrow();
    expect(assertBaseRef("origin/main")).toBe("origin/main");
  });

  it("requires provider/model shape", () => {
    expect(assertModelId("opencode-go/hy4-flash-free")).toBe("opencode-go/hy4-flash-free");
    expect(() => assertModelId("bad model")).toThrow();
  });
});

describe("output bounding", () => {
  it("caps large text to 16 KB and marks it truncated", () => {
    const bounded = boundText("x".repeat(100_000));
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(bounded.originalBytes).toBe(100_000);
  });

  it("strips ANSI and keeps short text intact", () => {
    expect(boundText("\u001b[31mred\u001b[0m")).toEqual({
      text: "red",
      truncated: false,
      originalBytes: 3,
    });
  });

  it("parses the worker contract from a final reply", () => {
    const summary = summarizeFinal(
      "did work\nTests: 12 passed\nStatus: UNVERIFIED\nCommit: 1234abcd",
    );
    expect(summary.status).toBe("UNVERIFIED");
    expect(summary.commit).toBe("1234abcd");
    expect(summary.tests).toEqual(["Tests: 12 passed"]);
    expect(summarizeFinal(null).status).toBeNull();
  });
});

describe("model selection", () => {
  it("parses provider/model lines from opencode models output", () => {
    expect(parseModelList("opencode/a\nnoise line\nopencode-go/b#fast\n\nopencode/a\n")).toEqual([
      "opencode/a",
      "opencode-go/b#fast",
    ]);
  });

  it("falls back to the default when the requested model is not listed", () => {
    const listed = ["opencode-go/hy4-flash-free", "commandcode/deepseek-v4-pro"];
    const fallback = resolveRunModel("nope/missing", "opencode-go/hy4-flash-free", listed);
    expect(fallback.model).toBe("opencode-go/hy4-flash-free");
    expect(fallback.note).toContain("fell back");
    expect(resolveRunModel("deepseek-v4-pro", "opencode-go/hy4-flash-free", listed).model).toBe(
      "commandcode/deepseek-v4-pro",
    );
    expect(resolveRunModel(null, "opencode-go/hy4-flash-free", listed).note).toBeNull();
  });

  it("uses the requested model as given when the list is unavailable", () => {
    expect(resolveRunModel("x/y", "opencode-go/hy4-flash-free", null)).toEqual({
      model: "x/y",
      note: "model list unavailable; used as given",
    });
  });
});

describe("run record lifecycle", () => {
  function record(overrides: Partial<RunRecord>): RunRecord {
    return {
      id: "run-1",
      name: "demo",
      status: "queued",
      cwd: "/tmp",
      branch: null,
      agent: null,
      model: "opencode-go/hy4-flash-free",
      model_note: null,
      allow_shared_cwd: false,
      attempts: 0,
      owner_pid: 2147483646,
      pid: null,
      pgid: null,
      created: 1,
      started: null,
      finished: null,
      last_activity: 1,
      exit_code: null,
      signal: null,
      final_text: null,
      final_truncated: false,
      last_line: null,
      error: null,
      prompt_file: "/tmp/p.md",
      log_file: "/tmp/l.log",
      ...overrides,
    };
  }

  it("persists records across store instances and ignores corrupt files", () => {
    const dir = tempDir();
    const store = new RunStore(dir);
    store.save(record({ id: "run-1", status: "running" }));
    store.save(record({ id: "run-2", created: 2, status: "done" }));
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
    const reopened = new RunStore(dir);
    expect(reopened.get("run-1")?.status).toBe("running");
    expect(reopened.list().map((entry) => entry.id)).toEqual(["run-2", "run-1"]);
    expect(reopened.get("../escape")).toBeNull();
  });

  it("reaps runs whose owner process is gone and marks them stale", async () => {
    const dir = tempDir();
    const store = new RunStore(dir);
    store.save(record({ id: "orphan-1", status: "running", started: Date.now(), pid: null }));
    const logger = createLogger({ file: path.join(dir, "bridge.log") });
    const manager = new RunManager({
      store,
      logger,
      settings: { binary: "opencode", maxParallel: 2, retry: false, timeoutMs: 60_000 },
    });
    expect(manager.reapStale()).toBe(1);
    expect(store.get("orphan-1")?.status).toBe("stale");
    expect(store.get("orphan-1")?.error).toContain("owner process exited");
    expect(summaryLine(store.list(), 2)).toBe("1 stale (max parallel 2)");
  });

  it("builds argv without a shell and keeps the prompt in a file", () => {
    const args = buildRunArgs({
      model: "opencode-go/hy4-flash-free",
      agent: "deepseek-coder__edit",
      title: "t",
      promptFile: "/tmp/p.md",
    });
    expect(args.slice(0, 7)).toEqual([
      "run",
      "--standalone",
      "--format",
      "json",
      "--auto",
      "-m",
      "opencode-go/hy4-flash-free",
    ]);
    expect(args).toContain("--file");
    expect(args.at(-2)).toBe("--");
  });
});

describe("keyed mutex", () => {
  it("runs calls with the same key strictly in order", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const task = (label: string, ms: number) =>
      mutex.run("git", async () => {
        order.push(`start:${label}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`end:${label}`);
      });
    await Promise.all([task("a", 30), task("b", 1)]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});
