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

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "auto";
const MODEL = "gpt-image-2";

export const generateImageToolDef: ToolDefinition = {
  name: "GenerateImage",
  description:
    "Generate an image from a text prompt using the OpenAI Images API (gpt-image-2). " +
    "Saves a PNG into the workspace and returns its absolute path; read or reference " +
    "that path on later turns. Requires an OpenAI provider (kind: \"openai\") configured " +
    "in settings. For raster assets (photos, illustrations, mockups, textures) — not for " +
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
    },
    required: ["prompt"],
  },
};

interface OpenAIProvider {
  baseUrl: string;
  apiKey: string;
}

/** Resolve the OpenAI provider's apiKey + baseUrl from settings, or null. */
function resolveOpenAIProvider(cwd: string): OpenAIProvider | null {
  const settings = new SettingsManager(cwd, "full").get();
  const provider = settings.providers.find((p) => p.kind === "openai");
  if (!provider || !provider.apiKey) return null;
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
}

/**
 * Tool-visibility guard: GenerateImage needs a kind:"openai" provider with a
 * key. resolveOpenAIProvider returns null when none is configured.
 */
export function isGenerateImageAvailable(cwd: string = process.cwd()): boolean {
  try {
    return resolveOpenAIProvider(cwd) !== null;
  } catch {
    return false;
  }
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

  const cwd = ctx?.cwd ?? process.cwd();
  const provider = resolveOpenAIProvider(cwd);
  if (!provider) {
    return (
      'Error: no OpenAI provider available. Configure a provider with kind: "openai" ' +
      "(including an apiKey) in your code-shell settings to use GenerateImage."
    );
  }

  // Trim a trailing slash so `${baseUrl}/images/generations` doesn't double up.
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, prompt, size, quality, n: 1 }),
      signal: ctx?.signal,
    });
  } catch (err) {
    return `Error generating image: ${(err as Error).message}`;
  }

  if (!resp.ok) {
    const body = (await resp.text().catch(() => "")).slice(0, 500);
    return `Error: image API returned ${resp.status}: ${body}`;
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    return `Error: could not parse image API response: ${(err as Error).message}`;
  }

  const b64 = (json as { data?: Array<{ b64_json?: string }> })?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    const preview = JSON.stringify(json).slice(0, 500);
    return `Error: no image in response: ${preview}`;
  }

  try {
    const dir = join(cwd, ".code-shell", "generated_images");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}.png`);
    await writeFile(path, Buffer.from(b64, "base64"));
    return `Generated image saved to ${path}`;
  } catch (err) {
    return `Error saving generated image: ${(err as Error).message}`;
  }
}
