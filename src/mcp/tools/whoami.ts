import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterByScope, ownershipOf } from "../../runs/owner.js";
import type { AppContext } from "../execute.js";
import { jsonResult } from "../tool-utils.js";

export function registerWhoami(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "whoami",
    {
      title: "This Claude session",
      description:
        "Return this server's owner identity (id, label, pid, ppid), how many runs belong to this session and to other sessions, and the shared runs directory.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const me = ctx.runs.owner;
      const runs = ctx.runs.store.list();
      const mine = filterByScope(runs, "mine", me).length;
      const others = runs.filter((record) => ownershipOf(record, me).foreign).length;
      return jsonResult({
        owner: { id: me.id, label: me.label, pid: me.pid, ppid: me.ppid },
        runs: { mine, others, total: runs.length },
        runs_dir: ctx.runSettings.runsDir,
      });
    },
  );
}
