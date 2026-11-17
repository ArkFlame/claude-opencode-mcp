import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { isPathInside } from "../security/paths.js";
import { KeyedMutex } from "./lock.js";
import { assertBaseRef, assertRunName } from "./names.js";

/** All worktree git operations share one lock: cold adds of large repos starve each other otherwise. */
const GIT_LOCK = new KeyedMutex();
const GIT_LOCK_KEY = "git-worktree";
const GIT_TIMEOUT_MS = 15 * 60_000;

export const BRANCH_PREFIX = "kab/";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with an argv array (never a shell). Non-zero exits resolve with the code. */
export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          reject(error);
          return;
        }
        const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function gitOrThrow(args: string[], cwd: string, message: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new BridgeError("INVALID_ARGUMENT", message, {
      details: { stderr: result.stderr.trim().slice(0, 800) },
    });
  }
  return result.stdout;
}

export async function repoRootOf(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  const top = result.stdout.trim();
  if (result.code !== 0 || !top) {
    throw new BridgeError("NOT_GIT_REPOSITORY", `Not a git repository: ${cwd}`);
  }
  return fs.realpathSync(top);
}

/** `<parent>/<repo>-wt/<name>`, the layout used by the worktree helpers. */
export function worktreePathFor(repoRoot: string, name: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-wt`, name);
}

export function branchFor(name: string): string {
  return `${BRANCH_PREFIX}${name}`;
}

/** Default allowed root: the directory holding the repository and its sibling *-wt dirs. */
export function defaultAllowedRoot(repoRoot: string): string {
  return path.dirname(repoRoot);
}

export function assertInsideRoots(target: string, roots: string[]): void {
  if (roots.length === 0) return;
  if (roots.some((root) => isPathInside(root, target))) return;
  throw new BridgeError("WORKSPACE_NOT_ALLOWED", `Path is outside the allowed roots: ${target}`, {
    details: { target, allowed_roots: roots },
  });
}

export interface WorktreeResult {
  path: string;
  branch: string;
  base: string | null;
  reused: boolean;
}

export async function createWorktree(input: {
  cwd: string;
  name: string;
  base?: string | undefined;
  allowedRoots: string[];
}): Promise<WorktreeResult> {
  assertRunName(input.name);
  const base = assertBaseRef(input.base?.trim() || "HEAD");
  const repo = await repoRootOf(input.cwd);
  const target = worktreePathFor(repo, input.name);
  const roots = input.allowedRoots.length > 0 ? input.allowedRoots : [defaultAllowedRoot(repo)];
  assertInsideRoots(target, roots);
  const branch = branchFor(input.name);

  return GIT_LOCK.run(GIT_LOCK_KEY, async () => {
    if (fs.existsSync(target)) {
      const top = await git(["rev-parse", "--show-toplevel"], target);
      const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], target);
      const dirty = await git(["status", "--porcelain"], target);
      if (
        top.code === 0 &&
        fs.realpathSync(top.stdout.trim()) === fs.realpathSync(target) &&
        current.stdout.trim() === branch &&
        dirty.stdout.trim() === ""
      ) {
        return { path: target, branch, base: null, reused: true };
      }
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `Path exists and is not a clean worktree of ${branch}.`,
        {
          details: { path: target, branch },
        },
      );
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const branchExists =
      (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
    const args = branchExists
      ? ["worktree", "add", target, branch]
      : ["worktree", "add", "-b", branch, target, base];
    await gitOrThrow(args, repo, "git worktree add failed.");
    return { path: target, branch, base: branchExists ? null : base, reused: false };
  });
}

/** Commits on `branch` that are not in `base` (git cherry lines starting with '+'). */
export async function unlandedCommits(
  repo: string,
  base: string,
  branch: string,
): Promise<string[]> {
  const out = await gitOrThrow(["cherry", base, branch], repo, "git cherry failed.");
  return out
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1).trim());
}

export async function defaultBase(repo: string): Promise<string> {
  const remote = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim();
  const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  const name = current.stdout.trim();
  return name && name !== "HEAD" ? name : "HEAD";
}

export interface RemoveResult {
  path: string;
  branch: string;
  branch_deleted: boolean;
  removed_path: boolean;
}

export async function removeWorktree(input: {
  cwd: string;
  name: string;
  base?: string | undefined;
  force?: boolean | undefined;
  allowedRoots: string[];
}): Promise<RemoveResult> {
  assertRunName(input.name);
  const repo = await repoRootOf(input.cwd);
  const target = worktreePathFor(repo, input.name);
  const roots = input.allowedRoots.length > 0 ? input.allowedRoots : [defaultAllowedRoot(repo)];
  assertInsideRoots(target, roots);
  const branch = branchFor(input.name);
  const base = input.base?.trim() ? assertBaseRef(input.base.trim()) : await defaultBase(repo);
  const force = input.force === true;

  return GIT_LOCK.run(GIT_LOCK_KEY, async () => {
    const branchExists =
      (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
    const unlanded = branchExists ? await unlandedCommits(repo, base, branch) : [];
    if (unlanded.length > 0 && !force) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `Refusing to remove ${branch}: ${unlanded.length} commit(s) are not in ${base}. Land them or pass force=true.`,
        { details: { branch, base, unlanded_commits: unlanded.length } },
      );
    }
    const removedPath = fs.existsSync(target);
    if (removedPath) {
      const args = ["worktree", "remove", ...(force ? ["--force"] : []), target];
      await gitOrThrow(args, repo, "git worktree remove failed.");
    }
    let branchDeleted = false;
    if (branchExists) {
      const flag = force || unlanded.length === 0 ? "-D" : "-d";
      branchDeleted = (await git(["branch", flag, branch], repo)).code === 0;
    }
    return { path: target, branch, branch_deleted: branchDeleted, removed_path: removedPath };
  });
}
