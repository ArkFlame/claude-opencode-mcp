#!/usr/bin/env node
// Test double for the `opencode` CLI (path contains "opencode" so reaper checks match it).
// FAKE_MODE: reply (default) | silent (exit 0, no reply) | fail (exit 2) | hang (never ends).
// FAKE_DELAY_MS delays the reply. FAKE_PID_FILE receives the pid of a grandchild in hang mode.
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("opencode-go/hy4-flash-free\nopencode/other-model\n");
  process.exit(0);
}

const mode = process.env.FAKE_MODE ?? "reply";
const delay = Number(process.env.FAKE_DELAY_MS ?? "0");
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (mode === "hang") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (process.env.FAKE_PID_FILE)
    fs.writeFileSync(process.env.FAKE_PID_FILE, String(grandchild.pid));
  emit({ type: "step_start", part: { type: "step-start" } });
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    if (mode === "silent") process.exit(0);
    if (mode === "fail") {
      process.stderr.write("provider error\n");
      process.exit(2);
    }
    emit({
      type: "text",
      part: {
        messageID: "msg_final",
        type: "text",
        text: "Finished.\nStatus: PASS\nCommit: 1234abc",
      },
    });
    emit({ type: "step_finish", part: { reason: "stop" } });
    process.exit(0);
  }, delay);
}
