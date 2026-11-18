import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import type { OpenCodeManager } from "../opencode/manager.js";
import type { SessionRegistry } from "../opencode/sessions.js";
import { RunManager } from "../runs/manager.js";
import { applyClientName } from "../runs/owner.js";
import { type RunSettings, resolveRunSettings } from "../runs/settings.js";
import { RunStore } from "../runs/store.js";
import type { Logger } from "../util/logger.js";
import type { AppContext } from "./execute.js";
import { registerAbortSession } from "./tools/abort-session.js";
import { registerCreateSession } from "./tools/create-session.js";
import { registerDelegateTask } from "./tools/delegate-task.js";
import { registerGetDiff } from "./tools/get-diff.js";
import { registerGetSession } from "./tools/get-session.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerPoolTools } from "./tools/pool.js";
import { registerQueueTools } from "./tools/queue.js";
import { registerRunTools } from "./tools/runs.js";
import { registerSendMessage } from "./tools/send-message.js";
import { registerWhoami } from "./tools/whoami.js";

export const SERVER_NAME = "claude-opencode-mcp";

/** Read the version from the packaged package.json so it never drifts. */
function resolveServerVersion(): string {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = resolveServerVersion();

export const SERVER_INSTRUCTIONS = [
  "Claude Code is the orchestrator; this server runs OpenCode agents in the background, in the same workspace or in git worktrees.",
  "Start work with create_worktree (optional) then delegate_task, which returns a run_id at once. Collect results with wait_any and get_run; check list_runs before declaring the fleet idle and abort_run or abort_all stale runs.",
  "Up to CLAUDE_OPENCODE_MAX_PARALLEL runs execute at once (default 10); extra runs queue FIFO. Use list_models to see valid model ids.",
  "create_session + send_message remain available for multi-step conversations that must keep context.",
  "Read-only agents: deepseek-researcher, deepseek-reviewer. Editing agent: deepseek-coder. Test-running agent: deepseek-tester.",
  "After a coder session, call get_diff to inspect exactly what changed before reporting back to the user.",
  "Paths supplied to delegate_task are exploration hints, not boundaries.",
  "Listening for results: call wait_any (or wait_pool for a pool) and let it block; it returns when a run finishes, so never write a shell for/while/sleep loop to poll runs or logs. After a timeout, call it again at most a few times, then check list_runs once and report. Read finished output with get_run.",
  "Shared checkouts: delegate_task with shared=true, or run_pool for a batch of unit files (pool_status to follow, usage_stats for model figures, auto_commit to commit and push while workers edit).",
].join(" ");

export interface CreateMcpServerOptions {
  logger: Logger;
  manager: OpenCodeManager;
  registry: SessionRegistry;
  globalConfig: ResolvedConfig;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  /** Run manager; created from the environment when omitted. */
  runs?: RunManager;
  runSettings?: RunSettings;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const env = options.env ?? process.env;
  const runSettings = options.runSettings ?? resolveRunSettings(options.globalConfig, env);
  const runs =
    options.runs ??
    new RunManager({
      store: new RunStore(runSettings.runsDir),
      settings: runSettings,
      logger: options.logger,
    });
  const ctx: AppContext = {
    logger: options.logger,
    manager: options.manager,
    registry: options.registry,
    globalConfig: options.globalConfig,
    env,
    stateDir: options.stateDir,
    runs,
    runSettings,
    ...(options.loadProjectConfig ? { loadProjectConfig: options.loadProjectConfig } : {}),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerDelegateTask(server, ctx);
  registerCreateSession(server, ctx);
  registerSendMessage(server, ctx);
  registerGetSession(server, ctx);
  registerGetDiff(server, ctx);
  registerAbortSession(server, ctx);
  registerListAgents(server, ctx);
  registerRunTools(server, ctx);
  registerPoolTools(server, ctx);
  registerQueueTools(server, ctx);
  registerWhoami(server, ctx);
  // The MCP client name becomes part of this session's owner label once it initializes.
  server.server.oninitialized = () => {
    applyClientName(runs.owner, server.server.getClientVersion()?.name, env);
  };

  return server;
}
