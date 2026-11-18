import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { RunManager } from "../../src/runs/manager.js";
import { createRunOwner, type RunOwner } from "../../src/runs/owner.js";
import { type RunSettings, resolveRunSettings } from "../../src/runs/settings.js";
import { RunStore } from "../../src/runs/store.js";
import { createLogger } from "../../src/util/logger.js";

const FAKE = new URL("../helpers/fake-opencode-cli.mjs", import.meta.url).pathname;
const ENV_KEYS = ["FAKE_MODE", "FAKE_DELAY_MS"] as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

let client: Client;
let server: McpServer;
let root: string;
let workdir: string;
let manager: OpenCodeManager;

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    data: (result.structuredContent ?? {}) as Record<string, any>,
  };
}

beforeAll(() => {
  fs.chmodSync(FAKE, 0o755);
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  process.env.FAKE_MODE = "reply";
  process.env.FAKE_DELAY_MS = "50";
  root = tempDir("cop-int-");
  workdir = path.join(root, "project");
  fs.mkdirSync(workdir);
  const logger = createLogger({ file: path.join(root, "bridge.log") });
  const globalConfig = BridgeConfigSchema.parse({});
  const base = resolveRunSettings(globalConfig, {
    CLAUDE_OPENCODE_RUNS_DIR: path.join(root, "runs"),
  });
  const runSettings: RunSettings = { ...base, binary: FAKE, allowedRoots: [root], idleMs: 10_000 };
  manager = new OpenCodeManager({ logger, env: process.env });
  const runs = new RunManager({
    store: new RunStore(runSettings.runsDir),
    settings: runSettings,
    logger,
  });
  server = createMcpServer({
    logger,
    manager,
    registry: new SessionRegistry(path.join(root, "sessions.json"), logger),
    globalConfig,
    env: process.env,
    stateDir: root,
    runs,
    runSettings,
  });
  client = new Client({ name: "integration-test", version: "0.0.0" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await manager.stopAll();
});

describe("MCP tool surface", () => {
  it("registers the background run tools next to the session tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    for (const expected of [
      "delegate_task",
      "list_runs",
      "get_run",
      "abort_run",
      "abort_all",
      "wait_any",
      "list_models",
      "create_worktree",
      "remove_worktree",
      "create_session",
      "send_message",
      "get_session",
      "get_diff",
      "abort_session",
      "list_agents",
      "queue_message",
      "list_messages",
      "cancel_message",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("delegate_task and run tracking", () => {
  it("runs a task to completion and returns the parsed worker contract", async () => {
    const { isError, data } = await call("delegate_task", {
      task: "Write the greeting file",
      cwd: workdir,
      name: "greeting",
      wait_seconds: 30,
    });
    expect(isError).toBe(false);
    expect(data.status).toBe("done");
    expect(data.result.final.status_line).toBe("PASS");
    expect(data.result.final.commit).toBe("1234abc");
    expect(data.model).toBe("opencode-go/hy4-flash-free");

    const listed = await call("list_runs", {});
    expect(listed.data.runs.map((row: { run_id: string }) => row.run_id)).toContain(data.run_id);
    expect(listed.data.summary_line).toContain("done");

    const detail = await call("get_run", { run_id: data.run_id });
    expect(detail.data.final.text).toContain("Status: PASS");
    expect(detail.data.log_path).toMatch(/\.log$/);
  });

  it("falls back to the default model when the requested one is not listed", async () => {
    const { data } = await call("delegate_task", {
      task: "Check the fallback",
      cwd: workdir,
      model: "nope/missing",
      wait_seconds: 30,
    });
    expect(data.model).toBe("opencode-go/hy4-flash-free");
    expect(data.model_note).toContain("fell back");
  });

  it("rejects unsafe run names and directories outside the allowed roots", async () => {
    const badName = await call("delegate_task", { task: "x", cwd: workdir, name: "Bad Name" });
    expect(badName.isError).toBe(true);
    expect(badName.data.error.code).toBe("INVALID_ARGUMENT");

    const outside = tempDir("cop-outside-");
    const denied = await call("delegate_task", { task: "x", cwd: outside });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe("WORKSPACE_NOT_ALLOWED");
  });

  it("lists models from the CLI", async () => {
    const { data } = await call("list_models", { refresh: true });
    expect(data.available).toBe(true);
    expect(data.models).toEqual(["opencode-go/hy4-flash-free", "opencode-go/other-model"]);
  });

  it("wait_any reports unknown ids and returns finished runs without busy-polling", async () => {
    const started = await call("delegate_task", { task: "quick", cwd: workdir });
    const waited = await call("wait_any", {
      run_ids: [started.data.run_id, "missing-run"],
      seconds: 30,
    });
    expect(waited.data.unknown).toEqual(["missing-run"]);
    expect(waited.data.finished.map((row: { run_id: string }) => row.run_id)).toEqual([
      started.data.run_id,
    ]);
    expect(waited.data.timed_out).toBe(false);
  });

  it("abort_all stops queued and running runs", async () => {
    process.env.FAKE_MODE = "hang";
    const started = await call("delegate_task", { task: "hang", cwd: workdir });
    expect(started.data.status).toMatch(/running|queued/);
    const aborted = await call("abort_all", {});
    expect(aborted.data.running + aborted.data.queued + aborted.data.reaped).toBeGreaterThanOrEqual(
      1,
    );
    const run = await call("get_run", { run_id: started.data.run_id });
    expect(run.data.status).toBe("aborted");
  });
});

describe("worktree tools", () => {
  it("creates and removes a kab/<name> worktree beside the repository", async () => {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git([
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "chore: init",
    ]);

    const created = await call("create_worktree", { name: "wt-one", base: "main", cwd: repo });
    expect(created.isError).toBe(false);
    expect(created.data.branch).toBe("kab/wt-one");
    expect(fs.existsSync(path.join(root, "repo-wt", "wt-one"))).toBe(true);

    const removed = await call("remove_worktree", { name: "wt-one", base: "main", cwd: repo });
    expect(removed.isError).toBe(false);
    expect(removed.data.removed_path).toBe(true);
  });
});

/** Two Claude sessions: each with its own MCP server and owner, sharing one runs directory. */
describe("two Claude sessions on one runs directory", () => {
  const SESSION_A = { CLAUDE_OPENCODE_OWNER: "session-a", CLAUDE_OPENCODE_LABEL: "lane-a" };
  const SESSION_B = { CLAUDE_OPENCODE_OWNER: "session-b", CLAUDE_OPENCODE_LABEL: "lane-b" };

  async function openSession(runsDir: string, env: Record<string, string>) {
    const logger = createLogger({
      file: path.join(root, `bridge-${env.CLAUDE_OPENCODE_OWNER}.log`),
    });
    const globalConfig = BridgeConfigSchema.parse({});
    const base = resolveRunSettings(globalConfig, { CLAUDE_OPENCODE_RUNS_DIR: runsDir });
    const runSettings: RunSettings = {
      ...base,
      binary: FAKE,
      allowedRoots: [root],
      idleMs: 10_000,
    };
    const owner: RunOwner = createRunOwner({ env, pid: process.pid, ppid: 1 });
    const runs = new RunManager({
      store: new RunStore(runsDir),
      settings: runSettings,
      logger,
      owner,
    });
    const sessionServer = createMcpServer({
      logger,
      manager,
      registry: new SessionRegistry(
        path.join(root, `sessions-${env.CLAUDE_OPENCODE_OWNER}.json`),
        logger,
      ),
      globalConfig,
      env,
      stateDir: root,
      runs,
      runSettings,
    });
    const sessionClient = new Client({ name: "claude-code", version: "0.0.0" });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await sessionServer.connect(serverSide);
    await sessionClient.connect(clientSide);
    const callAs = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await sessionClient.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        text: (result.content as Array<{ text?: string }>)[0]?.text ?? "",
        data: (result.structuredContent ?? {}) as Record<string, any>,
      };
    };
    return {
      owner,
      runs,
      callAs,
      close: () => sessionClient.close().then(() => sessionServer.close()),
    };
  }

  /** A run record another session wrote into the shared store; its owner pid is this live test process. */
  function seedForeignRun(runsDir: string, id: string, status: "running" | "done") {
    const store = new RunStore(runsDir);
    const now = Date.now();
    store.save({
      id,
      name: "foreign-task",
      status,
      cwd: workdir,
      branch: null,
      agent: null,
      model: "opencode-go/hy4-flash-free",
      model_note: null,
      allow_shared_cwd: true,
      attempts: 1,
      owner_pid: process.pid,
      owner_id: "session-b",
      owner_label: "lane-b",
      pid: null,
      pgid: null,
      created: now,
      started: now,
      finished: status === "done" ? now : null,
      last_activity: now,
      exit_code: null,
      signal: null,
      final_text: null,
      final_truncated: false,
      last_line: null,
      error: null,
      prompt_file: path.join(runsDir, `${id}.prompt.md`),
      log_file: path.join(runsDir, `${id}.log`),
    });
  }

  it("hides the other session's runs by default and shows them with scope all", async () => {
    const runsDir = path.join(root, "shared-runs");
    seedForeignRun(runsDir, "foreign-run-1", "running");
    const a = await openSession(runsDir, SESSION_A);
    try {
      const mine = await a.callAs("list_runs");
      expect(mine.data.runs.map((row: { run_id: string }) => row.run_id)).not.toContain(
        "foreign-run-1",
      );

      const all = await a.callAs("list_runs", { scope: "all" });
      const foreign = all.data.runs.find(
        (row: { run_id: string }) => row.run_id === "foreign-run-1",
      );
      expect(foreign).toMatchObject({ owner_label: "lane-b", mine: false, foreign: true });
      expect(all.data.owners).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: "lane-b", runs: 1, running: 1 })]),
      );
    } finally {
      await a.close();
    }
  });

  it("refuses abort_run on another session's run and names it, and allows it with force", async () => {
    const runsDir = path.join(root, "shared-runs-abort");
    seedForeignRun(runsDir, "foreign-run-2", "running");
    const a = await openSession(runsDir, SESSION_A);
    try {
      const refused = await a.callAs("abort_run", { run_id: "foreign-run-2" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("lane-b");
      expect(refused.text).toContain("force: true");
      expect(new RunStore(runsDir).get("foreign-run-2")?.status).toBe("running");

      const forced = await a.callAs("abort_run", { run_id: "foreign-run-2", force: true });
      expect(forced.isError).toBe(false);
      expect(new RunStore(runsDir).get("foreign-run-2")?.status).toBe("aborted");
    } finally {
      await a.close();
    }
  });

  it("reads another session's run with get_run and flags it as foreign", async () => {
    const runsDir = path.join(root, "shared-runs-read");
    seedForeignRun(runsDir, "foreign-run-3", "done");
    const a = await openSession(runsDir, SESSION_A);
    try {
      const read = await a.callAs("get_run", { run_id: "foreign-run-3" });
      expect(read.isError).toBe(false);
      expect(read.data).toMatchObject({ foreign: true, owner_label: "lane-b" });
    } finally {
      await a.close();
    }
  });

  it("abort_all from one session leaves the other session's live run alone", async () => {
    const runsDir = path.join(root, "shared-runs-all");
    seedForeignRun(runsDir, "foreign-run-4", "running");
    const a = await openSession(runsDir, SESSION_A);
    try {
      const result = await a.callAs("abort_all");
      expect(result.isError).toBe(false);
      expect(new RunStore(runsDir).get("foreign-run-4")?.status).toBe("running");
      const refusedAll = await a.callAs("abort_all", { scope: "all" });
      expect(refusedAll.isError).toBe(true);
    } finally {
      await a.close();
    }
  });

  it("whoami reports this session and counts runs of mine and others", async () => {
    const runsDir = path.join(root, "shared-runs-who");
    seedForeignRun(runsDir, "foreign-run-5", "done");
    const a = await openSession(runsDir, SESSION_A);
    try {
      const who = await a.callAs("whoami");
      expect(who.data.owner).toMatchObject({ id: "session-a", label: "lane-a" });
      expect(who.data.runs).toMatchObject({ mine: 0, others: 1 });
      expect(who.data.runs_dir).toBe(runsDir);
    } finally {
      await a.close();
    }
  });
});
