import { stripAnsi } from "../util/text.js";

/** Hard cap for any run text returned to the orchestrator. */
export const MAX_RESULT_BYTES = 16 * 1024;

export interface BoundedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/** Strip ANSI and keep at most `maxBytes` UTF-8 bytes (head kept, marker appended). */
export function boundText(raw: string, maxBytes = MAX_RESULT_BYTES): BoundedText {
  const text = stripAnsi(raw);
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  const marker = "\n… [truncated; see log_path for the full output]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let kept = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8");
  // Drop a trailing replacement char left by a split multi-byte sequence.
  kept = kept.replace(/�$/, "");
  return { text: `${kept}${marker}`, truncated: true, originalBytes };
}

export interface FinalSummary {
  status: "PASS" | "UNVERIFIED" | "BLOCKED" | "FAILED" | null;
  commit: string | null;
  tests: string[];
}

/** Pull the worker contract fields (Status, commit hash, test lines) out of a final reply. */
export function summarizeFinal(text: string | null): FinalSummary {
  if (!text) return { status: null, commit: null, tests: [] };
  const status = /Status:\s*(PASS|UNVERIFIED|BLOCKED|FAILED)\b/i.exec(text);
  const commit = /\bcommit\b[^0-9a-f\n]{0,12}([0-9a-f]{7,40})\b/i.exec(text);
  const tests = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\b(tests?|passed|failed|vitest|nextest|cargo test)\b/i.test(line))
    .slice(0, 8)
    .map((line) => line.slice(0, 200));
  return {
    status: status ? (status[1]?.toUpperCase() as FinalSummary["status"]) : null,
    commit: commit?.[1] ?? null,
    tests,
  };
}
