import { createHash, randomUUID } from "node:crypto";
import { SettingsManager, type SettingsScope } from "../settings/manager.js";
import { resolveRunProfileState } from "../engine/run-setup.js";
import { composePermissionRules } from "../engine/permission-controller.js";
import { buildToolVisibility } from "../engine/run-tooling.js";
import { effectiveBuiltinLists, effectiveProjectOverrides } from "../capability-control/overlay.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { prepareConfiguredToolHooks } from "../hooks/configured-tool-hooks.js";
import { createOperationHookRegistry, type OperationHookProcesses } from "./operation-hooks.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import { boundToolResult } from "../tool-system/bound-tool-result.js";
import type { ToolContext } from "../tool-system/context.js";
import { asRecord } from "./http.js";

export type GithubReconcileRead = "get_repository" | "get_starred" | "get_issue";
export class OperationReadFailure extends Error {
  constructor(readonly result: "permission_denied" | "unavailable" | "hooks_unavailable") {
    super("Operation read unavailable");
  }
}

/**
 * A user-triggered Host read, independent of any Engine's transient run mode.
 * It composes current user rules, profile resolution and builtin controls. No
 * Engine, model, Session mutation, arbitrary action or approval bypass exists.
 */
export function createGithubOperationReader(options: {
  cwd: string;
  sessionId: string;
  sessionProfile?: string;
  /** Trusted Host settings authority, including current global deny rules. */
  settingsScope: SettingsScope;
  /** Intersection with the proven original credential scope. */
  credentialScope?: SettingsScope;
  assertAuthorized(): void;
  approveRead(action: GithubReconcileRead, target: string): Promise<boolean>;
  signal: AbortSignal;
  hooks?: HookRegistry;
  /** Trusted native Host custody only; never supplied by model/renderer input. */
  hookProcesses?: OperationHookProcesses;
}) {
  const policy = () => {
    const settings = new SettingsManager(options.cwd, options.settingsScope, true);
    settings.load(undefined, { persistMigrations: false });
    const profile = resolveRunProfileState({
      sessionWorkspaceProfile: options.sessionProfile,
      cwd: options.cwd,
      settings,
    });
    const builtinLists = effectiveBuiltinLists(
      settings.get().agent.enabledBuiltinTools ?? [],
      settings.get().agent.disabledBuiltinTools ?? [],
      effectiveProjectOverrides(settings, options.cwd, profile.sessionProfileOverrides)?.builtin,
    );
    const disabled = builtinLists.disabledBuiltinTools.includes("LinkAction");
    const disabledLists = computeEffectiveDisabledLists(
      settings,
      options.cwd,
      profile.sessionProfileOverrides,
    );
    const configuredHooks = prepareConfiguredToolHooks({
      settings,
      cwd: options.cwd,
      settingsScope: options.settingsScope,
      disabledPlugins: disabledLists.disabledPlugins,
      disabledPluginHooks: disabledLists.disabledPluginHooks,
      toolName: "LinkAction",
    });
    return {
      settings,
      configuredHooks,
      profileName: profile.workspaceProfile?.name ?? null,
      disabled,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            settings.get().permissions ?? null,
            profile.workspaceProfile ?? null,
            disabled,
            builtinLists,
            configuredHooks.revision,
          ]),
        )
        .digest("hex"),
    };
  };
  const original = policy();
  if (original.configuredHooks.descriptors.length && !options.hookProcesses)
    throw new OperationReadFailure("hooks_unavailable");
  let configured: ReturnType<typeof createOperationHookRegistry> | undefined;
  const assertAuthorized = () => {
    options.assertAuthorized();
    configured?.assertResourcesCurrent();
    if (options.signal.aborted) throw new Error("Operation read cancelled");
    if (policy().revision !== original.revision) throw new Error("Operation read policy changed");
  };
  if (original.configuredHooks.descriptors.length) {
    try {
      configured = createOperationHookRegistry({
        descriptors: original.configuredHooks.descriptors,
        processes: options.hookProcesses!,
        signal: options.signal,
        assertAuthorized,
      });
    } catch {
      throw new OperationReadFailure("hooks_unavailable");
    }
  }
  const registry = new ToolRegistry({ builtinTools: ["LinkAction"] });
  let pending: { action: GithubReconcileRead; target: string } | undefined;
  const permission = new PermissionClassifier(
    composePermissionRules({
      mode: "default",
      cwd: options.cwd,
      settingsScope: options.settingsScope,
      projectTrusted: true,
      settings: original.settings,
      presetRules: [{ tool: "LinkAction", decision: "allow" }],
    }),
    "default",
    {
      requestApproval: async (request) => {
        assertAuthorized();
        if (!pending || request.toolName !== "LinkAction") return { approved: false };
        const approved = await options.approveRead(pending.action, pending.target);
        assertAuthorized();
        return { approved };
      },
    },
  );
  // Configured executable policy owns its fresh registry; resident Engine or
  // injected test handlers cannot replace or erase its failure latch.
  const executor = new ToolExecutor(
    registry,
    permission,
    configured?.registry ?? options.hooks ?? new HookRegistry(),
  );
  executor.setSignal(options.signal);
  executor.setContext({
    cwd: options.cwd,
    sessionId: options.sessionId,
    settingsScope: options.credentialScope ?? options.settingsScope,
    planMode: false,
    permissionMode: "default",
    signal: options.signal,
    toolRegistry: registry,
    allowedToolNames: new Set(["LinkAction"]),
    disabledBuiltins: new Set(original.disabled ? ["LinkAction"] : []),
    workspaceProfileName: original.profileName ?? undefined,
    toolVisibility: buildToolVisibility({
      cwd: options.cwd,
      sessionId: options.sessionId,
      settingsScope: options.settingsScope,
      host: "desktop",
      hasGoal: false,
    }),
  } as unknown as ToolContext);
  return {
    profileName: original.profileName,
    assertAuthorized,
    close: async () => {
      await configured?.close();
    },
    async read(action: GithubReconcileRead, connectionId: string, params: Record<string, unknown>) {
      if (!["get_repository", "get_starred", "get_issue"].includes(action))
        throw new Error("Unsupported operation read");
      assertAuthorized();
      const args = JSON.parse(JSON.stringify({ provider: "github", action, connectionId, params }));
      const pinnedInput = JSON.stringify(args);
      configured?.bind(pinnedInput);
      pending = {
        action,
        target: `${params.owner}/${params.repo}${params.issue_number ? `#${params.issue_number}` : ""}`,
      };
      let execution;
      try {
        execution = await executor.executeSingle(
          {
            id: `operation-read-${randomUUID()}`,
            toolName: "LinkAction",
            args,
          },
          {
            pinnedInput,
            assertAuthorized: () => {
              assertAuthorized();
              configured?.assertBeforeProvider();
            },
          },
        );
      } finally {
        pending = undefined;
      }
      assertAuthorized();
      const hookFailure = configured?.result();
      if (hookFailure) throw new OperationReadFailure(hookFailure);
      const result = boundToolResult(execution);
      if (result.isError || typeof result.result !== "string")
        throw new OperationReadFailure("permission_denied");
      const output = asRecord(JSON.parse(result.result));
      if (
        output?.kind !== "action_result" ||
        output.provider !== "github" ||
        output.action !== action ||
        output.connectionId !== connectionId
      )
        throw new OperationReadFailure("unavailable");
      return asRecord(output.data);
    },
  };
}
