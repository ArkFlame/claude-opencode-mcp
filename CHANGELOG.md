# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
