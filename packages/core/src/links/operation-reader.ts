import { createHash, randomUUID } from "node:crypto";
import { SettingsManager, type SettingsScope } from "../settings/manager.js";
import { resolveRunProfileState } from "../engine/run-setup.js";
import { composePermissionRules } from "../engine/permission-controller.js";
import { buildToolVisibility } from "../engine/run-tooling.js";
import { effectiveProjectOverrides } from "../capability-control/overlay.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { listPluginHooks, matcherAccepts } from "../plugins/loadPluginHooks.js";
import { shellHookMatches } from "../hooks/shell-runner.js";
import { ToolRegistry } from "../tool-system/registry.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { PermissionClassifier } from "../tool-system/permission.js";
import { HookRegistry } from "../hooks/registry.js";
import type { HookEventName } from "../hooks/events.js";
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
}) {
  const readHookEvents = new Set([
    "pre_tool_use",
    "on_permission_check",
    "on_tool_start",
    "on_tool_end",
    "post_tool_use",
  ]);
  const policy = () => {
    const settings = new SettingsManager(options.cwd, options.settingsScope, true);
    const profile = resolveRunProfileState({
      sessionWorkspaceProfile: options.sessionProfile,
      cwd: options.cwd,
      settings,
    });
    const disabled =
      effectiveProjectOverrides(settings, options.cwd, profile.sessionProfileOverrides)?.builtin
        ?.LinkAction === "off";
    const disabledLists = computeEffectiveDisabledLists(
      settings,
      options.cwd,
      profile.sessionProfileOverrides,
    );
    // This independent Host owns no resident Engine hook registry. Never run
    // shell/plugin code merely to reconstruct one, or silently skip configured
    // executable policy. Disabled and not-yet-approved plugin hooks do not run
    // in Engine either. The caller may still use manual uncertainty acceptance.
    const configuredHooks = [
      ...(settings.get().hooks ?? []).filter(
        (hook) =>
          !hook.disabled &&
          readHookEvents.has(hook.event) &&
          shellHookMatches(hook, {
            eventName: hook.event as HookEventName,
            data: { toolName: "LinkAction" },
          }),
      ),
      ...listPluginHooks(disabledLists.disabledPlugins).filter(
        (hook) =>
          !hook.disabled &&
          !disabledLists.disabledPluginHooks.includes(hook.key) &&
          ["approved", "legacy"].includes(hook.approval) &&
          readHookEvents.has(hook.event) &&
          matcherAccepts(hook.event, hook.matcher, {
            eventName: hook.event,
            data: { toolName: "LinkAction" },
          }),
      ),
    ];
    if (configuredHooks.length) throw new OperationReadFailure("hooks_unavailable");
    return {
      profileName: profile.workspaceProfile?.name ?? null,
      disabled,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            settings.get().permissions ?? null,
            profile.workspaceProfile ?? null,
            disabled,
          ]),
        )
        .digest("hex"),
    };
  };
  const original = policy();
  const assertAuthorized = () => {
    options.assertAuthorized();
    if (options.signal.aborted || policy().revision !== original.revision)
      throw new Error("Operation read policy changed");
  };
  const registry = new ToolRegistry({ builtinTools: ["LinkAction"] });
  let pending: { action: GithubReconcileRead; target: string } | undefined;
  const permission = new PermissionClassifier(
    composePermissionRules({
      mode: "default",
      cwd: options.cwd,
      settingsScope: options.settingsScope,
      projectTrusted: true,
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
  const executor = new ToolExecutor(registry, permission, options.hooks ?? new HookRegistry());
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
    async read(action: GithubReconcileRead, connectionId: string, params: Record<string, unknown>) {
      if (!["get_repository", "get_starred", "get_issue"].includes(action))
        throw new Error("Unsupported operation read");
      assertAuthorized();
      const args = JSON.parse(JSON.stringify({ provider: "github", action, connectionId, params }));
      const pinnedInput = JSON.stringify(args);
      pending = {
        action,
        target: `${params.owner}/${params.repo}${params.issue_number ? `#${params.issue_number}` : ""}`,
      };
      const execution = await executor.executeSingle(
        {
          id: `operation-read-${randomUUID()}`,
          toolName: "LinkAction",
          args,
        },
        { pinnedInput, assertAuthorized },
      );
      pending = undefined;
      assertAuthorized();
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
