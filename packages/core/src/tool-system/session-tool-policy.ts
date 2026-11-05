import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { effectiveBuiltinLists, effectiveProjectOverrides } from "../capability-control/overlay.js";
import { SettingsManager, type SettingsScope } from "../settings/manager.js";
import type { CapabilityOverrides } from "../settings/schema.js";
import type { MCPServerConfig } from "../types.js";

export interface SessionToolPolicyOptions {
  cwd: string;
  settingsScope?: SettingsScope;
  projectTrusted: boolean;
  /** A trusted session pin; an empty object intentionally suppresses the project profile. */
  getProfileOverrides?: () => CapabilityOverrides;
  /** Already-authorized Host connections; disk configuration can only narrow them. */
  mcpServers?: Readonly<Record<string, MCPServerConfig>>;
}

export class SessionToolPolicyError extends Error {
  constructor(cause: unknown) {
    super(
      "Session capability settings, Profile, or Host context are unavailable; repair them before retrying.",
      {
        cause,
      },
    );
    this.name = "SessionToolPolicyError";
  }
}

/**
 * Resolve a fresh capability policy without rebuilding a registry or widening
 * the external exposure policy. Native consumers use the same overlay folds.
 */
export function readSessionToolPolicy(options: SessionToolPolicyOptions) {
  try {
    const scope = options.settingsScope ?? "project";
    const settings = new SettingsManager(options.cwd, scope, options.projectTrusted);
    // The overlay helpers retain their historical best-effort read contract.
    // Reject malformed or unsafe selected layers before entering those folds:
    // treating an unreadable off-switch as an empty layer would enable tools.
    if (scope === "full") settings.getRawForScope("user", options.cwd, { strict: true });
    if (scope !== "isolated") {
      settings.getRawForScope("project", options.cwd, { strict: true });
      settings.getRawForScope("local", options.cwd, { strict: true });
    }
    settings.load(undefined, { persistMigrations: false });
    const profile = options.getProfileOverrides?.();
    const cwd = scope === "isolated" ? undefined : options.cwd;
    const overrides = effectiveProjectOverrides(settings, cwd, profile);
    const merged = settings.get();
    const agent = merged.agent;
    const builtin = effectiveBuiltinLists(
      agent?.enabledBuiltinTools ?? [],
      agent?.disabledBuiltinTools ?? [],
      overrides?.builtin,
    );
    return {
      disabledBuiltins: new Set(builtin.disabledBuiltinTools),
      ...computeEffectiveDisabledLists(settings, cwd, profile),
      featureFlags: merged.featureFlags,
      mcpServers: Object.fromEntries(
        Object.entries(options.mcpServers ?? {}).map(([name, baseline]) => {
          const configured = merged.mcpServers?.[name];
          const override = overrides?.mcp?.[name];
          const allowedTools =
            baseline.allowedTools === undefined
              ? configured?.allowedTools
              : configured?.allowedTools === undefined
                ? baseline.allowedTools
                : baseline.allowedTools.filter((tool) => configured.allowedTools!.includes(tool));
          return [
            name,
            {
              ...baseline,
              enabled:
                baseline.enabled !== false &&
                override !== "off" &&
                (override === "on" || configured?.enabled !== false),
              ...(allowedTools === undefined ? {} : { allowedTools: [...allowedTools] }),
              ...(baseline.disabledTools === undefined && configured?.disabledTools === undefined
                ? {}
                : {
                    disabledTools: [
                      ...new Set([
                        ...(baseline.disabledTools ?? []),
                        ...(configured?.disabledTools ?? []),
                      ]),
                    ],
                  }),
            },
          ];
        }),
      ),
    };
  } catch (error) {
    throw new SessionToolPolicyError(error);
  }
}
