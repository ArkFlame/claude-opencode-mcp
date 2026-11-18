import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_READ_PATHS = 20;

/** Generic worker contract. Override with CLAUDE_OPENCODE_BRIEF_HEADER or runs.briefHeaderFile. */
export const DEFAULT_BRIEF_HEADER = [
  "# Worker contract",
  "",
  "You are a worker running in an isolated git worktree. Follow these rules:",
  "- Do not run build, compile or test-suite commands unless the brief explicitly requires them.",
  "- Do not merge, rebase, push, or touch other branches or worktrees.",
  "- Commit your verified changes with one subject-only conventional commit line, e.g. `fix(parser): handle empty input`. No body.",
  "- Your final reply must end with `Status: PASS|UNVERIFIED|BLOCKED|FAILED` on its own line, followed by the commit hash (or `none`).",
  "- If blocked, stop and report the blocker in the final reply.",
].join("\n");

/** Commands shared-checkout workers must not run unless they are told otherwise. */
export const DEFAULT_FORBIDDEN_COMMANDS = ["git", "cargo"];
const MAX_FORBID_ENTRIES = 20;
const FORBID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export const SHARED_BRIEF_HEADER = [
  "# Worker contract (shared checkout)",
  "",
  "You edit a checkout that other workers edit at the same time. Follow these rules:",
  "- Touch only the files your task needs. Do not reformat or rename files you do not own.",
  "- Do not switch branches, stash, reset, rebase, or commit. The orchestrator commits.",
  "- Your final reply must end with `Status: PASS|UNVERIFIED|BLOCKED|FAILED` on its own line.",
  "- If blocked, stop and report the blocker in the final reply.",
].join("\n");

export function validateForbid(list: string[] | undefined): string[] {
  const forbid = list ?? DEFAULT_FORBIDDEN_COMMANDS;
  if (forbid.length > MAX_FORBID_ENTRIES) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `forbid accepts at most ${MAX_FORBID_ENTRIES} entries.`,
    );
  }
  for (const entry of forbid) {
    if (!FORBID_PATTERN.test(entry)) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        `forbid entries must be plain command names: ${entry}`,
      );
    }
  }
  return [...new Set(forbid)];
}

/** Prompt section for shared-checkout runs: the command ban list and the no-git rule. */
export function sharedSection(forbid: string[]): string {
  const list = forbid.length > 0 ? forbid.map((cmd) => `\`${cmd}\``).join(", ") : "none";
  return [
    "# Shared checkout",
    "",
    `Do not run these commands: ${list}. Do not run any command that starts with them.`,
    "The orchestrator runs builds, tests and commits after the batch lands.",
  ].join("\n");
}

export function loadBriefHeader(file: string | null): string {
  if (!file) return DEFAULT_BRIEF_HEADER;
  try {
    const text = fs.readFileSync(file, "utf8");
    return Buffer.byteLength(text, "utf8") > MAX_HEADER_BYTES
      ? Buffer.from(text, "utf8").subarray(0, MAX_HEADER_BYTES).toString("utf8")
      : text;
  } catch (error) {
    throw new BridgeError("CONFIG_INVALID", `Could not read brief header file ${file}`, {
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Validate read-only reference paths: absolute, existing, bounded count. */
export function validateReadPaths(paths: string[] | undefined): string[] {
  const list = paths ?? [];
  if (list.length > MAX_READ_PATHS) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `read_paths accepts at most ${MAX_READ_PATHS} entries.`,
    );
  }
  return list.map((entry) => {
    if (!path.isAbsolute(entry) || entry.includes("\0")) {
      throw new BridgeError("INVALID_PATH", `read_paths must be absolute paths: ${entry}`);
    }
    const resolved = path.resolve(entry);
    if (!fs.existsSync(resolved)) {
      throw new BridgeError("INVALID_PATH", `read_paths entry does not exist: ${resolved}`);
    }
    return resolved;
  });
}

export function buildPrompt(input: {
  header: string | null;
  task: string;
  brief: string | null;
  readPaths: string[];
  shared?: { forbid: string[] } | null;
}): string {
  const sections: string[] = [];
  if (input.header) sections.push(input.header.trim());
  sections.push(`# Task\n\n${input.task.trim()}`);
  if (input.brief?.trim()) sections.push(`# Brief\n\n${input.brief.trim()}`);
  if (input.shared) sections.push(sharedSection(input.shared.forbid));
  if (input.readPaths.length > 0) {
    const list = input.readPaths.map((entry) => `- ${entry}`).join("\n");
    sections.push(
      `# Read-only reference paths\n\nRead these for context. Do not modify them.\n\n${list}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}
