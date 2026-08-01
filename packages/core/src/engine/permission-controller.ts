import type { PermissionRule } from "../types.js";
import { SettingsManager } from "../settings/manager.js";
import {
  AutoApprovalBackend,
  HeadlessApprovalBackend,
  InteractiveApprovalBackend,
  getInteractiveApprovalBackend,
  type ApprovalBackend,
  type ApprovalRouter,
  type PermissionClassifier,
} from "../tool-system/permission.js";
import type { EngineConfig } from "./types.js";

type PermissionMode = NonNullable<EngineConfig["permissionMode"]>;

export interface ComposePermissionRulesOptions {
  mode: PermissionMode;
  cwd: string;
  presetRules: readonly PermissionRule[];
  settingsScope?: EngineConfig["settingsScope"];
  projectTrusted?: boolean;
}

/**
 * Compose the permission rule list for a session: preset rules, the standing
 * memory-scope carve-outs, mode-derived rules, and finally the user's own
 * `settings.permissions.rules` at highest precedence.
 *
 * Extracted from {@link PermissionController.build} so that a non-Engine caller
 * — notably `SessionToolHost`, which exposes tools to an external Agent Runtime
 * — composes rules the SAME way instead of being handed the obligation and
 * silently getting it wrong. That mattered concretely: a user rule denying a
 * tool lives only in settings, so a path that skips this leaves the user's
 * explicit "no" unenforced for the external runtime while the Native Engine
 * honors it.
 */
export function composePermissionRules(options: ComposePermissionRulesOptions): PermissionRule[] {
  const { mode, cwd } = options;
  const rules = [...options.presetRules];
  rules.push({
    tool: "MemorySave",
    argsPattern: { scope: "^dream$" },
    decision: "allow",
    reason: "Dream scope is the LLM's auto-consolidation workspace",
  });
  rules.push({
    tool: "MemoryDelete",
    argsPattern: { scope: "^dream$" },
    decision: "allow",
    reason: "Dream scope is the LLM's auto-consolidation workspace",
  });
  if (mode === "acceptEdits" || mode === "bypassPermissions") {
    rules.push({ tool: "Write", decision: "allow" });
    rules.push({ tool: "Edit", decision: "allow" });
  }
  if (mode === "bypassPermissions") rules.push({ tool: "Bash", decision: "allow" });

  try {
    const settings = new SettingsManager(
      cwd,
      options.settingsScope ?? "project",
      options.projectTrusted !== false,
    ).get();
    // unshift: the user's own rules outrank every default.
    if (settings.permissions?.rules?.length) rules.unshift(...settings.permissions.rules);
  } catch {
    // Settings are optional; preset and mode defaults remain usable.
  }
  return rules;
}

export class PermissionController {
  private mode: PermissionMode;
  private inPlanMode: boolean;
  private pendingMode: PermissionMode | null = null;
  private pendingPlanMode: boolean | null = null;
  private activePermission: PermissionClassifier | undefined;
  private activeApprovalRouter: ApprovalRouter | undefined;
  private readonly interactiveBackends = new WeakMap<ApprovalRouter, InteractiveApprovalBackend>();

  constructor(
    private readonly deps: {
      config: () => EngineConfig;
      updateConfig: (next: EngineConfig) => void;
      presetRules: () => PermissionRule[];
      runInProgress: () => boolean;
    },
  ) {
    this.mode = deps.config().permissionMode ?? "acceptEdits";
    this.inPlanMode = this.mode === "plan";
  }

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  get planMode(): boolean {
    return this.inPlanMode;
  }

  attach(permission: PermissionClassifier, approvalRouter?: ApprovalRouter): void {
    this.activePermission = permission;
    this.activeApprovalRouter = approvalRouter;
  }

  build(
    mode: PermissionMode,
    cwd: string,
    approvalRouter?: ApprovalRouter,
  ): { rules: PermissionRule[]; backend: ApprovalBackend } {
    const config = this.deps.config();
    const rules = composePermissionRules({
      mode,
      cwd,
      presetRules: this.deps.presetRules(),
      settingsScope: config.settingsScope,
      projectTrusted: config.projectTrusted,
    });

    if (config.approvalBackend) {
      return {
        rules,
        backend:
          mode === "auto"
            ? new AutoApprovalBackend(config.approvalBackend)
            : config.approvalBackend,
      };
    }
    if (mode === "auto") return { rules, backend: new AutoApprovalBackend() };

    let interactive: InteractiveApprovalBackend;
    if (approvalRouter) {
      interactive =
        this.interactiveBackends.get(approvalRouter) ??
        new InteractiveApprovalBackend(approvalRouter);
      this.interactiveBackends.set(approvalRouter, interactive);
    } else {
      interactive = getInteractiveApprovalBackend();
    }
    const backend = interactive.hasPromptFn()
      ? interactive
      : new HeadlessApprovalBackend(mode === "bypassPermissions" ? "approve-all" : "deny-all");
    return { rules, backend };
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.deps.runInProgress()) {
      this.pendingMode = mode;
      this.pendingPlanMode = mode === "plan";
      return;
    }
    this.apply(mode, mode === "plan");
  }

  applyPending(): void {
    if (this.pendingMode === null) return;
    const mode = this.pendingMode;
    const planMode = this.pendingPlanMode ?? mode === "plan";
    this.pendingMode = null;
    this.pendingPlanMode = null;
    this.apply(mode, planMode);
  }

  getPermissionMode(): PermissionMode {
    return this.deps.config().permissionMode ?? "acceptEdits";
  }

  getPermissionRules(): PermissionRule[] {
    const config = this.deps.config();
    return this.build(
      this.getPermissionMode(),
      config.cwd ?? process.cwd(),
      this.activeApprovalRouter,
    ).rules;
  }

  setPlanMode(value: boolean): void {
    if (value) {
      this.setPermissionMode("plan");
    } else if ((this.pendingMode ?? this.mode) === "plan") {
      this.setPermissionMode("acceptEdits");
    }
  }

  private apply(mode: PermissionMode, planMode: boolean): void {
    const config = { ...this.deps.config(), permissionMode: mode };
    this.deps.updateConfig(config);
    this.mode = mode;
    this.inPlanMode = planMode;
    if (!this.activePermission) return;
    const { rules, backend } = this.build(
      mode,
      config.cwd ?? process.cwd(),
      this.activeApprovalRouter,
    );
    this.activePermission.reconfigure(mode, backend, rules);
  }
}
