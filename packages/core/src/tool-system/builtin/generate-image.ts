/**
 * Built-in GenerateImage tool — text-to-image via the OpenAI Images API
 * (`gpt-image-2`).
 *
 * Credentials come from config, not env: the tool finds the `kind: "openai"`
 * entry in `settings.providers[]` and uses its `apiKey` + `baseUrl`. No
 * `OPENAI_API_KEY` required, no new config — an existing OpenAI provider is
 * reused as-is.
 *
 * The generated PNG is decoded from the API's base64 payload and written to
 * `<cwd>/.code-shell/generated_images/<timestamp>.png`; the tool returns the
 * absolute path so the model can Read or reference it on later turns. This
 * mirrors codex's imagegen CLI fallback (`scripts/image_gen.py`): call API →
 * take b64_json → decode → write → report path.
 *
 * Scope is deliberately narrow (text-to-image only). Edit/mask/transparent/
 * batch are out of scope — see the design doc.
 *
 * Uses the native `fetch` (codeshell does not depend on the `openai` SDK).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import { getImageProvider, DEFAULT_IMAGE_MODEL, type ImageProviderCreds } from "./image-providers.js";

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "auto";

/** Provider `kind`s that have an image adapter, in resolution preference. */
const IMAGE_PROVIDER_KINDS = ["openai"] as const;

export const generateImageToolDef: ToolDefinition = {
  name: "GenerateImage",
  description:
    "Generate an image from a text prompt. Saves a PNG into the workspace and returns its " +
    "absolute path; read or reference that path on later turns. Defaults to the OpenAI Images " +
    "API (gpt-image-2); requires a matching provider configured in settings. " +
    "For raster assets (photos, illustrations, mockups, textures) — not for " +
    "SVG/vector icons or anything better built directly in code.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Description of the image to generate",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1536x1024", "1024x1536", "auto"],
        description: "Image dimensions (default 1024x1024)",
      },
      quality: {
        type: "string",
        enum: ["low", "medium", "high", "auto"],
        description: "Render quality (default auto). Use low for drafts, high for final assets.",
      },
      provider: {
        type: "string",
        description:
          "Image provider kind to use (e.g. \"openai\"). Defaults to the first configured " +
          "image-capable provider. Only specify to override.",
      },
      model: {
        type: "string",
        description:
          "Image model id (e.g. \"gpt-image-2\"). Defaults to the provider's default model. " +
          "Only specify to override.",
      },
    },
    required: ["prompt"],
  },
};

interface ResolvedImageProvider {
  kind: string;
  creds: ImageProviderCreds;
}

/**
 * Resolve an image-capable provider's creds from settings. With `preferKind`
 * set (the tool's `provider` arg), require exactly that kind; otherwise pick
 * the first configured provider whose kind has an adapter. Returns null when
 * none is configured (or the requested one lacks a key).
 */
function resolveImageProvider(cwd: string, preferKind?: string): ResolvedImageProvider | null {
  const settings = new SettingsManager(cwd, "full").get();
  const kinds = preferKind ? [preferKind] : [...IMAGE_PROVIDER_KINDS];
  for (const kind of kinds) {
    if (!preferKind && !IMAGE_PROVIDER_KINDS.includes(kind as (typeof IMAGE_PROVIDER_KINDS)[number])) continue;
    const provider = settings.providers.find((p) => p.kind === kind);
    if (provider && provider.apiKey) {
      return { kind, creds: { baseUrl: provider.baseUrl, apiKey: provider.apiKey } };
    }
  }
  return null;
}

/**
 * Tool-visibility guard: GenerateImage needs a kind:"openai" provider with a
 * key. resolveOpenAIProvider returns null when none is configured.
 *
 * Cached per-cwd with a short TTL: the guard runs on EVERY message's toolDefs
 * assembly (engine.ts), and resolveOpenAIProvider reads + parses settings from
 * disk each call. The 1s TTL collapses the back-to-back reads (same message,
 * rapid turns) while still picking up a newly-configured key well within the
 * gap before the user's next message. The execution path
 * (resolveOpenAIProvider) is intentionally NOT cached — only this boolean.
 */
const availCache = new Map<string, { at: number; value: boolean }>();
const AVAIL_TTL_MS = 1000;

export function isGenerateImageAvailable(
  cwd: string = process.cwd(),
  nowMs: number = Date.now(),
): boolean {
  const hit = availCache.get(cwd);
  if (hit && nowMs - hit.at < AVAIL_TTL_MS) return hit.value;
  let value = false;
  try {
    value = resolveImageProvider(cwd) !== null;
  } catch {
    value = false;
  }
  availCache.set(cwd, { at: nowMs, value });
  return value;
}

export async function generateImageTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const prompt = args.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return "Error: prompt is required";
  }
  const size = typeof args.size === "string" ? args.size : DEFAULT_SIZE;
  const quality = typeof args.quality === "string" ? args.quality : DEFAULT_QUALITY;
  const preferKind = typeof args.provider === "string" && args.provider ? args.provider : undefined;
  const overrideModel = typeof args.model === "string" && args.model ? args.model : undefined;

  const cwd = ctx?.cwd ?? process.cwd();
  const resolved = resolveImageProvider(cwd, preferKind);
  if (!resolved) {
    return preferKind
      ? `Error: no image provider of kind "${preferKind}" available. Configure a provider with that kind (including an apiKey) in your code-shell settings.`
      : 'Error: no image provider available. Configure a provider with kind: "openai" ' +
          "(including an apiKey) in your code-shell settings to use GenerateImage.";
  }

  const adapter = getImageProvider(resolved.kind);
  if (!adapter) {
    return `Error: image generation is not supported for provider kind "${resolved.kind}".`;
  }

  const model = overrideModel ?? DEFAULT_IMAGE_MODEL[resolved.kind] ?? "gpt-image-2";

  const result = await adapter.generate({
    prompt,
    size,
    quality,
    model,
    creds: resolved.creds,
    signal: ctx?.signal,
  });
  if (!result.ok) {
    return `Error generating image: ${result.error}`;
  }

  try {
    const dir = join(cwd, ".code-shell", "generated_images");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}.png`);
    await writeFile(path, Buffer.from(result.b64, "base64"));
    return `Generated image saved to ${path}`;
  } catch (err) {
    return `Error saving generated image: ${(err as Error).message}`;
  }
}
