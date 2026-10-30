import type { getMergedCatalog } from "@cjhyy/code-shell-core/internal";

type Catalog = ReturnType<typeof getMergedCatalog>[number];
type Preset = NonNullable<Catalog["modelPresets"]>[number];
type Parameter = NonNullable<Preset["params"]>[number];

/** Deliberately limited to text-generation controls; credential, endpoint,
 * header, arbitrary text and wire-path declarations never reach the browser. */
const NAMES = new Set([
  "reasoning",
  "reasoning_effort",
  "thinking_type",
  "temperature",
  "top_p",
  "max_tokens",
]);
const FIELDS: Record<string, readonly string[]> = {
  reasoning: [
    "reasoning",
    "reasoning_effort",
    "reasoning.effort",
    "thinking.budget_tokens",
    "thinking.type",
  ],
  reasoning_effort: ["reasoning_effort"],
  thinking_type: ["thinking_type", "thinking.type"],
  temperature: ["temperature"],
  top_p: ["top_p"],
  max_tokens: ["max_tokens"],
};

export interface PublicModelParameter {
  name: string;
  label: string;
  control: "enum" | "number" | "toggle";
  options?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
}

export function modelParameters(preset?: Preset): PublicModelParameter[] {
  return (preset?.params ?? []).flatMap((spec: Parameter) => {
    if (
      !NAMES.has(spec.name) ||
      preset!.params!.filter((candidate) => candidate.name === spec.name).length !== 1 ||
      spec.control === "text" ||
      !FIELDS[spec.name]?.includes(spec.wire?.field ?? spec.name)
    )
      return [];
    const result: PublicModelParameter = {
      name: spec.name,
      label: spec.label ?? spec.name,
      control: spec.control,
      ...(spec.control === "enum" ? { options: [...(spec.options ?? [])] } : {}),
      ...(spec.control === "number" ? { min: spec.min ?? 0, max: spec.max ?? 1_000_000_000 } : {}),
    };
    if (validParameter(result, spec.default)) result.default = spec.default;
    return [result];
  });
}

function validParameter(
  spec: PublicModelParameter,
  value: unknown,
): value is string | number | boolean {
  if (spec.control === "enum")
    return typeof value === "string" && value.length <= 256 && !!spec.options?.includes(value);
  if (spec.control === "toggle") return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= (spec.min ?? 0) &&
    value <= (spec.max ?? 1_000_000_000)
  );
}

export function publicParameterValues(preset: Preset | undefined, values: unknown) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  return Object.fromEntries(
    modelParameters(preset).flatMap((spec) => {
      const value = (source as Record<string, unknown>)[spec.name];
      return validParameter(spec, value) ? [[spec.name, value]] : [];
    }),
  );
}

export function unavailableParameters(preset: Preset | undefined, values: unknown): string[] {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  return modelParameters(preset)
    .filter(
      (spec) =>
        Object.hasOwn(source, spec.name) &&
        !validParameter(spec, (source as Record<string, unknown>)[spec.name]),
    )
    .map((spec) => spec.name);
}

export function validateParameterPatch(preset: Preset | undefined, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const specs = modelParameters(preset);
  const patch = Object.entries(input);
  if (patch.length > NAMES.size) return undefined;
  if (
    patch.some(([key, value]) => {
      const spec = specs.find((candidate) => candidate.name === key);
      return !spec || (value !== null && !validParameter(spec, value));
    })
  )
    return undefined;
  return input as Record<string, string | number | boolean | null>;
}

export function publicModelPresets(entry: Catalog) {
  return (entry.modelPresets ?? []).map((preset) => ({
    value: preset.value,
    label: preset.label ?? preset.value,
    ...(preset.maxContextTokens !== undefined ? { maxContextTokens: preset.maxContextTokens } : {}),
    ...(preset.supportsVision !== undefined ? { supportsVision: preset.supportsVision } : {}),
    parameters: modelParameters(preset),
  }));
}
