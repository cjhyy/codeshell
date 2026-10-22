import { capabilitiesForConfig } from "../llm/capabilities/index.js";
import type { ToolContext } from "./context.js";

/**
 * Whether the model that reads this context's tool results accepts images.
 *
 * The one vision gate for tools that load pixels into a result. A host that
 * declares `modelSupportsVision` (an external Agent Runtime, whose model has no
 * CodeShell `llmConfig`) is authoritative; otherwise the selected connection's
 * capability decides. With neither, this fails closed to "no vision", so a
 * misassembled context never reads image bytes into a non-vision transcript.
 */
export function toolContextSupportsVision(
  ctx?: Partial<Pick<ToolContext, "llmConfig" | "modelSupportsVision">>,
): boolean {
  if (typeof ctx?.modelSupportsVision === "boolean") return ctx.modelSupportsVision;
  return capabilitiesForConfig(ctx?.llmConfig).supportsVision;
}
