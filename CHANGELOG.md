# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Changed
- Server instructions now tell the orchestrator how to listen for results: block on `wait_any` or `wait_pool`, never poll with a shell loop.

## [1.6.0] - 2026-11-17
### Added
- Event streams: pools write `events.jsonl` in their pool directory and single runs write `events/<id>.jsonl` under the runs directory. Events cover unit start, done, failed, requeued, stale, lane cap changes, and pool done or stopped; run start and done.
- `node <bridge> events --pool <id>` or `--run <id>` prints one line per event, a heartbeat each minute with the counts, and exits at the terminal event. `run_pool` and `delegate_task` return a `monitor.command` for Claude Code's Monitor tool.
- `wait_pool` blocks (bounded, max 600 s) until `any_finished`, `failure`, `stale` or `all_done`, and returns events, counts and a cursor for the next call.
- `pool_status` without `pool_id` adds session totals (running, queued, done, failed, stale, lane cap in use).
- `set_pool_cap` changes one lane's cap on a live pool. `run_pool` takes `ramp` (start, step, max, every_seconds, backoff_on_failures) to raise lane caps gradually and cut back on failure spikes.
- `run_pool` takes `stale_action` (`report` by default, or `abort_requeue`), and `requeue_stale` aborts silent workers on demand.
- `queue_ttl_seconds` and `idle_timeout_seconds` on `delegate_task`, and `idle_timeout_seconds` on `run_pool`.
- `CLAUDE_OPENCODE_IDLE_SECONDS` (default 300) and `CLAUDE_OPENCODE_MIN_FREE_MB` (default 1024). `CLAUDE_OPENCODE_IDLE_TIMEOUT` is still read as a fallback.
- Run and pool records carry `error_kind` and the raw error (`error_raw`). Sqlite failures are classified as `sqlite_full`, `sqlite_busy` or `sqlite_other`. The classification is a best guess from the opaque opencode message.
- `run_pool` takes `max_retries` (default 2). A sqlite failure requeues the unit with backoff and shrinks its lane by one. A lane is restored after five successes, and the pool stops after six consecutive sqlite failures.
- `pool_status` lists `failed_units` (unit, exit code, error kind, log path). `run_pool` takes `retry_failed` to requeue them.
- `run_pool` rescans `units_glob` every 5 s, so new open unit files join a live pool. It takes `add_units` for explicit paths. A unit that exited 0 is never run again.
- Slot accounting counts live processes only, and `delegate_task` and `list_runs` report `slots {running, max, source}`.
- Disk preflight refuses new runs with `disk_low` below the free-space floor. A live pool pauses new launches below it without killing workers.

### Changed
- The hard timeout starts at process start. Queued runs are not reaped by it; they expire after `queue_ttl_seconds` (default `timeout_seconds`, else one hour).
- An idle run is confirmed before it is killed: any log growth counts as activity, and the kill waits for 10 s of silence. A run whose final assistant text exists when it goes silent completes.
- Pools no longer kill silent workers by default. They report them as stale after `idle_timeout_seconds`, and abort them only with `stale_action: "abort_requeue"`.

### Not done
- `isolate_db` (a per-run `XDG_DATA_HOME`) is not implemented. It would move the session database that resume and usage stats read, and the auth layout could not be verified without live runs.

### Fixed
- Queued runs were reaped as if they had started, and sibling queues in the same session could be reaped by one process.
- Slot counts included dead processes, so a full pool could report no free slots.

## [1.5.0] - 2026-11-17
### Added
- Each Claude Code session has an owner identity: `CLAUDE_OPENCODE_OWNER` overrides the id and `CLAUDE_OPENCODE_LABEL` the label. The default id is the parent process and its start time, so a restarted server re-adopts its runs.
- Run, pool and queued-message records carry `owner_id` and `owner_label`. Records written by earlier versions stay readable as legacy.
- `scope: "mine" | "all"` (default `mine`) on `list_runs`, `wait_any`, `pool_status`, `usage_stats` and `list_messages`. `list_runs` with `scope: "all"` adds an `owners` summary.
- `abort_run`, `queue_message`, `cancel_message` and `run_pool` refuse another session's run or pool unless `force: true`. `get_run` reads it and reports `foreign: true`.
- `abort_all` clears only this session's runs and pools. `scope: "all"` with `force: true` clears every session's.
- `delegate_task` reports a live run of another session in the same cwd under `collision`, and that run blocks an exclusive run the same way a local one does.
- `whoami` tool.

### Changed
- Stale cleanup marks a run stale only when its owner process is gone. Live runs of other sessions are never reaped.
- `usage_stats` defaults to this session's runs.

## [1.4.0] - 2026-11-17
### Added
- `queue_message`: queue a follow-up for a pool unit or an OpenCode session. `when_idle` waits for the current attempt; `now` interrupts a running pool unit and redelivers on the same session. Messages are stored per run in an atomic JSON-lines inbox with a priority order, three delivery attempts and a cancel path.
- `list_messages` and `cancel_message` inspect and cancel queued messages.
- Pool supervisors deliver queued messages through the normal lane caps and backoff, ahead of fresh units. `queue_message` restarts a finished pool in redeliver-only mode, so other units are not rerun.
- `list_runs` and `get_run` report `queued_messages`.

## [1.3.0] - 2026-11-17
### Added
- Shared-checkout runs: `delegate_task` accepts `shared` and `forbid`. The worker runs in `cwd`, is told not to run the forbidden commands, and does not commit.
- `run_pool`: a detached supervisor runs one worker per open unit file with lanes and caps. It adopts live workers on restart, serializes units that share an exclusive `.rs` name, caps generic and hub names with `per_file_cap`, requeues provider-limit hits with lane backoff, and stops after six consecutive hits.
- `pool_status`: per-lane progress, provider hits, stale workers and an ETA.
- `auto_commit`: a background loop that commits pending changes per area and pushes the branch.
- `usage_stats`: read-only per-model statistics from the opencode database.
- Pool workers appear in `list_runs`. `abort_all` stops pools and `abort_run` stops a single unit.
- `docs/POOL.md` describes pool mode and its limits.

## [1.2.0] - 2026-11-17
### Added
- Background CLI runs. `delegate_task` returns a `run_id` immediately, with a hard timeout (`CLAUDE_OPENCODE_TIMEOUT`), an idle watchdog (`CLAUDE_OPENCODE_IDLE_TIMEOUT`), and SIGTERM then SIGKILL on the whole process group.
- One automatic retry when a run ends without a final reply.
- Persistent run records, plus a reaper at startup and every 60 s that marks orphaned runs `stale`.
- Tools: `list_runs`, `get_run`, `wait_any`, `abort_run`, `abort_all`, `list_models`, `create_worktree`, `remove_worktree`.
- Per-call `model` with fallback to the configured default when the model is not listed. `CLAUDE_OPENCODE_MODEL` sets the default.
- FIFO queue bounded by `CLAUDE_OPENCODE_MAX_PARALLEL` (default 10), with one run per cwd unless `allow_shared_cwd`.
- Worker brief header (`brief`, `header`, `read_paths`), configurable via `CLAUDE_OPENCODE_BRIEF_HEADER`.
- `scripts/install.sh` registers the server with `claude mcp add --scope user`.
- Unit and integration tests for names, output bounds, model fallback, the watchdog, FIFO queueing, worktree refusal and the MCP tool surface.

### Changed
- `delegate_task` runs through the `opencode` CLI instead of a shared server. Its input changed: `agent`, `cwd`, `allow_edits` and `allow_bash` keep their meaning, `timeout` is now `timeout_seconds`, and `paths` is replaced by `read_paths`.
- Session tools (`create_session`, `send_message`, `get_session`, `get_diff`, `abort_session`) are unchanged.

### Fixed
- `package.json` repository, homepage and bugs URLs point at ArkFlame/claude-opencode-mcp.
- Runtime dependencies `@modelcontextprotocol/sdk` (1.32.2), `zod` (4.6.7) and `body-parser` (2.4.0, via override) move past their high-severity advisories.

## [1.1.0] - 2026-09-30

### Added

- **Orchestrator permission overrides.** `delegate_task`, `create_session` and
  `send_message` accept `allow_edits` and `allow_bash` (true grants, false
  revokes, omitted keeps the agent default), so any agent — including
  `deepseek-researcher` — can be given read/write or shell access per call.
  Grants map to safe profiles: sensitive-file protection still applies to
  granted edits and git history protection still applies to granted shell
  access. Sessions persist their permission level (`can_edit` /
  `can_run_bash`), and the task context states the granted permissions
  explicitly.

### Fixed

- **Long delegations failed after exactly ~5 minutes with `fetch failed`.**
  The bridge held a synchronous `POST /session/:id/message` request open for
  the whole run, and Node's built-in fetch aborts requests that take longer
  than 5 minutes to return response headers. Runs now use `prompt_async` plus
  polling, so delegation time is bounded only by the configured timeout.
- Concurrent delegations to the same workspace could start two OpenCode
  servers because startup was not deduplicated; in-flight startups are now
  shared.
- Multiple Claude sessions (each with its own bridge process) overwrote each
  other's entries in the shared session registry; persistence now performs a
  read-merge-write, and stale `running` records from dead bridges are reported
  as failed instead of running forever.

## [1.0.0] - 2026-09-24

First stable release.

### Added

- MCP stdio server with seven tools: `delegate_task`, `create_session`,
  `send_message`, `get_session`, `get_diff`, `abort_session`, `list_agents`.
- OpenCode runtime management: lazy start of one headless server per workspace,
  health checks, LRU eviction (`opencode.maxServers`), crash detection,
  graceful shutdown, and no orphaned processes.
- Agent system with four profiles enforced through OpenCode permissions:
  `deepseek-researcher`, `deepseek-reviewer` (read-only),
  `deepseek-coder` (edits + shell), `deepseek-tester` (shell, no edits).
- Workspace resolution (`cwd` → `CLAUDE_PROJECT_DIR` → process cwd →
  configured default) with canonical-path validation, allowed roots, git-root
  detection, and a per-workspace routing probe (`WORKSPACE_MISMATCH`).
- Persistent sessions: `create_session` / `send_message` keep agent context;
  registry stored at `~/.local/state/claude-opencode-mcp/sessions.json`
  (mode `0600`) and pruned after 14 days.
- `get_diff` for reviewing agent changes: OpenCode session diff when
  available, otherwise a git diff against a baseline captured at session
  creation (pre-existing dirty state is isolated).
- Reliability: per-run timeouts (`AGENT_TIMEOUT`), MCP cancellation
  (`AGENT_ABORTED`), progress notifications, structured error codes, request
  IDs, and a rotating `0600` log file.
- Security defaults: `.env`/key/credential read and edit protection, `git
  commit`/`git push` denied for shell-enabled agents, `external_directory`
  denied, no `ask` permission rules, and auto-rejection of stray permission
  requests so headless runs cannot hang. Log fields matching
  password/secret/token/api-key patterns are redacted.
- Configuration layering: global (`~/.config/claude-opencode-mcp/config.json`),
  project (`.claude-opencode/config.json`), explicit
  (`CLAUDE_OPENCODE_CONFIG`), with deep merge and Zod validation.
- `claude-opencode init` validator/scaffolder (config + agent files, optional
  `.mcp.json`) and `claude-opencode-mcp` executable for `npx`.
- Documentation set covering installation, configuration, Claude Code, OpenCode,
  DeepSeek, agents, workspace model, security, architecture, development,
  contributing, and troubleshooting.
- Test suite: unit and integration tests with a fake OpenCode server, plus
  opt-in real OpenCode/DeepSeek E2E checkpoints and a full multi-agent
  workflow acceptance test.
- CI across Node 20/22/24 (Ubuntu) and Node 24 (macOS), plus an opt-in,
  push-only real-provider E2E job.

[Unreleased]: https://github.com/ArkFlame/claude-opencode-mcp/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/ArkFlame/claude-opencode-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ArkFlame/claude-opencode-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ArkFlame/claude-opencode-mcp/releases/tag/v1.0.0
