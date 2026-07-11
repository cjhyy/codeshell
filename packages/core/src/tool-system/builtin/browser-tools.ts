/**
 * Browser automation tools — drive the in-app webview via the BrowserBridge
 * (CDP under the hood). Collapsed into THREE semantic tools (was 9 flat tools)
 * to keep the LLM's tool list lean:
 *
 *   browser_observe  — observe the page: snapshot (a11y elements) / read (text) /
 *                      extract (link+image+video URLs). [+ image/vision in P4]
 *   browser_act      — interact: click / type / select / press_key / hover /
 *                      scroll / wait / list_tabs / switch_tab (action-dispatched).
 *   browser_navigate — load a URL (high-frequency, kept standalone).
 *
 * Spec: docs/superpowers/specs/2026-06-18-browser-module-redesign-design.md §4.1.
 *
 * snapshot returns interactive elements as a compact ref-tagged list (a11y tree,
 * token-economical, no screenshots); act references elements by the ref the
 * latest snapshot assigned. All tools degrade with a clear error when no browser
 * is wired. isConcurrencySafe:false — a single webview is driven serially.
 *
 * Permission: browser_act is permissionDefault "allow"; the sensitive actions
 * (click/type/select) are escalated to "ask" by a preset PermissionRule keyed on
 * argsPattern { action }, so one tool can carry per-action gating (§4.6).
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import type { BuiltinToolReturn } from "./index.js";
import type { BrowserImageData } from "../browser-bridge.js";
import { renderElementList } from "../browser-bridge.js";
import { capabilitiesFor } from "../../llm/capabilities/index.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";
import type { ContentBlock } from "../../types.js";

const NO_BROWSER =
  "Error: browser automation is not available (no browser panel in this session). " +
  "It requires the desktop app with an open browser panel.";

function bridge(ctx?: ToolContext) {
  return ctx?.browser;
}

const STALE = (ref: string) => `Error: ref ${ref} is no longer valid (page changed). Re-run browser_observe.`;

// ════════════════════════════════════════════════════════════════════════════
// browser_observe — observe the page (snapshot / read / extract)
// ════════════════════════════════════════════════════════════════════════════

export const browserObserveToolDef: ToolDefinition = {
  name: "browser_observe",
  description:
    "Observe the current page in the browser panel. Modes:\n" +
    "- snapshot (default): URL/title + a compact list of interactive elements, each " +
    "tagged [ref=eN] for browser_act. ALWAYS snapshot before acting, and re-snapshot " +
    "after navigation/page changes (refs are only valid for the latest snapshot). " +
    "Passwords show as [sensitive] with no value.\n" +
    "- read: the page's main readable text (for summarizing/scraping an article/post; " +
    "long pages truncate — scroll + read again).\n" +
    "- extract: the real URLs on the page (hyperlink hrefs, image srcs, video srcs) " +
    "that snapshot omits — each image/video is tagged [ref=imgN/vidN] for image mode.\n" +
    "- image: SEE the actual pixels of page images (refs from extract, e.g. img3) — for " +
    "reading what a photo/product image/小红书 笔记配图 actually shows. Fetched in-page so " +
    "it works behind hotlink protection. A vidN ref grabs the video's current frame.\n" +
    "- vision: screenshot the rendered page (or one element via ref) — for layout/canvas/" +
    "charts the a11y tree can't convey. Use sparingly (images cost tokens; snapshot first).",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["snapshot", "read", "extract", "image", "vision"],
        description: "What to observe (default: snapshot)",
      },
      refs: {
        type: "array",
        items: { type: "string" },
        description: "image mode: image refs (imgN/vidN from extract) to see, one or more",
      },
      ref: { type: "string", description: "vision mode (optional): screenshot just this element's region" },
    },
  },
};

/** Vision gate: only show images to a vision-capable model. Mirrors view_image —
 *  no vision → never read pixels into context (your rule: 不支持就不给看). */
function modelSupportsVision(ctx?: ToolContext): boolean {
  if (!ctx?.llmConfig) return false;
  const kind = (ctx.llmConfig.providerKind ?? ctx.llmConfig.provider) as ProviderKindName;
  return capabilitiesFor(kind, ctx.llmConfig.model).supportsVision;
}

/** Wrap captured image data into a vision ContentBlock (or null if not usable). */
function toImageBlock(d: BrowserImageData): ContentBlock | null {
  if (!d.ok || !d.base64 || !d.mediaType) return null;
  return { type: "image", source: { type: "base64", media_type: d.mediaType, data: d.base64 } };
}

export async function browserObserveTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<BuiltinToolReturn> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const mode = (args.mode as string) || "snapshot";
  switch (mode) {
    case "snapshot": {
      const snap = await b.snapshot();
      const header = `URL: ${snap.url}${snap.title ? `\nTitle: ${snap.title}` : ""}`;
      const human = snap.needsHuman
        ? `\n\n⚠ ${snap.needsHuman} — please complete it in the browser panel, then continue.`
        : "";
      return `${header}\n\n${renderElementList(snap.elements)}${human}`;
    }
    case "read": {
      const c = await b.readContent();
      if (!c.ok) return `Error: ${c.detail ?? "could not read page content"}`;
      const head = `URL: ${c.url}${c.title ? `\nTitle: ${c.title}` : ""}${c.truncated ? "\n(content truncated)" : ""}`;
      return `${head}\n\n${c.text || "(no readable text)"}`;
    }
    case "extract": {
      const r = await b.extractLinks();
      if (!r.ok) return `Error: ${r.detail ?? "could not extract URLs"}`;
      const head = `URL: ${r.url}${r.title ? `\nTitle: ${r.title}` : ""}${r.truncated ? "\n(truncated — page had more; narrow it and re-extract)" : ""}`;
      const links =
        r.links.length > 0
          ? "Links:\n" + r.links.map((l) => `- ${l.text ? `${l.text} → ` : ""}${l.url}`).join("\n")
          : "Links: (none)";
      const images =
        r.images.length > 0
          ? "Images (use the ref with browser_observe(image) to SEE one):\n" +
            r.images.map((im) => `- [${im.ref ?? "?"}] ${im.alt ? `${im.alt} → ` : ""}${im.url}`).join("\n")
          : "Images: (none)";
      const videos =
        r.videos && r.videos.length > 0
          ? "Videos:\n" + r.videos.map((v) => `- ${v.url}`).join("\n")
          : "Videos: (none)";
      return `${head}\n\n${links}\n\n${images}\n\n${videos}`;
    }
    case "image": {
      // Vision gate: don't fetch pixels for a non-vision model (your rule).
      if (!modelSupportsVision(ctx)) {
        return "[图片未加载 —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再用 browser_observe(image)。]";
      }
      const refs = Array.isArray(args.refs) ? (args.refs as string[]) : [];
      if (refs.length === 0) return "Error: refs is required for image mode (image refs from browser_observe(extract), e.g. img3)";
      const datas = await b.fetchImages(refs);
      const blocks: ContentBlock[] = [];
      const notes: string[] = [];
      for (const d of datas) {
        const block = toImageBlock(d);
        if (block) {
          blocks.push(block);
          notes.push(`${d.ref ?? "?"}: loaded`);
        } else {
          notes.push(`${d.ref ?? "?"}: ${d.detail ?? "could not load"}`);
        }
      }
      if (blocks.length === 0) return `Error: no images loaded — ${notes.join("; ")}`;
      return { contentBlocks: blocks, result: `[loaded ${blocks.length} image(s): ${notes.join("; ")}]` };
    }
    case "vision": {
      if (!modelSupportsVision(ctx)) {
        return "[截图未加载 —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再用 browser_observe(vision)。]";
      }
      const ref = args.ref as string | undefined;
      const d = await b.screenshot(ref);
      const block = toImageBlock(d);
      if (!block) return `Error: ${d.detail ?? "screenshot failed"}`;
      return { contentBlocks: [block], result: `[screenshot loaded${ref ? ` of ${ref}` : ""}]` };
    }
    default:
      return `Error: unknown observe mode "${mode}" (use snapshot | read | extract | image | vision)`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// browser_act — interact with the page (action-dispatched)
// ════════════════════════════════════════════════════════════════════════════

export const browserActToolDef: ToolDefinition = {
  name: "browser_act",
  description:
    "Act on the page in the browser panel. Use refs (eN) from the latest " +
    "browser_observe(snapshot). Actions:\n" +
    "- click {ref}: click an element.\n" +
    "- type {ref, text}: type text into an input (focuses first).\n" +
    "- select {ref, value}: choose an option in a NATIVE <select> (value = option " +
    "value or visible text). Custom dropdowns: click to expand, then click the option.\n" +
    "- press_key {key, ref?}: press a key/combo (Enter, Tab, Escape, ArrowDown, " +
    "Control+a). Focuses ref first if given.\n" +
    "- hover {ref}: hover to reveal menus/tooltips.\n" +
    "- scroll {direction: up|down, amount?}: scroll the page, then re-observe.\n" +
    "- wait {timeout_ms?}: wait for the page to finish loading before observing.\n" +
    "- list_tabs: list open browser tabs (tabId, url, title, which is active).\n" +
    "- switch_tab {tabId}: make another tab the active one that actions drive.\n" +
    "Pass tabId on any action to target a specific tab (switches to it first). " +
    "Re-observe after navigation/page/tab changes (refs go stale per tab).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["click", "type", "select", "press_key", "hover", "scroll", "wait", "list_tabs", "switch_tab"],
        description: "The interaction to perform",
      },
      ref: { type: "string", description: "Element ref (eN) — click/type/select/hover/press_key" },
      text: { type: "string", description: "Text to type — type" },
      value: { type: "string", description: "Option value or visible text — select" },
      key: { type: "string", description: "Key name or combo (Enter/Tab/Control+a) — press_key" },
      direction: { type: "string", enum: ["up", "down"], description: "Scroll direction — scroll" },
      amount: { type: "number", description: "Pixels to scroll (default one viewport) — scroll" },
      timeout_ms: { type: "number", description: "Max wait in ms (default 10000) — wait" },
      tabId: { type: "string", description: "Target tab — required for switch_tab; optional on others (switches first)" },
    },
    required: ["action"],
  },
};

export async function browserActTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const action = args.action as string;
  const ref = args.ref as string | undefined;
  const tabId = args.tabId as string | undefined;

  // Optional tabId on a non-tab action → switch to that tab first, then act.
  if (tabId && action !== "switch_tab" && action !== "list_tabs") {
    const sw = await b.switchTab(tabId);
    if (!sw.ok) return `Error: could not switch to tab ${tabId} — ${sw.detail ?? "not found"}`;
  }

  switch (action) {
    case "list_tabs": {
      const tabs = await b.listTabs();
      if (tabs.length === 0) return "(no open browser tabs)";
      return (
        "Open tabs:\n" +
        tabs.map((t) => `- [${t.tabId}]${t.active ? " (active)" : ""} ${t.title || "(untitled)"} — ${t.url || "(blank)"}`).join("\n")
      );
    }
    case "switch_tab": {
      if (!tabId) return "Error: tabId is required for switch_tab (see list_tabs)";
      const r = await b.switchTab(tabId);
      return r.ok ? `Switched to tab ${tabId} — re-observe to see it` : `Error: ${r.detail ?? "switch failed"}`;
    }
    case "click": {
      if (!ref) return "Error: ref is required for click";
      const r = await b.click(ref);
      if (r.ok) return `Clicked ${ref}${r.detail ? ` — ${r.detail}` : ""}`;
      return r.staleRef ? STALE(ref) : `Error: ${r.detail ?? "click failed"}`;
    }
    case "type": {
      const text = args.text;
      if (!ref) return "Error: ref is required for type";
      if (typeof text !== "string") return "Error: text is required for type";
      const r = await b.type(ref, text);
      if (r.ok) return `Typed into ${ref}`;
      return r.staleRef ? STALE(ref) : `Error: ${r.detail ?? "type failed"}`;
    }
    case "select": {
      const value = args.value;
      if (!ref) return "Error: ref is required for select";
      if (typeof value !== "string") return "Error: value is required for select";
      const r = await b.selectOption(ref, value);
      if (r.ok) return `Selected${r.detail ? ` ${r.detail}` : ""} in ${ref}`;
      return r.staleRef ? STALE(ref) : `Error: ${r.detail ?? "select failed"}`;
    }
    case "press_key": {
      const key = (args.key as string) || "Enter";
      const r = await b.pressKey(key, ref);
      if (r.ok) return `Pressed ${key}`;
      return r.staleRef && ref ? STALE(ref) : `Error: ${r.detail ?? "press_key failed"}`;
    }
    case "hover": {
      if (!ref) return "Error: ref is required for hover";
      const r = await b.hover(ref);
      if (r.ok) return `Hovered ${ref}`;
      return r.staleRef ? STALE(ref) : `Error: ${r.detail ?? "hover failed"}`;
    }
    case "scroll": {
      const dir = args.direction as "up" | "down";
      if (dir !== "up" && dir !== "down") return "Error: direction must be 'up' or 'down'";
      const r = await b.scroll(dir, args.amount as number | undefined);
      return r.ok ? `Scrolled ${dir}` : `Error: ${r.detail ?? "scroll failed"}`;
    }
    case "wait": {
      const r = await b.waitForLoad(args.timeout_ms as number | undefined);
      return r.ok ? `Page ready${r.detail ? ` (${r.detail})` : ""}` : `Error: ${r.detail ?? "wait failed"}`;
    }
    default:
      return `Error: unknown action "${action}"`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// browser_navigate — load a URL (kept standalone: high-frequency, distinct)
// ════════════════════════════════════════════════════════════════════════════

export const browserNavigateToolDef: ToolDefinition = {
  name: "browser_navigate",
  description:
    "Navigate the browser panel to a URL (opens the panel automatically if none " +
    "is open). Then call browser_act(wait) + browser_observe to see the page.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL to open" } },
    required: ["url"],
  },
};

export async function browserNavigateTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const url = args.url as string;
  if (!url) return "Error: url is required";
  const r = await b.navigate(url);
  return r.ok ? `Navigated to ${url}` : `Error: ${r.detail ?? "navigation failed"}`;
}

/** True when the session has a browser bridge wired (used to gate visibility). */
export function isBrowserAutomationAvailable(ctx?: ToolContext): boolean {
  return bridge(ctx) !== undefined;
}
