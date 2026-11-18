import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { git as runGitCommand } from "../runs/worktree.js";

export const AUTO_COMMIT_TRAILER =
  "Co-Authored-By: opencode-agent[bot] <219766164+opencode-agent[bot]@users.noreply.github.com>";
export const MIN_INTERVAL_S = 30;
export const MAX_INTERVAL_S = 3_600;
const DEFAULT_INTERVAL_S = 120;
const AREA_ROOTS = new Set(["crates", "tools", "packages", "apps", "src", "lib"]);
/** Never commit secrets or build output, even when a worker wrote them. */
const SKIP_PATTERN = /(^|\/)(\.env(\..*)?|node_modules\/|dist\/|\.DS_Store)|\.(pem|key)$/;

export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface PlannedCommit {
  area: string;
  type: "fix" | "docs";
  subject: string;
  paths: string[];
}

/** Area name for a changed path: crate or top-level directory, lowercase, safe characters only. */
export function areaOf(file: string): string {
  const parts = file.split("/");
  let area: string;
  if (parts.length === 1) area = "root";
  else if (AREA_ROOTS.has(parts[0] ?? "") && parts.length > 2) area = parts[1] ?? "root";
  else area = parts[0] ?? "root";
  const clean = area
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return clean || "repo";
}

/** Group changed paths into one conventional subject-only commit per area. */
export function planCommits(files: readonly string[]): PlannedCommit[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    if (SKIP_PATTERN.test(file)) continue;
    const area = areaOf(file);
    groups.set(area, [...(groups.get(area) ?? []), file]);
  }
  const plans: PlannedCommit[] = [];
  for (const [area, paths] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const docsOnly = paths.every((file) => file.endsWith(".md") || file.startsWith("docs/"));
    const type = area === "docs" || docsOnly ? "docs" : "fix";
    const noun = paths.length === 1 ? "file" : "files";
    plans.push({
      area,
      type,
      subject: `${type}(${area}): apply worker changes to ${paths.length} ${noun}`,
      paths,
    });
  }
  return plans;
}

/** Parse `git status --porcelain=v1 -z`. Renames keep only the new path. */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return files;
}

export interface AutoCommitStatus {
  running: boolean;
  cwd: string | null;
  interval_s: number | null;
  ticks: number;
  commits: number;
  pushes: number;
  push_failures: number;
  last_tick_at: number | null;
  last_error: string | null;
  stop_file: string | null;
}

export interface AutoCommitOptions {
  runsDir: string;
  git?: GitRunner;
  now?: () => number;
}

/** One background loop at a time. It commits and pushes pending changes of a shared checkout. */
export class AutoCommitter {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private cwd: string | null = null;
  private intervalS: number | null = null;
  private stopFile: string | null = null;
  private stats = {
    ticks: 0,
    commits: 0,
    pushes: 0,
    pushFailures: 0,
    lastTick: null as number | null,
    lastError: null as string | null,
  };
  private readonly git: GitRunner;
  private readonly now: () => number;

  constructor(private readonly options: AutoCommitOptions) {
    this.git = options.git ?? ((args, cwd) => runGitCommand(args, cwd));
    this.now = options.now ?? (() => Date.now());
  }

  stopFileFor(cwd: string): string {
    const hash = Buffer.from(cwd).toString("base64url").slice(-24);
    return path.join(this.options.runsDir, `auto-commit-${hash}.stop`);
  }

  start(cwd: string, intervalS = DEFAULT_INTERVAL_S): AutoCommitStatus {
    if (this.timer)
      throw new BridgeError("INVALID_ARGUMENT", "auto_commit is already running; stop it first.");
    if (!Number.isInteger(intervalS) || intervalS < MIN_INTERVAL_S || intervalS > MAX_INTERVAL_S) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `interval_s must be ${MIN_INTERVAL_S}..${MAX_INTERVAL_S}.`,
      );
    }
    this.cwd = cwd;
    this.intervalS = intervalS;
    this.stopFile = this.stopFileFor(cwd);
    fs.mkdirSync(this.options.runsDir, { recursive: true, mode: 0o700 });
    fs.rmSync(this.stopFile, { force: true });
    this.stats = {
      ticks: 0,
      commits: 0,
      pushes: 0,
      pushFailures: 0,
      lastTick: null,
      lastError: null,
    };
    this.timer = setInterval(() => void this.tick(), intervalS * 1000);
    this.timer.unref();
    return this.status();
  }

  stop(): AutoCommitStatus {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stopFile) fs.writeFileSync(this.stopFile, "stop\n", { mode: 0o600 });
    return this.status();
  }

  status(): AutoCommitStatus {
    return {
      running: this.timer !== null,
      cwd: this.cwd,
      interval_s: this.intervalS,
      ticks: this.stats.ticks,
      commits: this.stats.commits,
      pushes: this.stats.pushes,
      push_failures: this.stats.pushFailures,
      last_tick_at: this.stats.lastTick,
      last_error: this.stats.lastError,
      stop_file: this.stopFile,
    };
  }

  /** One pass: honour the stop file, commit each area, push the branch. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.busy || !this.cwd) return;
    if (this.stopFile && fs.existsSync(this.stopFile)) {
      this.stop();
      return;
    }
    this.busy = true;
    const cwd = this.cwd;
    this.stats.lastError = null;
    try {
      this.stats.ticks += 1;
      this.stats.lastTick = this.now();
      const status = await this.git(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd,
      );
      if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
      const plans = planCommits(parsePorcelainZ(status.stdout));
      for (const plan of plans) {
        await this.commitPlan(cwd, plan);
      }
      if (plans.length > 0) await this.pushBranch(cwd);
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  private async commitPlan(cwd: string, plan: PlannedCommit): Promise<void> {
    const add = await this.git(["add", "--", ...plan.paths], cwd);
    if (add.code !== 0) {
      this.stats.lastError = `git add failed for ${plan.area}: ${add.stderr.trim()}`;
      return;
    }
    const commit = await this.git(
      ["commit", "-m", plan.subject, "-m", AUTO_COMMIT_TRAILER, "--", ...plan.paths],
      cwd,
    );
    if (commit.code === 0) this.stats.commits += 1;
    else
      this.stats.lastError = `git commit failed for ${plan.area}: ${commit.stderr.trim() || commit.stdout.trim()}`;
  }

  private async pushBranch(cwd: string): Promise<void> {
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const name = branch.stdout.trim();
    if (branch.code !== 0 || !name || name === "HEAD") return;
    const push = await this.git(["push", "origin", name], cwd);
    if (push.code === 0) {
      this.stats.pushes += 1;
    } else {
      this.stats.pushFailures += 1;
      this.stats.lastError = `push skipped: ${push.stderr.trim().split("\n").pop() ?? "push failed"}`;
    }
  }
}
