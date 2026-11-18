import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAttempt } from "../../src/runs/attempt.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function attempt(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cop-idle-"));
  dirs.push(dir);
  const logFile = path.join(dir, "run.log");
  const spec = {
    command: process.execPath,
    args: ["-e", script],
    cwd: dir,
    env: { ...process.env, COP_LOG: logFile },
    logFile,
  };
  return { spec, logFile };
}

const LIMITS = { timeoutMs: 20_000, idleMs: 300, confirmMs: 100 };

describe("idle watchdog", () => {
  it("completes a silent run that already printed its final text", async () => {
    const { spec } = attempt(
      `process.stdout.write(JSON.stringify({type:"text",part:{text:"final",messageID:"m1"}})+"\\n");` +
        "setInterval(() => {}, 1000);",
    );
    const result = await runAttempt(spec, LIMITS);
    expect(result.end).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("final");
  }, 15_000);

  it("stops a silent run with no final text as idle", async () => {
    const { spec } = attempt("setInterval(() => {}, 1000);");
    const result = await runAttempt(spec, LIMITS);
    expect(result.end).toBe("idle");
  }, 15_000);

  it("counts log growth as activity even without stdout lines", async () => {
    // Writes to the log file every 100 ms for 3 s, longer than the 2 s idle limit with no stdout.
    const { spec } = attempt(
      "const fs=require('node:fs');let n=0;const t=setInterval(()=>{fs.appendFileSync(process.env.COP_LOG,'tick\\n');if(++n>=30)clearInterval(t);},100);",
    );
    const result = await runAttempt(spec, { ...LIMITS, timeoutMs: 30_000, idleMs: 2_000 });
    expect(result.end).toBe("exit");
  }, 15_000);
});
