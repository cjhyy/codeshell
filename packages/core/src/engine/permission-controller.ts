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
    const rules = [...this.deps.presetRules()];
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
        config.settingsScope ?? "project",
        config.projectTrusted !== false,
      ).get();
      if (settings.permissions?.rules?.length) rules.unshift(...settings.permissions.rules);
    } catch {
      // Settings are optional; preset and mode defaults remain usable.
    }

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
