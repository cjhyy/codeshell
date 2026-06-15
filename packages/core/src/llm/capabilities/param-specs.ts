/**
 * paramSpecsFromCapability — bridge the capability layer (rules.ts, the vetted
 * single source of truth) into the unified catalog's ParamSpec[]. The catalog
 * reuses this knowledge instead of re-hand-writing reasoning/vision per model.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §4.
 */
import type { ProviderKindName } from "../provider-kinds.js";
import type { ParamSpec } from "../../model-catalog/types.js";
import { reasoningControlFor } from "./reasoning-control.js";

/** Where each provider kind's reasoning knob lands on the request body. */
function reasoningWireField(kind: ProviderKindName): string {
  switch (kind) {
    case "anthropic":
      return "thinking.budget_tokens";
    case "deepseek":
    case "zai":
      return "thinking.type";
    default:
      // OpenAI-compat (openai/google/openrouter/xai/mistral/groq) use reasoning_effort.
      return "reasoning_effort";
  }
}

/**
 * Project a (kind, model)'s capabilities into catalog ParamSpec[]. Currently
 * covers reasoning (the param that diverges most across models); image
 * size/quality live in their own catalog entries. Adaptive / none → no spec.
 */
export function paramSpecsFromCapability(
  kind: ProviderKindName,
  model: string,
): ParamSpec[] {
  const specs: ParamSpec[] = [];
  const control = reasoningControlFor(kind, model);
  const wire = { field: reasoningWireField(kind) };

  switch (control.kind) {
    case "effort":
      specs.push({
        name: "reasoning",
        label: "思考强度",
        control: "enum",
        options: control.options,
        default: control.default,
        doc: "Reasoning effort — how hard the model thinks before answering.",
        wire,
      });
      break;
    case "budget":
      specs.push({
        name: "reasoning",
        label: "思考预算",
        control: "number",
        min: control.min,
        default: control.default,
        doc: "Thinking token budget — higher = more deliberate reasoning.",
        wire,
      });
      break;
    case "toggle":
      specs.push({
        name: "reasoning",
        label: "思考",
        control: "toggle",
        default: control.default,
        doc: "Toggle the model's thinking mode on/off.",
        wire,
      });
      break;
    case "adaptive":
    case "none":
      break; // nothing to set
  }

  return specs;
}
