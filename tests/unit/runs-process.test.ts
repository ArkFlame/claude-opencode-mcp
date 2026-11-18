import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAttempt } from "../../src/runs/attempt.js";
import { RunManager, type SubmitInput } from "../../src/runs/manager.js";
import { RunStore } from "../../src/runs/store.js";
import { createWorktree, removeWorktree } from "../../src/runs/worktree.js";
import { createLogger } from "../../src/util/logger.js";

const FAKE = new URL("../helpers/fake-opencode-cli.mjs", import.meta.url).pathname;
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function tempDir(prefix = "cop-proc-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return fs.realpathSync(dir);
}

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

beforeAll(() => {
  fs.chmodSync(FAKE, 0o755);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of Object.keys(savedEnv)) delete process.env[key];
});

function attemptSpec(dir: string) {
  return {
    command: FAKE,
    args: ["run"],
    cwd: dir,
    env: { ...process.env },
    logFile: path.join(dir, "run.log"),
  };
}

describe("runAttempt watchdog", () => {
  it("kills a silent child and its whole process group after the idle limit", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "grandchild.pid");
    setEnv({ FAKE_MODE: "hang", FAKE_PID_FILE: pidFile });
    const started = Date.now();
    const result = await runAttempt(attemptSpec(dir), { timeoutMs: 60_000, idleMs: 1_000 });
    expect(result.end).toBe("idle");
    // The kill also waits IDLE_CONFIRM_MS (10 s) after the last log growth, so allow for it.
    expect(Date.now() - started).toBeLessThan(15_000);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
    expect(result.text).toBe("");
  });

  it("ends a run at the hard timeout even while output keeps flowing", async () => {
    const dir = tempDir();
    setEnv({ FAKE_MODE: "hang" });
    const result = await runAttempt(attemptSpec(dir), { timeoutMs: 1_200, idleMs: 60_000 });
    expect(result.end).toBe("timeout");
  });

  it("returns the final assistant text and exit code on success", async () => {
    const dir = tempDir();
    setEnv({ FAKE_MODE: "reply" });
    const result = await runAttempt(attemptSpec(dir), { timeoutMs: 30_000, idleMs: 10_000 });
    expect(result.end).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("Status: PASS");
    expect(result.errorMessage).toBeNull();
  });

  it("reports a missing binary as a spawn error", async () => {
    const dir = tempDir();
    const result = await runAttempt(
      { ...attemptSpec(dir), command: path.join(dir, "no-such-opencode") },
      { timeoutMs: 5_000, idleMs: 5_000 },
    );
    expect(result.end).toBe("spawn-error");
    expect(result.errorMessage).toBeTruthy();
  });
});

describe("RunManager queue", () => {
  function manager(dir: string, maxParallel: number, retry = false) {
    const logger = createLogger({ file: path.join(dir, "bridge.log") });
    return new RunManager({
      store: new RunStore(path.join(dir, "runs")),
      logger,
      settings: { binary: FAKE, maxParallel, retry, timeoutMs: 30_000 },
    });
  }

  function input(cwd: string, name: string, extra: Partial<SubmitInput> = {}): SubmitInput {
    return {
      name,
      prompt: `task ${name}`,
      cwd,
      branch: null,
      agent: null,
      agentConfig: null,
      model: "opencode-go/hy4-flash-free",
      modelNote: null,
      allowSharedCwd: false,
      timeoutMs: 30_000,
      idleMs: 10_000,
      ...extra,
    };
  }

  async function settle(runs: RunManager, ids: string[]): Promise<void> {
    const ok = await waitUntil(
      () =>
        ids.every((id) => {
          const record = runs.store.get(id);
          return record !== null && !["queued", "running"].includes(record.status);
        }),
      20_000,
    );
    expect(ok).toBe(true);
  }

  it("starts queued runs FIFO when all slots are taken", async () => {
    const dir = tempDir();
    setEnv({ FAKE_MODE: "reply", FAKE_DELAY_MS: "120" });
    const runs = manager(dir, 1);
    const ids = ["a", "b", "c"].map((name, index) => {
      const cwd = path.join(dir, `cwd-${index}`);
      fs.mkdirSync(cwd);
      return runs.submit(input(cwd, name)).id;
    });
    expect(runs.queuePosition(ids[2] ?? "")).toBe(2);
    await settle(runs, ids);
    const starts = ids.map((id) => runs.store.get(id)?.started ?? 0);
    expect(starts[0]).toBeLessThanOrEqual(starts[1] ?? 0);
    expect(starts[1]).toBeLessThanOrEqual(starts[2] ?? 0);
    for (const id of ids) expect(runs.store.get(id)?.status).toBe("done");
  });

  it("never runs two non-shared runs in the same cwd at once", async () => {
    const dir = tempDir();
    setEnv({ FAKE_MODE: "reply", FAKE_DELAY_MS: "150" });
    const runs = manager(dir, 4);
    const cwd = path.join(dir, "shared");
    fs.mkdirSync(cwd);
    const first = runs.submit(input(cwd, "first")).id;
    const second = runs.submit(input(cwd, "second")).id;
    expect(runs.store.get(second)?.status).toBe("queued");
    await settle(runs, [first, second]);
    const a = runs.store.get(first);
    const b = runs.store.get(second);
    expect((b?.started ?? 0) >= (a?.finished ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("retries once when a run ends without a final reply, then fails", async () => {
    const dir = tempDir();
    setEnv({ FAKE_MODE: "silent" });
    const runs = manager(dir, 1, true);
    const id = runs.submit(input(dir, "silent-task")).id;
    await settle(runs, [id]);
    const record = runs.store.get(id);
    expect(record?.attempts).toBe(2);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("without a final reply");
  });

  it("aborts a queued run without starting it", async () => {
    const dir = tempDir();
    setEnv({ FAKE_MODE: "hang" });
    const runs = manager(dir, 1);
    fs.mkdirSync(path.join(dir, "x"));
    fs.mkdirSync(path.join(dir, "y"));
    const running = runs.submit(input(path.join(dir, "x"), "busy")).id;
    const queued = runs.submit(input(path.join(dir, "y"), "waiting"));
    expect(runs.abort(queued.id)?.status).toBe("aborted");
    runs.abort(running);
    await settle(runs, [running]);
    expect(runs.store.get(running)?.status).toBe("aborted");
    expect(runs.store.get(queued.id)?.attempts).toBe(0);
  });
});

describe("worktree helpers", () => {
  function makeRepo(): string {
    const root = tempDir("cop-repo-");
    const repo = path.join(root, "demo");
    fs.mkdirSync(repo);
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "t@example.invalid"]);
    run(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "README.md"), "hi\n");
    run(["add", "."]);
    run(["commit", "-q", "-m", "chore: init"]);
    return repo;
  }

  it("creates a worktree, reuses it when clean, and refuses removal with unlanded commits", async () => {
    const repo = makeRepo();
    const created = await createWorktree({
      cwd: repo,
      name: "feat-1",
      base: "main",
      allowedRoots: [],
    });
    expect(created.reused).toBe(false);
    expect(created.branch).toBe("kab/feat-1");
    expect(fs.existsSync(path.join(created.path, "README.md"))).toBe(true);

    const again = await createWorktree({
      cwd: repo,
      name: "feat-1",
      base: "main",
      allowedRoots: [],
    });
    expect(again.reused).toBe(true);

    const env = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    fs.writeFileSync(path.join(created.path, "feature.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: created.path, env: { ...process.env, ...env } });
    execFileSync("git", ["commit", "-q", "-m", "feat: add feature"], {
      cwd: created.path,
      env: { ...process.env, ...env },
    });

    await expect(
      removeWorktree({ cwd: repo, name: "feat-1", base: "main", allowedRoots: [] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fs.existsSync(created.path)).toBe(true);

    const removed = await removeWorktree({
      cwd: repo,
      name: "feat-1",
      base: "main",
      force: true,
      allowedRoots: [],
    });
    expect(removed.removed_path).toBe(true);
    expect(fs.existsSync(created.path)).toBe(false);
  });

  it("rejects worktree names that are not plain labels", async () => {
    const repo = makeRepo();
    await expect(
      createWorktree({ cwd: repo, name: "../escape", base: "main", allowedRoots: [] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
