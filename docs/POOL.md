# Pool mode (v1.3.0)

Pool mode runs one OpenCode worker per open unit file in a shared checkout. It is for large backlogs
of small, independent edits where a git worktree per task is too heavy. Build and test once, after
the batch lands.

## Pieces

| Tool | Purpose |
| --- | --- |
| `delegate_task` with `shared: true` | One run directly in `cwd`, no worktree. The worker is told not to run the `forbid` commands (default `git`, `cargo`) and not to commit. |
| `run_pool` | Start a detached supervisor over `units_glob`. Returns `pool_id` at once. |
| `pool_status` | Per-lane progress, provider hits, stale workers and an ETA. Read-only. |
| `auto_commit` | Background loop: commit pending changes per area, then push the branch. |
| `usage_stats` | Model figures from the opencode database, opened read-only. |

`abort_all` stops every pool and its workers. `abort_run` on a pool worker stops that unit only.
`list_runs` shows pool workers with a `pool` field.

## run_pool

```json
{
  "units_glob": "/repo/docs/units/*.md",
  "marker": "STILL OPEN",
  "brief_template_path": "/repo/docs/units/BRIEF.md",
  "cwd": "/repo",
  "lanes": [
    { "name": "fast", "model": "opencode-go/hy4-flash-free", "cap": 6 },
    { "name": "backup", "model": "deepseek/deepseek-v4-pro", "cap": 2 }
  ],
  "per_file_cap": 2,
  "timeout_s": 1200,
  "forbid": ["git", "cargo"]
}
```

- `units_glob` must be absolute. Wildcards are allowed only in the file name (`*` and `?`).
- A unit is open when its file contains `marker`. A unit whose `<unit>.exit` file holds `0` is
  finished and is never relaunched.
- The brief template may use `{{UNIT_PATH}}`, `{{UNIT_NAME}}` and `{{UNIT_KEY}}`. The pool appends
  a shared-checkout section that lists the forbidden commands.
- Lanes are tried in the order given. Each lane has a `cap`, the maximum concurrent workers.
- Calling `run_pool` again with the same `units_glob` and `cwd` adopts the live supervisor. It
  does not start a second one or change its config.

## Scheduling and conflicts

- The supervisor is a detached process (`setsid`, own process group). It outlives the MCP server.
  On restart it adopts workers whose pid is still alive and requeues the rest.
- Two units never run together when they name the same `.rs` basename (regex
  `[A-Za-z0-9_]+\.rs`). The check reads the unit file text.
- Generic names (`mod.rs`, `lib.rs`, `main.rs`, `tests.rs`, `registry.rs`) and hub names (named by
  8 or more open units) are not exclusive. Instead, at most `per_file_cap` units that name the same
  one run at once.
- A slot is refilled as soon as a worker ends. The queue is sorted by unit key.

## Limits and failures

- **Provider limits.** A log tail matching
  `usage limit|Insufficient balance|rate limit|429|timed out|timeout|tier_limit_exceeded|concurrency limit|rpm limit|Provider blocked`
  (case-insensitive) on a failed run requeues the unit. The lane's cap drops by one (never below 0),
  and the lane backs off for `120 s x hits`. A run that exits 0 with a `Status:` line is not a limit,
  even if it mentions one of these words.
- **Six in a row.** Six consecutive limit hits across all lanes stop the pool. Running workers are
  terminated and their units requeued. Restart with `run_pool` after the limit resets.
- **Hard timeout.** `timeout_s` (default 1200) kills the worker's whole process group. The unit is
  requeued once. A second timeout marks it `failed`.
- **Lost worker.** A worker that disappears with no exit code is requeued up to three attempts.
- **Other failures.** A non-zero exit that is not a limit marks the unit `failed` with the exit code.
  A later `run_pool` retries failed units.
- **Stop.** `abort_all` or the `stop` file in the pool directory stops the supervisor. The workers
  are killed and their units marked `aborted`.

## Files

Pool state lives under `<runs dir>/pools/<pool_id>/`, where the runs dir is
`CLAUDE_OPENCODE_RUNS_DIR` or `~/.cache/claude-opencode-mcp/runs`:

| File | Content |
| --- | --- |
| `config.json` | The pool config the supervisor was started with (brief template included) |
| `pool.json` | Pool status, supervisor pid, lane caps, hits, backoff |
| `<unit>.json` | Unit state: lane, state, attempts, timeouts, pid, pgid, timestamps |
| `<unit>.log` | Worker output (truncated on each attempt) |
| `<unit>.exit` | Exit code written by the wrapper |
| `<unit>.prompt.md` | The rendered prompt for the last attempt |
| `<unit>.abort`, `stop` | Markers the supervisor reads on its next tick |
| `supervisor.log` | Supervisor stderr |

Each unit is also mirrored into the run store (`<runs dir>/<run_id>.json`) with `pool` set, so
`list_runs` and `abort_all` see it.

## pool_status

Per lane: `running`, `done`, `failed`, `hits`, `avg_seconds`, `effective_cap` and
`backing_off_until`. Also: queued count, `stale_workers` (log idle over 300 s), `rate_per_minute`
from completions in the last 10 minutes, and `eta_minutes`.

## auto_commit

`auto_commit` with `action: "start"` and `cwd` begins a loop every `interval_s` seconds (default
120, range 30 to 3600). Each pass:

1. Reads `git status --porcelain=v1 -z`. Skips `.env*`, `node_modules/`, `dist/`, `*.pem`, `*.key`.
2. Groups the paths by area. An area is the crate under `crates/`, `tools/`, `packages/`, `apps/`,
   or `src/`, else the top-level directory, else `root`. Docs-only areas use `docs(...)`, others
   `fix(...)`.
3. Commits each area with `git commit -m <subject> -m <trailer> -- <paths>`. The trailer is
   `Co-Authored-By: opencode-agent[bot] <219766164+opencode-agent[bot]@users.noreply.github.com>`.
4. Pushes the current branch to `origin`. A failed push is recorded and skipped.

Stop with `action: "stop"` or by creating the stop file named in `status`. The loop runs inside the
MCP server process, so it stops when that process exits. Arguments go to git as argv arrays, never
through a shell.

## usage_stats

Reads `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share/opencode/opencode.db`) and
never writes to it. It uses `node:sqlite` (Node 22.13 or later) in read-only mode. Otherwise it runs
`sqlite3 -readonly -json`. It scans the newest `limit` assistant messages (default 5000), optionally
filtered by session title prefix, and reports per model:

- sessions, messages, median and mean output and reasoning tokens per session
- `reasoning_share` = reasoning / (output + reasoning)
- median steps per session
- median time to first token (`firstToken - created`, ms)
- median tokens per second (`output / (streamed - firstToken)`)

## Shared-checkout worker rules

Shared workers share one checkout, so the rules are strict. Each worker:

- touches only the files its unit needs
- does not switch branches, stash, reset, rebase or commit
- does not run the `forbid` commands
- ends its reply with `Status: PASS|UNVERIFIED|BLOCKED|FAILED`

The orchestrator runs builds and tests after the batch. `auto_commit` (or the orchestrator) commits.

## Queued messages

`queue_message` sends a follow-up to a pool unit or an OpenCode session. Messages live in
`<runs dir>/<run id>.inbox.jsonl`, one JSON object per line, rewritten atomically (temp file, then
rename). Each message has an `id` (`msg_` + 12 hex), `ts`, `mode`, `status` (`queued`, `delivered`,
`cancelled`, `failed`), `priority`, `attempts`, `last_error` and `next_attempt_at`.

- `mode: "when_idle"` (default) waits for the unit to finish its current attempt.
- `mode: "now"` interrupts a running unit: the supervisor sends SIGTERM to the process group,
  waits for the exit, and redelivers the message on the same session. The interrupted attempt is
  not counted against the message. A "now" message to an `aborted` run resurrects it; a
  `when_idle` message to an aborted run is refused.
- Order: higher `priority` first, then "now" before "when_idle", then arrival.

Delivery to pool units:

- A queued message wakes a finished or failed unit. The supervisor launches
  `opencode run --session <session id> --auto -m <lane model> --format json -- <message>` with
  the message as one argv entry, never through a shell.
- The session id comes from the newest OpenCode session titled `pool <unit>` (or `pool:<unit>`),
  read through `node:sqlite` or the `sqlite3 -readonly` CLI.
- Redeliveries are scheduled like any unit: they use the lane caps and backoff, and they run
  before fresh units.
- `queue_message` starts a supervisor with `--redeliver-only` when the pool is not running. That
  mode launches only units that have a due message, so a stopped pool's other units are not
  rerun.
- A limit hit refunds the attempt and requeues the message. Three failed attempts mark it `failed`.
- A unit without a session (its brief has not started yet) keeps the message queued until a
  session exists. A finished unit with no session fails its messages.

Delivery to OpenCode sessions (`create_session` and `delegate_task` sessions) uses OpenCode's
async prompt call. OpenCode appends the message to the session queue when the session is busy and
starts it when idle. "now" first calls `session.abort`. A refused send retries after 5 s × attempt
count, from a timer in the MCP server process.

Limits: background CLI runs that are not pool units are not supported and are refused. Delivery
between two processes that write the same inbox is last-writer-wins for the rewrite window, so
keep one MCP server per runs directory. Messages are untrusted instructions; `list_messages`
shows only a 200-character preview.
