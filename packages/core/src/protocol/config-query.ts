import type { Engine } from "../engine/engine.js";
import { redactLlmConfig } from "./redact.js";

/** Data of the `config` query response for one resolved engine. */
export function configQueryData(engine: Engine) {
  const config = engine.getConfig();
  return {
    permissionMode: config.permissionMode ?? "default",
    planMode: engine.planMode ?? false,
    preset: config.preset,
    model: config.llm.model,
    cwd: config.cwd,
    // Session data root this engine writes (incl. file history), so a
    // client-side /undo reads the same store. Absent = default root.
    sessionStorageDir: config.sessionStorageDir,
    maxContextTokens: config.maxContextTokens,
    // apiKey is redacted at this boundary: clients only get
    // hasApiKey + optional apiKeyPreview. See protocol/redact.ts.
    llm: redactLlmConfig(config.llm),
    // Resolved feature flags (defaults merged with settings overlay)
    // so the /features command can list current state.
    featureFlags: engine.getFeatureFlags(),
    // Effective permission rules so /permissions can list them (TODO 5.1).
    permissionRules: engine.getPermissionRules(),
  };
}
