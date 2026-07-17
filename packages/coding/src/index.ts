/**
 * Compatibility root for the coding capability package.
 *
 * New hosts should prefer /capability, /git, or /orchestration so importing
 * one concern does not evaluate every coding implementation.
 */
export * from "./index.capability.js";

export { briefTool } from "./tools/brief.js";
export { lspTool } from "./tools/lsp.js";
export { notebookEditTool } from "./tools/notebook-edit.js";
export * from "./tools/drive-agent.js";
export { applyPatchTool, applyPatchToolDef, applyPatch } from "./tools/apply-patch/index.js";
export { parsePatch } from "./tools/apply-patch/parser.js";
export { seekSequence } from "./tools/apply-patch/seek-sequence.js";
export { LSPClient } from "./lsp/client.js";
export { getLSPManager, initializeLSPManager, LSPServerManager } from "./lsp/manager.js";

export * from "./index.git.js";
export * from "./index.orchestration.js";
