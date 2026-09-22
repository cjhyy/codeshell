/**
 * Browser automation tools — drive a host-owned Browser Runtime through the
 * BrowserBridge compatibility port. The default runtime owns a background tab
 * in the in-app profile; user-opened tabs require an explicit claim. Collapsed
 * into THREE semantic tools
 * (was 9 flat tools)
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
 * runtime is wired. isConcurrencySafe:false — one runtime tab is driven serially.
 *
 * Permission: browser_act is permissionDefault "allow"; the sensitive actions
 * (click/type/select) are escalated to "ask" by a preset PermissionRule keyed on
 * argsPattern { action }, so one tool can carry per-action gating (§4.6).
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import type { BuiltinToolReturn } from "./index.js";
import type {
  BrowserImageData,
  BrowserSnapshot,
  BrowserResultCode,
  BrowserWaitCondition,
} from "../browser-bridge.js";
import { renderElementList } from "../browser-bridge.js";
import { capabilitiesFor } from "../../llm/capabilities/index.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";
import type { ContentBlock } from "../../types.js";

const NO_BROWSER = "Error: browser automation runtime is not available in this host session.";

function bridge(ctx?: ToolContext) {
  return ctx?.browser;
}

const STALE = (ref: string) =>
  `Error: ref ${ref} is no longer valid (page changed). Re-run browser_observe.`;

/**
 * One line naming the login identity this page is being viewed as.
 *
 * A profile id alone does not convey risk, so the user's own browser gets an
 * explicit warning: actions there hit their real accounts, not a sandbox.
 * Renders nothing when the host reports no identity, so hosts that only drive
 * their own sandbox are unaffected.
 */
function renderIdentity(identity: BrowserSnapshot["identity"]): string {
  if (!identity) return "";
  const source = identity.sourceKind ? ` (${identity.sourceKind})` : "";
  const warning = identity.isUserBrowser
    ? " — this is the user's own browser: actions here affect their real accounts"
    : "";
  return `\nIdentity: ${identity.profileId}${source}${warning}`;
}

// ════════════════════════════════════════════════════════════════════════════
// browser_observe — observe the page (snapshot / read / extract)
// ════════════════════════════════════════════════════════════════════════════

export const browserObserveToolDef: ToolDefinition = {
  name: "browser_observe",
  description:
    "Observe the task-owned page in the CodeShell Browser Runtime. It shares the " +
    "in-app browser profile but never controls a user-opened tab without an " +
    "explicit claim. Modes:\n" +
    "- snapshot (default): URL/title + a compact list of interactive elements, each " +
    "tagged [ref=eN] for browser_act. ALWAYS snapshot before acting, and re-snapshot " +
    "after navigation/page changes (refs are only valid for the latest snapshot). " +
    "Passwords show as [sensitive] with no value.\n" +
    "- read: a cursor-paged chunk of the page's normalized readable text. Continue " +
    "with the returned nextCursor until complete. This covers DOM text only; canvas tables, virtualized panels and lazy/infinite content need vision and scrolling.\n" +
    "- extract: the real URLs on the page (hyperlink hrefs, image srcs, video srcs) " +
    "that snapshot omits — each image/video is tagged [ref=imgN/vidN] for image mode.\n" +
    "- image: SEE the actual pixels of page images (refs from extract, e.g. img3) — for " +
    "reading what a photo/product image/小红书 笔记配图 actually shows. Fetched in-page so " +
    "it works behind hotlink protection. A vidN ref grabs the video's current frame.\n" +
    "- vision: screenshot the rendered page (or one element via ref) — for layout/canvas/" +
    "charts the a11y tree can't convey. Use sparingly (images cost tokens; snapshot first). " +
    "A structured observation timeout attempts one viewport screenshot for vision-capable models " +
    "unless fallback=none. This does not retry actions, reload the page, or claim a complete read.",
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
      ref: {
        type: "string",
        description: "vision mode (optional): screenshot just this element's region",
      },
      cursor: {
        type: "string",
        description: "read mode: opaque nextCursor returned by the previous read chunk",
      },
      max_chars: {
        type: "number",
        description: "read mode: requested chunk size (clamped by the runtime)",
      },
      fallback: {
        type: "string",
        enum: ["vision", "none"],
        description:
          "On a structured read timeout, try one screenshot (default vision; vision models only)",
      },
    },
  },
};

function renderObservationWarnings(warnings?: string[]): string {
  return warnings?.length
    ? `\nObservation incomplete: ${warnings.join("; ")}. Do not infer missing content; use vision or retry after the page settles.`
    : "";
}

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

function browserFailure(
  result: { code?: BrowserResultCode; detail?: string },
  defaultDetail: string,
  mutating = false,
): string {
  const error = `Error: ${result.detail ?? defaultDetail}`;
  switch (result.code) {
    case "TIMEOUT":
      return `${error}\n[TIMEOUT] ${
        mutating
          ? "Action outcome is unknown. Observe the current page and verify whether it already succeeded before retrying. Never blindly repeat a click, submission or message."
          : "The requested observation/condition did not finish in time. Inspect the current page or wait for a specific target; do not repeatedly issue the same failing call."
      }`;
    case "TARGET_CLOSED":
      return `${error}\n[TARGET_CLOSED] List task-owned tabs and choose a valid target. Reopen the intended URL only if needed; all previous refs are expired.`;
    case "NAVIGATION":
    case "STALE_SNAPSHOT":
      return `${error}\n[${result.code}] Take a fresh snapshot before acting; old refs are invalid.`;
    default:
      return error;
  }
}

/** A single read-only fallback, never a replay of the preceding interaction. */
async function observationFailure(
  result: { code?: BrowserResultCode; detail?: string },
  defaultDetail: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<BuiltinToolReturn> {
  const failure = browserFailure(result, defaultDetail);
  if (
    result.code !== "TIMEOUT" ||
    args.fallback === "none" ||
    !modelSupportsVision(ctx) ||
    ctx?.signal?.aborted
  )
    return failure;
  const b = bridge(ctx);
  if (!b) return failure;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const image = await Promise.race([
      b.screenshot(),
      new Promise<BrowserImageData>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, detail: "screenshot fallback timed out" }),
          5_000,
        );
        cancel = () => resolve({ ok: false, detail: "observation cancelled" });
        ctx?.signal?.addEventListener("abort", cancel, { once: true });
        if (ctx?.signal?.aborted) cancel();
      }),
    ]);
    if (ctx?.signal?.aborted) return failure;
    const block = toImageBlock(image);
    return block
      ? {
          result: `${failure}\nFallback: current viewport screenshot only. The structured read is incomplete; no new element refs or verified URLs were obtained. No action was retried and the page was not reloaded.`,
          contentBlocks: [block],
        }
      : `${failure}\nScreenshot fallback unavailable: ${image.detail ?? "no image returned"}. The page was not reloaded.`;
  } catch {
    return `${failure}\nScreenshot fallback unavailable. The page was not reloaded.`;
  } finally {
    clearTimeout(timer);
    if (cancel) ctx?.signal?.removeEventListener("abort", cancel);
  }
}

export async function browserObserveTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<BuiltinToolReturn> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const mode = (args.mode as string) || "snapshot";
  switch (mode) {
    case "snapshot": {
      const snap = await b.snapshot();
      if (snap.detail) return observationFailure(snap, "snapshot failed", args, ctx);
      const header = `URL: ${snap.url}${snap.title ? `\nTitle: ${snap.title}` : ""}${renderIdentity(snap.identity)}`;
      const human = snap.needsHuman
        ? `\n\n⚠ ${snap.needsHuman} — please complete it in the browser window, then continue.`
        : "";
      return `${header}${renderObservationWarnings(snap.warnings)}\n\n${renderElementList(snap.elements)}${human}`;
    }
    case "read": {
      const c = await b.readContent({
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
        maxChars: typeof args.max_chars === "number" ? args.max_chars : undefined,
      });
      if (!c.ok) return observationFailure(c, "could not read page content", args, ctx);
      const progress =
        c.done && c.warnings?.length
          ? "\nRead: partial (some frames unavailable)"
          : c.done
            ? "\nRead: complete"
            : c.nextCursor
              ? `\nRead: more available\nnextCursor: ${c.nextCursor}`
              : c.truncated
                ? "\nRead: truncated"
                : "";
      const scroll = c.scroll
        ? c.scroll.positionKnown === false
          ? `\nScroll: ${c.scroll.target ?? "rendered region"} position unknown; use vision and scroll to inspect its content`
          : `\nScroll: ${Math.round(c.scroll.y)}/${Math.round(c.scroll.maxY)}${c.scroll.atEnd ? " (end)" : ""}${c.scroll.target === "element" ? " (content panel)" : ""}`
        : "";
      const head = `URL: ${c.url}${c.title ? `\nTitle: ${c.title}` : ""}${progress}${scroll}`;
      return `${head}${renderObservationWarnings(c.warnings)}\n\n${c.text || "(no readable text)"}`;
    }
    case "extract": {
      const r = await b.extractLinks();
      if (!r.ok) return observationFailure(r, "could not extract URLs", args, ctx);
      const head = `URL: ${r.url}${r.title ? `\nTitle: ${r.title}` : ""}${r.truncated ? "\n(truncated — page had more; narrow it and re-extract)" : ""}`;
      const links =
        r.links.length > 0
          ? "Links:\n" + r.links.map((l) => `- ${l.text ? `${l.text} → ` : ""}${l.url}`).join("\n")
          : "Links: (none)";
      const images =
        r.images.length > 0
          ? "Images (use the ref with browser_observe(image) to SEE one):\n" +
            r.images
              .map((im) => `- [${im.ref ?? "?"}] ${im.alt ? `${im.alt} → ` : ""}${im.url}`)
              .join("\n")
          : "Images: (none)";
      const videos =
        r.videos && r.videos.length > 0
          ? "Videos:\n" + r.videos.map((v) => `- ${v.url}`).join("\n")
          : "Videos: (none)";
      return `${head}${renderObservationWarnings(r.warnings)}\n\n${links}\n\n${images}\n\n${videos}`;
    }
    case "image": {
      // Vision gate: don't fetch pixels for a non-vision model (your rule).
      if (!modelSupportsVision(ctx)) {
        return "[图片未加载 —— 当前模型不支持视觉输入,已跳过。切换到 vision 模型后再用 browser_observe(image)。]";
      }
      const refs = Array.isArray(args.refs) ? (args.refs as string[]) : [];
      if (refs.length === 0)
        return "Error: refs is required for image mode (image refs from browser_observe(extract), e.g. img3)";
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
      return {
        contentBlocks: blocks,
        result: `[loaded ${blocks.length} image(s): ${notes.join("; ")}]`,
      };
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
    "Act on the task-owned tab in the CodeShell Browser Runtime. By default it " +
    "shares the in-app browser profile but never controls a user-opened tab " +
    "without an explicit claim. Use refs (eN) from the latest " +
    "browser_observe(snapshot). Actions:\n" +
    "- click {ref}: click an element.\n" +
    "- type {ref, text}: type text into an input (focuses first).\n" +
    "- select {ref, value}: choose an option in a NATIVE <select> (value = option " +
    "value or visible text). Custom dropdowns: click to expand, then click the option.\n" +
    "- press_key {key, ref?}: press a key/combo (Enter, Tab, Escape, ArrowDown, " +
    "ControlOrMeta+a; resolves to Command on macOS, Control elsewhere). Focuses ref first if given.\n" +
    "- hover {ref}: hover to reveal menus/tooltips.\n" +
    "- scroll {direction: up|down, amount?}: scroll the main visible content region (including nested panels/canvas), then re-observe.\n" +
    "- wait {timeout_ms?, selector?, text?, state?}: wait for DOM readiness, or a visible/hidden " +
    "main-document target. text is a visible substring; selector scopes it to observed CSS elements. " +
    "Prefer a specific target for slow/dynamic pages. This does not inspect iframe/canvas text.\n" +
    "- request_takeover: reveal the exact task-owned Browser Runtime page so the " +
    "user can see it and complete login, 2FA, CAPTCHA, or another required manual step. " +
    "Use only when the user asks to see the page or human interaction is required.\n" +
    "- resume_control: resume after the user confirms their manual step is finished. " +
    "Then take a new snapshot; all previous element refs have expired.\n" +
    "- list_tabs: list open browser tabs (tabId, url, title, which is active).\n" +
    "- switch_tab {tabId}: make another tab the active one that actions drive.\n" +
    "Pass tabId on any action to target a specific tab (switches to it first). " +
    "Re-observe after navigation/page/tab changes (refs go stale per tab). " +
    "After an action timeout, verify the current state before retrying: it may already have succeeded. " +
    "Do not blindly repeat clicks, submissions, messages, or reloads.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "click",
          "type",
          "select",
          "press_key",
          "hover",
          "scroll",
          "wait",
          "request_takeover",
          "resume_control",
          "list_tabs",
          "switch_tab",
        ],
        description: "The interaction to perform",
      },
      ref: { type: "string", description: "Element ref (eN) — click/type/select/hover/press_key" },
      text: {
        type: "string",
        description: "Text to type — type; visible text substring to await — wait",
      },
      selector: {
        type: "string",
        description: "wait: CSS selector grounded in an observed main-document element",
      },
      state: {
        type: "string",
        enum: ["visible", "hidden"],
        description: "wait: target state (default visible); hidden means no visible match",
      },
      value: { type: "string", description: "Option value or visible text — select" },
      key: {
        type: "string",
        description:
          "Key or combo (Enter/Tab/ControlOrMeta+a). ControlOrMeta uses the browser host's platform; literal Control and Meta stay distinct — press_key",
      },
      direction: { type: "string", enum: ["up", "down"], description: "Scroll direction — scroll" },
      amount: { type: "number", description: "Pixels to scroll (default one viewport) — scroll" },
      timeout_ms: { type: "number", description: "Max wait in ms (default 30000) — wait" },
      tabId: {
        type: "string",
        description: "Target tab — required for switch_tab; optional on others (switches first)",
      },
    },
    required: ["action"],
  },
};

export async function browserActTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
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
    case "resume_control": {
      if (!b.resumeControl) return "Error: this browser does not support resuming control";
      const r = await b.resumeControl();
      return r.ok
        ? "Browser control resumed — take a new snapshot before acting"
        : `Error: ${r.detail ?? "could not resume browser control"}`;
    }
    case "request_takeover": {
      if (!b.requestHumanTakeover) {
        return "Error: this Browser Runtime cannot reveal its page for user takeover";
      }
      const r = await b.requestHumanTakeover();
      return r.ok
        ? `Browser Runtime is visible for user takeover${r.detail ? ` — ${r.detail}` : ""}`
        : `Error: ${r.detail ?? "could not reveal Browser Runtime"}`;
    }
    case "list_tabs": {
      const tabs = await b.listTabs();
      if (tabs.length === 0) return "(no open browser tabs)";
      return (
        "Browser tabs:\n" +
        tabs
          .map(
            (t) =>
              `- [${t.tabId}]${t.status === "closed" ? " (closed — navigate to reopen; old refs expired)" : t.active ? " (active)" : ""} ${t.title || "(untitled)"} — ${t.url || "(blank)"}`,
          )
          .join("\n")
      );
    }
    case "switch_tab": {
      if (!tabId) return "Error: tabId is required for switch_tab (see list_tabs)";
      const r = await b.switchTab(tabId);
      return r.ok
        ? `Switched to tab ${tabId} — re-observe to see it`
        : `Error: ${r.detail ?? "switch failed"}`;
    }
    case "click": {
      if (!ref) return "Error: ref is required for click";
      const r = await b.click(ref);
      if (r.ok) return `Clicked ${ref}${r.detail ? ` — ${r.detail}` : ""}`;
      return r.staleRef ? STALE(ref) : browserFailure(r, "click failed", true);
    }
    case "type": {
      const text = args.text;
      if (!ref) return "Error: ref is required for type";
      if (typeof text !== "string") return "Error: text is required for type";
      const r = await b.type(ref, text);
      if (r.ok) return `Typed into ${ref}`;
      return r.staleRef ? STALE(ref) : browserFailure(r, "type failed", true);
    }
    case "select": {
      const value = args.value;
      if (!ref) return "Error: ref is required for select";
      if (typeof value !== "string") return "Error: value is required for select";
      const r = await b.selectOption(ref, value);
      if (r.ok) return `Selected${r.detail ? ` ${r.detail}` : ""} in ${ref}`;
      return r.staleRef ? STALE(ref) : browserFailure(r, "select failed", true);
    }
    case "press_key": {
      const key = (args.key as string) || "Enter";
      const r = await b.pressKey(key, ref);
      if (r.ok) return `Pressed ${key}`;
      return r.staleRef && ref ? STALE(ref) : browserFailure(r, "press_key failed", true);
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
      if (!r.ok) {
        const code = r.code ? ` [${r.code}]` : "";
        return `Error${code}: ${r.detail ?? "scroll failed"}`;
      }
      const state = r.scroll
        ? r.scroll.positionKnown === false
          ? " — rendered content changed; use vision to inspect"
          : ` — position ${Math.round(r.scroll.y)}/${Math.round(r.scroll.maxY)}${r.scroll.atEnd ? " (end)" : ""}`
        : "";
      return `Scrolled ${dir}${state}`;
    }
    case "wait": {
      for (const key of ["selector", "text"])
        if (
          args[key] !== undefined &&
          (typeof args[key] !== "string" || !(args[key] as string).trim())
        )
          return `Error: ${key} must be a nonempty string for wait`;
      if (args.state !== undefined && args.state !== "visible" && args.state !== "hidden")
        return "Error: state must be visible or hidden for wait";
      if (
        args.timeout_ms !== undefined &&
        (typeof args.timeout_ms !== "number" ||
          !Number.isFinite(args.timeout_ms) ||
          args.timeout_ms <= 0)
      )
        return "Error: timeout_ms must be a positive finite number";
      if (args.state && !args.selector && !args.text)
        return "Error: state requires selector or text for wait";
      const condition: BrowserWaitCondition | undefined =
        args.selector || args.text
          ? {
              selector: args.selector as string | undefined,
              text: args.text as string | undefined,
              state: (args.state as BrowserWaitCondition["state"]) ?? "visible",
            }
          : undefined;
      const r = await b.waitForLoad(args.timeout_ms as number | undefined, condition);
      return r.ok
        ? `${condition ? "Requested condition met" : "Page ready"}${r.detail ? ` (${r.detail})` : ""}`
        : browserFailure(r, "wait failed");
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
    "Open a URL in a task-owned tab of CodeShell's built-in browser. Default for web page " +
    "tasks unless the user specifies another browser or a required capability is unavailable. " +
    "Shares the in-app browser profile; existing user-opened tabs require an explicit grant. " +
    "Starts in the background; browser_act(request_takeover) reveals this same tab when the user " +
    "wants to see it or needs to sign in. After the user finishes, call " +
    "browser_act(resume_control), then browser_observe to inspect the page. " +
    "Wait for a specific target only if it is still loading.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL to open" } },
    required: ["url"],
  },
};

export async function browserNavigateTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
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
