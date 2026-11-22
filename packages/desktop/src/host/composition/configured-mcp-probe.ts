import {
  mcpProbeConnection,
  mcpProbeDigest,
  probeMcpServer,
  type McpServerConfig,
} from "../../main/mcp-probe-service.js";
import { listMergedMcpServers } from "../../main/mcp-config-view.js";
import { rendererOptionalConfigurationCwd } from "../../main/renderer-configuration-helpers.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import { readSettings } from "../../main/settings-service.js";
import type { BusinessMethods } from "./business-calls.js";

type Config = McpServerConfig & { enabled?: boolean; pluginDisabled?: boolean };

export const configuredMcpProbe = {
  async "mcp/probeConfigured"({ scope, target, servers, force }, grant) {
    if (scope !== "user" && scope !== "project") throw new Error("Invalid MCP settings scope");
    if (scope === "project" && !target)
      throw new Error("Project scope requires a configuration target");
    const cwd = await rendererOptionalConfigurationCwd(target, resolveNoRepoCwd());
    const settings = await readSettings(scope, scope === "project" ? cwd : undefined);
    const snapshot = await listMergedMcpServers(
      settings?.mcpServers ?? {},
      settings?.disabledPlugins,
      target,
    );
    grant.assertCurrent();
    return Promise.all(
      servers.map(async ({ name, digest }) => {
        const config = Object.hasOwn(snapshot, name) ? (snapshot[name] as Config) : undefined;
        if (
          !config ||
          config.enabled === false ||
          config.pluginDisabled ||
          mcpProbeDigest(config) !== digest
        )
          return { route: "changed" } as const;
        // The native credential adapter owns OS-backed tokens and forwarded environment.
        if (
          config.credentialRef ||
          config.bearerTokenEnvVar ||
          config.envVars?.length ||
          Object.keys(config.envHeaders ?? {}).length
        )
          return { route: "native" } as const;
        return {
          route: "host",
          result: await probeMcpServer(mcpProbeConnection(config), {
            cwd,
            force,
            signal: grant.signal,
          }),
        } as const;
      }),
    );
  },
} satisfies Pick<BusinessMethods, "mcp/probeConfigured">;
