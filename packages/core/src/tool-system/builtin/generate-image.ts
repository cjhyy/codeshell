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

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, isAbsolute, resolve as resolvePath, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import {
  getImageProvider,
  DEFAULT_IMAGE_MODEL,
  type ImageProviderCreds,
  type InputImage,
} from "./image-providers.js";
import { getMergedCatalog, findCatalogEntry } from "../../model-catalog/index.js";
import { genInstancesFromConnections } from "../../model-catalog/gen-connections.js";

/** A configured imageGen/videoGen instance (subset used here). */
interface GenInstance {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  catalogId?: string;
  apiKeyRef?: string;
}

/**
 * Effective key for an instance: its own `apiKey`, or — when empty and
 * `apiKeyRef` is set — the key of the referenced instance in the same list
 * (reuse-key feature). Returns undefined when neither yields a key.
 */
export function effectiveApiKey(inst: GenInstance, list: GenInstance[]): string | undefined {
  if (inst.apiKey) return inst.apiKey;
  if (inst.apiKeyRef) {
    const ref = list.find((p) => p.id === inst.apiKeyRef);
    if (ref?.apiKey) return ref.apiKey;
  }
  return undefined;
}

/** Loose shapes read off raw settings for the unified store. */
interface GenInstanceSource { tag?: string; [k: string]: unknown }
interface CredentialSource { id?: string; [k: string]: unknown }

/**
 * Resolve a ResolvedImageProvider from a candidate list whose entries already
 * carry a direct `apiKey` (the unified store dereferences credentials upfront).
 * `prefer` selects by id (explicit → no silent fallback); else `def` then the
 * first usable. Shared by the unified-store path.
 */
function resolveFromGenList(
  list: GenInstance[],
  prefer: string | undefined,
  def: string | undefined,
): ResolvedImageProvider | null {
  const usable = (p: GenInstance): boolean => !!p.apiKey && getImageProvider(p.kind) !== null;
  const credsOf = (p: GenInstance): ImageProviderCreds => ({ baseUrl: p.baseUrl, apiKey: p.apiKey! });
  if (prefer) {
    const chosen = list.find((p) => p.id === prefer);
    if (chosen && usable(chosen)) return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
    return null;
  }
  const preferred = def ? list.find((p) => p.id === def) : undefined;
  const chosen = (preferred && usable(preferred) ? preferred : undefined) ?? list.find(usable);
  return chosen ? { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel } : null;
}

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_QUALITY = "auto";

/** Provider `kind`s that have an image adapter, in resolution preference. */
const IMAGE_PROVIDER_KINDS = ["openai", "google"] as const;

export const generateImageToolDef: ToolDefinition = {
  name: "GenerateImage",
  description:
    "Generate an image from a text prompt, or edit/re-imagine existing image(s) by passing " +
    "`referenceImages` (image-to-image). Saves a PNG into the workspace and returns its " +
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
          "Image provider to use. With imageGen configured, this is the instance `id` " +
          "(e.g. \"gemini\"); otherwise it's a provider kind (e.g. \"openai\"). " +
          "Defaults to the configured default / first available. Only specify to override.",
      },
      model: {
        type: "string",
        description:
          "Image model id (e.g. \"gpt-image-2\"). Defaults to the provider's default model. " +
          "Only specify to override.",
      },
      referenceImages: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional workspace image path(s) to use as visual references (image-to-image / " +
          "edit). When provided, the prompt edits/re-imagines these inputs instead of " +
          "generating from scratch — use it to keep a subject, style, or composition. " +
          "Paths are relative to the workspace (or absolute). PNG/JPEG/WebP, up to 16.",
      },
    },
    required: ["prompt"],
  },
};

interface ResolvedImageProvider {
  kind: string;
  creds: ImageProviderCreds;
  /** Instance default model (imageGen path) — used when the call omits `model`. */
  defaultModel?: string;
}

/**
 * Resolve an image provider from settings (TODO 7.1). Preference order:
 *
 *   1. `imageGen.providers[]` — the canonical, LLM-decoupled config. `prefer`
 *      selects an instance by its `id`; otherwise `imageGen.defaultProvider`,
 *      else the first entry. Each instance names its own adapter `kind`.
 *   2. Fallback (no `imageGen`): scan LLM `providers[]` for an image-capable
 *      `kind` — keeps existing configs working with no migration. Here
 *      `prefer` is treated as a kind.
 *
 * Returns null when nothing usable is configured (or the requested one lacks
 * a key / has no adapter).
 */
function resolveImageProvider(cwd: string, prefer?: string): ResolvedImageProvider | null {
  const settings = new SettingsManager(cwd, "full").get();

  // 0. Unified store (统一模型接入方案): modelConnections (tag=image) +
  // credentials. Takes precedence over the legacy imageGen.providers[] so the
  // unified connection page drives image generation. Falls through to the
  // legacy paths below when no image connection is configured.
  const conns = (settings as { modelConnections?: GenInstanceSource[] }).modelConnections;
  const creds = (settings as { credentials?: CredentialSource[] }).credentials;
  if (Array.isArray(conns) && conns.some((c) => c.tag === "image")) {
    const list = genInstancesFromConnections(
      conns as never[],
      (Array.isArray(creds) ? creds : []) as never[],
      getMergedCatalog(),
      "image",
    ) as unknown as GenInstance[];
    const def = (settings as { defaults?: { image?: string } }).defaults?.image;
    const resolved = resolveFromGenList(list, prefer, def);
    if (resolved) return resolved;
    if (prefer) return null; // explicit request not usable → don't silently fall back
  }

  // 1. Canonical imageGen config.
  const imageGen = (settings as { imageGen?: { defaultProvider?: string; providers?: GenInstance[] } }).imageGen;
  if (imageGen && Array.isArray(imageGen.providers) && imageGen.providers.length > 0) {
    const list = imageGen.providers;
    const usable = (p: GenInstance): boolean =>
      !!effectiveApiKey(p, list) && getImageProvider(p.kind) !== null;
    const credsOf = (p: GenInstance): ImageProviderCreds => ({ baseUrl: p.baseUrl, apiKey: effectiveApiKey(p, list)! });

    if (prefer) {
      // Explicit request — respect the user's intent. If that exact instance
      // isn't usable (no key / no adapter), DON'T silently use another one.
      const chosen = list.find((p) => p.id === prefer);
      if (chosen && usable(chosen)) {
        return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
      }
      return null;
    }

    // No explicit request: prefer defaultProvider, but if it isn't usable
    // (e.g. configured but no key yet) fall back to the first usable entry,
    // rather than erroring. (User-confirmed: default-with-no-key → fall back.)
    const preferred = imageGen.defaultProvider
      ? list.find((p) => p.id === imageGen.defaultProvider)
      : undefined;
    const chosen = (preferred && usable(preferred) ? preferred : undefined) ?? list.find(usable);
    if (chosen) {
      return { kind: chosen.kind, creds: credsOf(chosen), defaultModel: chosen.defaultModel };
    }
    return null;
  }

  // 2. Back-compat: resolve from legacy LLM providers[] by kind. The field was
  // dropped from the schema; un-migrated settings.json still carry it via the
  // schema's .passthrough(), so read it through an inline cast.
  const legacyProviders =
    (settings as { providers?: Array<{ kind: string; baseUrl: string; apiKey?: string }> }).providers ?? [];
  const kinds = prefer ? [prefer] : [...IMAGE_PROVIDER_KINDS];
  for (const kind of kinds) {
    if (!prefer && !IMAGE_PROVIDER_KINDS.includes(kind as (typeof IMAGE_PROVIDER_KINDS)[number])) continue;
    const provider = legacyProviders.find((p) => p.kind === kind);
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

/**
 * List the configured, usable image providers for a workspace (TODO 7.1) —
 * either `imageGen.providers[]` ids+kinds, or the back-compat LLM-provider
 * kinds. Used to build a dynamic tool description so the model sees which
 * backends are actually available. Returns [] on any read error.
 */
export function listConfiguredImageProviders(
  cwd: string = process.cwd(),
): Array<{ id?: string; kind: string; catalogId?: string }> {
  try {
    const settings = new SettingsManager(cwd, "full").get();
    const imageGen = (settings as { imageGen?: { providers?: GenInstance[] } }).imageGen;
    if (imageGen?.providers?.length) {
      const list = imageGen.providers;
      return list
        .filter((p) => !!effectiveApiKey(p, list) && getImageProvider(p.kind) !== null)
        .map((p) => ({ id: p.id, kind: p.kind, catalogId: p.catalogId }));
    }
    // Legacy LLM providers[] back-compat (field dropped from schema; read via
    // .passthrough() with an inline cast).
    const legacyProviders =
      (settings as { providers?: Array<{ kind: string; apiKey?: string }> }).providers ?? [];
    return legacyProviders
      .filter(
        (p) =>
          p.apiKey &&
          IMAGE_PROVIDER_KINDS.includes(p.kind as (typeof IMAGE_PROVIDER_KINDS)[number]),
      )
      .map((p) => ({ kind: p.kind }));
  } catch {
    return [];
  }
}

/**
 * Build the GenerateImage tool description for a workspace, appending the
 * configured providers so the model knows what's available and which `provider`
 * values are valid (TODO 7.1). Falls back to the static description when none
 * are configured (the guard hides the tool in that case anyway).
 */
export function generateImageToolDefFor(cwd: string): ToolDefinition {
  const providers = listConfiguredImageProviders(cwd);
  if (providers.length === 0) return generateImageToolDef;
  const names = providers.map((p) => p.id ?? p.kind).join(", ");
  // Per-instance params hints from the catalog (paramsDoc) — so the model knows
  // what each configured model accepts (different models differ).
  const catalog = getMergedCatalog();
  const paramLines = providers
    .map((p) => {
      const entry = findCatalogEntry(catalog, p.catalogId, p.kind);
      return entry?.paramsDoc ? `  - ${p.id ?? p.kind}: ${entry.paramsDoc}` : null;
    })
    .filter((x): x is string => x !== null);
  const paramsBlock = paramLines.length ? `\nParams per provider:\n${paramLines.join("\n")}` : "";
  return {
    ...generateImageToolDef,
    description:
      generateImageToolDef.description +
      ` Configured provider(s): ${names}. Pass \`provider\` to pick one.` +
      paramsBlock,
  };
}

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

/** Map a file extension to an image MIME type the image APIs accept. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * Read reference-image paths (workspace-relative or absolute) into decoded
 * {@link InputImage}s for image-to-image. Returns either the loaded images or a
 * user-facing error string (bad path, unreadable, unsupported type, too many).
 */
async function loadReferenceImages(
  paths: string[],
  cwd: string,
): Promise<{ ok: true; images: InputImage[] } | { ok: false; error: string }> {
  if (paths.length > 16) {
    return { ok: false, error: `too many reference images (${paths.length}); max is 16` };
  }
  const images: InputImage[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) {
      return { ok: false, error: "referenceImages entries must be non-empty path strings" };
    }
    const ext = extname(p).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT[ext];
    if (!mimeType) {
      return {
        ok: false,
        error: `unsupported reference image type "${ext || "(none)"}" for ${p}; use PNG/JPEG/WebP/GIF`,
      };
    }
    const abs = isAbsolute(p) ? p : resolvePath(cwd, p);
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch (err) {
      return { ok: false, error: `could not read reference image ${p}: ${(err as Error).message}` };
    }
    images.push({ filename: basename(abs), mimeType, bytes });
  }
  return { ok: true, images };
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

  // Optional reference images → image-to-image. Resolve + decode before the
  // provider call so a bad path fails fast with a clear message.
  let inputImages: InputImage[] | undefined;
  if (Array.isArray(args.referenceImages) && args.referenceImages.length > 0) {
    const loaded = await loadReferenceImages(args.referenceImages as string[], cwd);
    if (!loaded.ok) return `Error: ${loaded.error}`;
    inputImages = loaded.images;
  }
  const resolved = resolveImageProvider(cwd, preferKind);
  if (!resolved) {
    return preferKind
      ? `Error: no image provider "${preferKind}" is available (unknown id/kind, or it has no API key). Configure it in your code-shell settings, or omit \`provider\` to use the default.`
      : 'Error: no image provider available. Configure an image provider (including an apiKey) ' +
          "in your code-shell settings to use GenerateImage.";
  }

  const adapter = getImageProvider(resolved.kind);
  if (!adapter) {
    return `Error: image generation is not supported for provider kind "${resolved.kind}".`;
  }

  // Model precedence: call arg > instance defaultModel (imageGen) > kind default.
  const model = overrideModel ?? resolved.defaultModel ?? DEFAULT_IMAGE_MODEL[resolved.kind] ?? "gpt-image-2";

  const result = await adapter.generate({
    prompt,
    size,
    quality,
    model,
    creds: resolved.creds,
    inputImages,
    signal: ctx?.signal,
  });
  if (!result.ok) {
    return `Error generating image: ${result.error}`;
  }

  try {
    const dir = join(cwd, ".code-shell", "generated_images");
    await mkdir(dir, { recursive: true });
    // Timestamp keeps names sortable/recognizable; the random suffix prevents
    // collisions when multiple GenerateImage calls run concurrently in one turn
    // (Date.now() alone repeats within the same millisecond → writeFile would
    // silently overwrite and drop an image).
    const path = join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.png`);
    await writeFile(path, Buffer.from(result.b64, "base64"));
    // Name the provider/model actually used, so the user/agent knows which
    // image backend produced this (esp. when a default fell back to another).
    const mode = inputImages?.length
      ? ` from ${inputImages.length} reference image(s)`
      : "";
    return `Generated image with ${resolved.kind} (${model})${mode}, saved to ${path}`;
  } catch (err) {
    return `Error saving generated image: ${(err as Error).message}`;
  }
}
