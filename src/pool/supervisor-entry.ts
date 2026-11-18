import { REDELIVER_ONLY_FLAG } from "./launch.js";
import { runSupervisor } from "./supervisor.js";

/** Detached process entry: `node supervisor-entry.js <config.json> [--redeliver-only]`. */
const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("usage: supervisor-entry.js <config.json> [--redeliver-only]\n");
  process.exit(2);
}
const redeliverOnly = process.argv.includes(REDELIVER_ONLY_FLAG);

runSupervisor(configPath, undefined, { redeliverOnly }).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `pool supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
