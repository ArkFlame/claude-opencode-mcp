import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";

export const MAX_UNIT_FILES = 2_000;
const MAX_UNIT_BYTES = 256 * 1024;

export interface UnitFile {
  file: string;
  text: string;
}

/** Glob metacharacters are allowed only in the last path segment. */
export function splitUnitsGlob(glob: string): { dir: string; pattern: string } {
  if (!path.isAbsolute(glob) || glob.includes("\0")) {
    throw new BridgeError("INVALID_PATH", `units_glob must be an absolute path: ${glob}`);
  }
  const dir = path.dirname(glob);
  const pattern = path.basename(glob);
  if (/[*?[\]{}]/.test(dir)) {
    throw new BridgeError("INVALID_PATH", "units_glob may use wildcards only in the file name.");
  }
  if (!pattern.includes("*") && !pattern.includes("?")) {
    throw new BridgeError("INVALID_PATH", "units_glob must contain a * or ? in the file name.");
  }
  return { dir, pattern };
}

/** Translate a file-name glob (`*`, `?`, literal everything else) into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const ch of pattern) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Read every regular file matching units_glob, sorted by name. Oversized files are truncated. */
export function scanUnits(unitsGlob: string): UnitFile[] {
  const { dir, pattern } = splitUnitsGlob(unitsGlob);
  const matcher = globToRegExp(pattern);
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length > MAX_UNIT_FILES) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `units_glob matches more than ${MAX_UNIT_FILES} files.`,
    );
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    const buffer = fs.readFileSync(file);
    return { file, text: buffer.subarray(0, MAX_UNIT_BYTES).toString("utf8") };
  });
}
