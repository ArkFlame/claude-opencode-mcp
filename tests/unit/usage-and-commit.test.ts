import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_COMMIT_TRAILER, AutoCommitter, type GitRunner } from "../../src/git/auto-commit.js";
import { spawnDetachedWorker } from "../../src/pool/worker.js";
import {
  buildUsageSql,
  median,
  summarizeUsage,
  titlePrefixClause,
  usageReport,
} from "../../src/usage/stats.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function assistant(output: number, reasoning: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: { id: "hy4-flash-free", providerID: "opencode-go" },
    tokens: { input: 100, output, reasoning, cache: { read: 0, write: 0 } },
    time: { created: 1_000, firstToken: 1_300, streamed: 2_300, completed: 2_400 },
    ...extra,
  });
}

function makeDb(): string {
  const file = path.join(tempDir("cop-usage-"), "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const insertSession = db.prepare("INSERT INTO session_v2 (id, title) VALUES (?, ?)");
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertSession.run("s1", "Kabocha: fix block parity");
  insertSession.run("s2", "Kabocha: fix item parity");
  insertSession.run("s3", "Unrelated 100% chat");
  let seq = 0;
  const add = (session: string, type: string, data: string) => {
    seq += 1;
    insertMessage.run(`m${seq}`, session, type, seq, seq, seq, data);
  };
  add("s1", "assistant", assistant(100, 50));
  add("s1", "assistant", assistant(20, 0));
  add("s2", "assistant", assistant(300, 100));
  add("s2", "user", JSON.stringify({ tokens: { output: 9999, reasoning: 0 } }));
  add("s3", "assistant", assistant(10, 10));
  db.close();
  return file;
}

describe("usage stats", () => {
  it("escapes LIKE wildcards and quotes in title prefixes", () => {
    expect(titlePrefixClause(undefined)).toBe("");
    expect(titlePrefixClause("100% o'k_")).toBe(" AND s.title LIKE '100\\% o''k\\_%' ESCAPE '\\'");
    expect(() => titlePrefixClause("x".repeat(201))).toThrow();
  });

  it("bounds the scan with a rounded integer limit", () => {
    expect(buildUsageSql(12.7, undefined)).toContain("LIMIT 12");
  });

  it("summarizes per model: sessions, medians, reasoning share, TTFT and speed", () => {
    const rows = [
      { session_id: "s1", title: "t", data: assistant(100, 50) },
      { session_id: "s1", title: "t", data: assistant(20, 0) },
      { session_id: "s2", title: "t", data: assistant(300, 100) },
      { session_id: "s3", title: "t", data: "not json" },
    ];
    const [model] = summarizeUsage(rows);
    expect(model?.model).toBe("opencode-go/hy4-flash-free");
    expect(model?.sessions).toBe(2);
    expect(model?.messages).toBe(3);
    expect(model?.median_output_tokens).toBe(210);
    expect(model?.mean_output_tokens).toBe(210);
    expect(model?.median_steps_per_session).toBe(1.5);
    expect(model?.reasoning_share).toBeCloseTo(150 / 570, 3);
    expect(model?.median_ttft_ms).toBe(300);
    expect(model?.median_tokens_per_second).toBe(100);
  });

  it("reads a temp database read-only, filtered by title prefix", async () => {
    const dbPath = makeDb();
    const all = await usageReport({ dbPath });
    expect(all.sessions).toBe(3);
    expect(all.messages_scanned).toBe(4);
    const kabocha = await usageReport({ dbPath, titlePrefix: "Kabocha" });
    expect(kabocha.sessions).toBe(2);
    expect(kabocha.models[0]?.messages).toBe(3);
    const literal = await usageReport({ dbPath, titlePrefix: "Unrelated 100%" });
    expect(literal.sessions).toBe(1);
    const escaped = await usageReport({ dbPath, titlePrefix: "Unrelated%" });
    expect(escaped.sessions).toBe(0);
  });

  it("refuses writes through the handle it opens", async () => {
    const dbPath = makeDb();
    await usageReport({ dbPath });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(() => db.exec("DELETE FROM session_message")).toThrow();
    } finally {
      db.close();
    }
  });

  it("fails clearly when the database is missing", async () => {
    await expect(
      usageReport({ dbPath: path.join(tempDir("cop-none-"), "missing.db") }),
    ).rejects.toThrow(/not found/);
  });

  it("computes medians of even and odd samples", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("auto-commit loop", () => {
  function fakeGit(
    status: string,
    overrides: Record<string, { code: number; stdout?: string; stderr?: string }> = {},
  ) {
    const calls: string[][] = [];
    const run: GitRunner = async (args) => {
      calls.push(args);
      const key = args[0] === "push" ? "push" : args[0] === "status" ? "status" : args.join(" ");
      const result = overrides[key] ?? overrides[args[0] ?? ""];
      if (result)
        return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      if (args[0] === "status") return { code: 0, stdout: status, stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "master\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("commits each area with the agent trailer, then pushes the branch", async () => {
    const runsDir = tempDir("cop-auto-");
    const { run, calls } = fakeGit(" M crates/pumpkin-world/a.rs\0?? docs/Q.md\0");
    const committer = new AutoCommitter({ runsDir, git: run, now: () => 1 });
    committer.start("/repo", 120);
    await committer.tick();
    committer.stop();

    const commits = calls.filter((args) => args[0] === "commit");
    expect(commits.length).toBe(2);
    for (const args of commits) {
      expect(args).toContain(AUTO_COMMIT_TRAILER);
      expect(args.slice(-2)[0]).toBe("--");
    }
    expect(commits[0]).toContain("docs(docs): apply worker changes to 1 file");
    expect(calls).toContainEqual(["push", "origin", "master"]);
    expect(committer.status().commits).toBe(2);
  });

  it("skips the push when it fails and records the error", async () => {
    const runsDir = tempDir("cop-auto-");
    const { run } = fakeGit(" M src/a.ts\0", {
      push: { code: 1, stderr: "rejected\nnon-fast-forward" },
    });
    const committer = new AutoCommitter({ runsDir, git: run, now: () => 1 });
    committer.start("/repo", 120);
    await committer.tick();
    committer.stop();
    expect(committer.status().commits).toBe(1);
    expect(committer.status().pushes).toBe(0);
    expect(committer.status().push_failures).toBe(1);
    expect(committer.status().last_error).toContain("non-fast-forward");
  });

  it("stops at the next pass when the stop file exists", async () => {
    const runsDir = tempDir("cop-auto-");
    const { run, calls } = fakeGit(" M src/a.ts\0");
    const committer = new AutoCommitter({ runsDir, git: run, now: () => 1 });
    committer.start("/repo", 120);
    fs.writeFileSync(committer.stopFileFor("/repo"), "stop\n");
    await committer.tick();
    expect(committer.status().running).toBe(false);
    expect(calls).toEqual([]);
  });

  it("validates the interval and refuses a second loop", () => {
    const runsDir = tempDir("cop-auto-");
    const committer = new AutoCommitter({ runsDir, git: fakeGit("").run });
    expect(() => committer.start("/repo", 5)).toThrow();
    committer.start("/repo", 120);
    expect(() => committer.start("/repo", 120)).toThrow(/already running/);
    committer.stop();
  });
});

describe("pool worker spawn", () => {
  it("runs the command detached and records its exit code in the exit file", async () => {
    const dir = tempDir("cop-spawn-");
    const exitFile = path.join(dir, "u.exit");
    const logFile = path.join(dir, "u.log");
    const handle = spawnDetachedWorker({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok'); process.exit(3)"],
      cwd: dir,
      env: process.env,
      logFile,
      exitFile,
    });
    expect(handle.pgid).toBe(handle.pid);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(exitFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(fs.readFileSync(exitFile, "utf8").trim()).toBe("3");
    expect(fs.readFileSync(logFile, "utf8")).toBe("ok");
  });
});
