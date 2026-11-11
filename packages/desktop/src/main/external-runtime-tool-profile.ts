import type {
  BuiltinTool,
  ToolContext,
  ToolVisibilityInputs,
} from "@cjhyy/code-shell-core/extension";

/** Main-owned restriction for a capability's external runtime. Never accepted over IPC. */
export interface ExternalRuntimeToolProfile {
  id: string;
  catalog: readonly BuiltinTool[];
  instructions: string;
  context: Partial<ToolContext>;
  services(): ToolContext["runScopedServices"];
  visibility(): Pick<ToolVisibilityInputs, "behaviorProfile" | "profileMeta">;
  /** Opt into the existing reviewed Host controller contracts. */
  mimiHost?: boolean;
  readOnly?: boolean;
  disableMemory?: boolean;
  sessionKind?: string;
  maxToolCalls?: number;
}
