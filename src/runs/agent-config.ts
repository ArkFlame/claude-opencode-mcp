import type { ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import {
  buildAgentDefinitions,
  expandAgentVariants,
  findAgentDefinition,
  isVariantAgentName,
  loadProjectAgentDefinitions,
  resolveAgentVariant,
  toOpenCodeAgentConfig,
} from "../opencode/agents.js";
import { getBuiltinDefinitions } from "../opencode/setup.js";
import type { ProfileCapabilities } from "../security/policy.js";

export interface CliAgentConfig {
  /** Agent name to pass to `opencode run --agent` (may be a permission variant). */
  agent: string;
  /** Value for OPENCODE_CONFIG_CONTENT carrying the bridge permission profile. */
  configContent: string;
  capabilities: ProfileCapabilities;
}

/**
 * Build the agent permission config for a CLI run. This mirrors the server path in
 * setup.ts prepareRun: per-call edit/shell overrides map onto variant agents with safe
 * profiles, so grants never bypass the security policy. Per-agent model pins are dropped
 * because the run model is chosen per call (see models.ts).
 */
export async function buildCliAgentConfig(input: {
  cwd: string;
  config: ResolvedConfig;
  agent: string;
  allowEdits?: boolean | undefined;
  allowBash?: boolean | undefined;
}): Promise<CliAgentConfig> {
  const { cwd, config } = input;
  const [builtin, project] = await Promise.all([
    getBuiltinDefinitions(),
    loadProjectAgentDefinitions(cwd),
  ]);
  const definitions = buildAgentDefinitions({ builtin, project, config });
  const definition = findAgentDefinition(definitions, input.agent.trim());
  if (!definition) {
    throw new BridgeError("AGENT_NOT_FOUND", `Unknown agent: ${input.agent}`, {
      details: {
        requested: input.agent,
        available: definitions
          .filter((entry) => !isVariantAgentName(entry.name))
          .map((entry) => entry.name),
      },
    });
  }
  const variant = resolveAgentVariant(definition, {
    ...(input.allowEdits !== undefined ? { allowEdits: input.allowEdits } : {}),
    ...(input.allowBash !== undefined ? { allowBash: input.allowBash } : {}),
  });
  const all = expandAgentVariants(definitions);
  if (!all.some((entry) => entry.name === variant.name)) {
    throw new BridgeError("AGENT_NOT_FOUND", `Agent variant is unavailable: ${variant.name}`);
  }
  const agentConfig = toOpenCodeAgentConfig(all, config);
  for (const entry of Object.values(agentConfig)) {
    delete (entry as { model?: string }).model;
  }
  return {
    agent: variant.name,
    configContent: JSON.stringify({ agent: agentConfig }),
    capabilities: variant.capabilities,
  };
}
