import { BridgeError } from "../errors.js";

/** Run labels and worktree names: lowercase, no separators, no traversal, no shell metacharacters. */
export const RUN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/;

/** Git ref-ish base for worktrees: no leading dash (option injection), no `..`. */
const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

/** Model ids look like `provider/model` with optional `#variant`. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:#-]{0,200}$/;

export function isValidRunName(name: string): boolean {
  return RUN_NAME_PATTERN.test(name) && !name.includes("..");
}

export function assertRunName(name: string, label = "name"): string {
  if (!isValidRunName(name)) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `${label} must match ${RUN_NAME_PATTERN.source} (lowercase letters, digits, ., _, -).`,
      { details: { [label]: name } },
    );
  }
  return name;
}

export function assertBaseRef(base: string): string {
  if (!BASE_PATTERN.test(base) || base.includes("..")) {
    throw new BridgeError("INVALID_ARGUMENT", "base must be a plain git ref name.", {
      details: { base },
    });
  }
  return base;
}

export function assertModelId(model: string): string {
  if (!MODEL_PATTERN.test(model)) {
    throw new BridgeError("INVALID_ARGUMENT", "model must look like provider/model.", {
      details: { model },
    });
  }
  return model;
}
