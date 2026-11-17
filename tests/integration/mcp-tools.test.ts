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
    expect(data.model).toBe("opencode/hy4-flash-free");

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
    expect(data.model).toBe("opencode/hy4-flash-free");
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
    expect(data.models).toEqual(["opencode/hy4-flash-free", "opencode/other-model"]);
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
