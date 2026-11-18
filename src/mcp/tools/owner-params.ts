import { z } from "zod";

/** Shared scope and force inputs for tools that see or act on runs of several Claude sessions. */
export const SCOPE_PARAM = z
  .enum(["mine", "all"])
  .optional()
  .describe(
    "mine (default): only runs of this Claude session. all: every session's runs, each with owner_label and mine.",
  );

export const FORCE_PARAM = z
  .boolean()
  .optional()
  .describe("Act on a run or message owned by another Claude session (default false).");
