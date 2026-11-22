import type { McpProbeResult } from "../main/mcp-probe-service.js";
import type { RendererConfigurationTarget } from "./renderer-configuration.js";

export interface ConfiguredMcpProbe {
  "mcp/probeConfigured": {
    input: {
      scope: "user" | "project";
      target: RendererConfigurationTarget | null;
      servers: { name: string; digest: string }[];
      force: boolean;
    };
    result: (
      | { route: "native" }
      | { route: "changed" }
      | { route: "host"; result: McpProbeResult }
    )[];
  };
}
