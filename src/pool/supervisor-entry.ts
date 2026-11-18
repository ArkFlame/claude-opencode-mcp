import { runSupervisor } from "./supervisor.js";

/** Detached process entry: `node supervisor-entry.js <config.json>`. Started by run_pool. */
const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("usage: supervisor-entry.js <config.json>\n");
  process.exit(2);
}

runSupervisor(configPath).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `pool supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
