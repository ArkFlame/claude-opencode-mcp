# Architecture

The bridge is intentionally thin. It owns workspace resolution, security
policy, session bookkeeping, and the MCP surface. Everything else is OpenCode's
job.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Claude Code                                                        │
│  · understands the request, decomposes work, picks agents          │
│  · calls mcp__opencode__* tools                                    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ MCP over stdio
┌───────────────────────────────▼────────────────────────────────────┐
│ claude-opencode-mcp                                                │
│                                                                    │
│  mcp/server.ts ── tools/*.ts   seven tools, zod schemas            │
│  workspace/*                  resolution, validation, context      │
│  security/*                   path policy, permission profiles     │
│  config/config.ts             layered configuration                │
│  opencode/manager.ts          one server per workspace, LRU        │
│  opencode/agents.ts           built-in + project agent definitions │
│  opencode/run.ts              prompt, poll, timeout, abort         │
│  opencode/sessions.ts         registry persisted to disk           │
│  opencode/permission-watcher  auto-reject asks over SSE            │
└───────────────┬────────────────────────────────────────────────────┘
                │ @opencode-ai/sdk (v1 HTTP API) + OPENCODE_CONFIG_CONTENT
┌───────────────▼────────────────────────────────────────────────────┐
│ OpenCode server (one per workspace directory)                      │
│  · tools: read, glob, grep, edit, write, apply_patch, bash, …      │
│  · sessions, permissions, LSP, providers                           │
└───────────────┬────────────────────────────────────────────────────┘
                │ provider API (DeepSeek by default)
                ▼
        DeepSeek / any configured provider
                │
                ▼
        the same project/worktree
```

## Components

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | CLI: default command runs the MCP stdio server; `init` subcommand. |
| `src/mcp/server.ts` | Creates `McpServer`, registers tools, passes app context. |
| `src/mcp/tools/*` | Thin validation + orchestration per tool. |
| `src/mcp/execute.ts` | Run lifecycle: registry status, run, truncate, count files. |
| `src/workspace/resolver.ts` | Resolution priority and project-config loading. |
| `src/workspace/validator.ts` | Existence, readability, canonicalization, allowed roots, git root. |
| `src/security/policy.ts` | Maps agent profiles to OpenCode permission configs. |
| `src/opencode/manager.ts` | Server lifecycle, auth, health, LRU, crash detection. |
| `src/opencode/run.ts` | `session.prompt` + polling progress + timeout/abort + result extraction. |
| `src/opencode/agents.ts` | Loads prompts, merges overrides, emits OpenCode agent config. |
| `src/opencode/sessions.ts` | Session registry with atomic persistence and pruning. |
| `src/opencode/permission-watcher.ts` | SSE watcher that rejects stray permission asks. |
| `src/util/git.ts` | Non-invasive baseline (`git stash create`) and diff since baseline. |

## Request flow for `delegate_task`

```text
1. Resolve + validate workspace            (workspace/*)
2. Load project config, merge agents       (config/, opencode/agents.ts)
3. Ensure OpenCode server for the cwd      (opencode/manager.ts)
   · spawn `opencode serve` with OPENCODE_CONFIG_CONTENT
   · wait for "listening", poll /global/health
4. Resolve model (request → config → provider default)
5. Create session, capture git baseline    (opencode/sessions.ts, util/git.ts)
6. POST /session/:id/message with agent + model + parts
7. While pending: poll status/messages, emit MCP progress notifications
8. On completion: read assistant message, map errors, extract findings
9. Count files changed from the baseline, persist result, return JSON
```

## Why these choices

- **One server per workspace** keeps OpenCode's project configuration, cwd and
  snapshots honest, and avoids per-request directory routing bugs.
  Per-request `x-opencode-directory` remains available in the SDK but the
  bridge does not rely on it for isolation.
- **Sync prompt + polling** instead of streaming: the v1 HTTP API returns the
  final assistant message from `POST /session/:id/message`, which gives a
  definitive completion signal. Progress is reported to Claude Code via MCP
  notifications.
- **Git baseline for diffs**: OpenCode 1.18's `GET /session/:id/diff` returns
  empty for API-driven sessions in testing, so the bridge computes
  `git diff` against a baseline captured at session creation
  (`git stash create` for dirty trees) plus new untracked files. Pre-existing
  uncommitted work is therefore not attributed to the agent.
- **Inline agent config** (`OPENCODE_CONFIG_CONTENT`) instead of writing files
  into the repository: permissions cannot be forgotten, and the project tree
  stays untouched.
- **No ask rules + SSE auto-reject**: a headless bridge must never block on
  human approval.

## Error model

`BridgeError` carries a stable code, message, optional details, and a
`retryable` flag. Tools catch it and return `isError: true` with
`{ "error": { code, message, details?, retryable, request_id } }`. The codes are
listed in [troubleshooting.md](troubleshooting.md#error-codes) and in
`src/errors.ts`.

## State on disk

| Path | Contents |
| --- | --- |
| `~/.config/claude-opencode-mcp/config.json` | global configuration |
| `<project>/.claude-opencode/config.json` | project configuration |
| `<project>/.claude-opencode/agents/*.md` | optional project agents |
| `~/.local/state/claude-opencode-mcp/sessions.json` | session registry |
| `~/.local/state/claude-opencode-mcp/bridge.log` | rotating log (5 MB) |

No state is written into the repository except what `init` creates inside
`.claude-opencode/`.

## Background runs and the stale-agent design (v1.2.0)

`delegate_task` no longer waits on a long-lived OpenCode server. Each call starts one
`opencode run --standalone --format json --auto` child that the bridge owns:

- **Process group.** The child is spawned `detached`, so its pid is also its process-group id.
  Every kill goes to `-pgid`, which also reaches standalone servers and grandchildren.
- **Watchdogs** (`src/runs/attempt.ts`). A hard timeout (`CLAUDE_OPENCODE_TIMEOUT`, default
  1500 s) and an idle watchdog (`CLAUDE_OPENCODE_IDLE_TIMEOUT`, default 300 s without stdout or
  stderr). Ending an attempt sends SIGTERM to the group and SIGKILL 3 s later. When the leader
  exits, leftovers in the group get the same treatment.
- **Retry.** A run that exits without a final assistant message is retried once. Timeouts and
  aborts are never retried.
- **Records** (`src/runs/store.ts`). One JSON file per run in `~/.cache/claude-opencode-mcp/runs`
  (override `CLAUDE_OPENCODE_RUNS_DIR`), written atomically. Each record holds pid, pgid,
  owner_pid, cwd, started, last_activity, status, exit code and the bounded final reply. Logs
  and prompts sit next to it. Status survives MCP restarts.
- **Reaper** (`RunManager.reapStale`). Runs at startup and every 60 s. A non-terminal record is
  reaped when its owner process is gone or it has run past timeout plus 60 s. Reaping kills the
  group only when `/proc/<pid>/cmdline` still names opencode, which guards against pid reuse.
  Reaped records end as `stale`.
- **Shutdown.** SIGINT, SIGTERM and transport close abort every run. The `exit` hook sends
  SIGKILL to each tracked group, so no child outlives the MCP process.

### Queueing and worktrees

- At most `CLAUDE_OPENCODE_MAX_PARALLEL` runs (default 10) execute at once. Extra starts queue
  FIFO. A run whose cwd is already in use waits unless `allow_shared_cwd` is set.
- `create_worktree` and `remove_worktree` run git through `execFile` with argv arrays, under one
  process-wide lock. Names must match `^[a-z0-9][a-z0-9._-]{0,60}$`. `remove_worktree` refuses
  while `git cherry <base> <branch>` reports commits that are not in the base, unless `force`.

### Models and briefs

- `opencode models` is parsed and cached for five minutes. A requested model that is not listed
  falls back to the configured default (`opencode/hy4-flash-free`), and the result carries a
  `model_note`.
- The worker header is configurable through `runs.briefHeaderFile` or
  `CLAUDE_OPENCODE_BRIEF_HEADER`. The built-in header is generic.
- Per-call agent grants (`allow_edits`, `allow_bash`) still map onto the same variant agents and
  permission profiles as before (`src/runs/agent-config.ts`). Per-agent model pins are dropped
  so the run model is the one selected per call.

### Output

Final replies are ANSI-stripped and capped at 16 KB, with `log_path` for the full log.
`get_run` returns a structured summary: parsed `Status:`, commit hash and test lines.
Worker output is untrusted data.
