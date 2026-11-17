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
}): string {
  const sections: string[] = [];
  if (input.header) sections.push(input.header.trim());
  sections.push(`# Task\n\n${input.task.trim()}`);
  if (input.brief?.trim()) sections.push(`# Brief\n\n${input.brief.trim()}`);
  if (input.readPaths.length > 0) {
    const list = input.readPaths.map((entry) => `- ${entry}`).join("\n");
    sections.push(
      `# Read-only reference paths\n\nRead these for context. Do not modify them.\n\n${list}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}
