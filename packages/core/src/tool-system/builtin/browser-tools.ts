/**
 * Browser automation tools — drive the in-app webview via the BrowserBridge
 * (CDP under the hood). Fine-grained, ref-based, observe→act loop.
 *
 * Spec: docs/superpowers/specs/2026-06-16-browser-automation-mvp.md
 *
 * observe (browser_snapshot) returns the page's interactive elements as a
 * compact, ref-tagged list from the accessibility tree (token-economical, no
 * screenshots). act tools reference elements by the ref the last snapshot
 * assigned. All tools degrade with a clear error when no browser is wired
 * (headless / no panel). They are isConcurrencySafe:false — a single webview
 * is driven serially.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { renderElementList } from "../browser-bridge.js";

const NO_BROWSER =
  "Error: browser automation is not available (no browser panel in this session). " +
  "It requires the desktop app with an open browser panel.";

function bridge(ctx?: ToolContext) {
  return ctx?.browser;
}

// ---- browser_snapshot -------------------------------------------------------

export const browserSnapshotToolDef: ToolDefinition = {
  name: "browser_snapshot",
  description:
    "Observe the current page in the browser panel. Returns the page URL, title, " +
    "and a compact list of interactive elements, each tagged with a [ref=eN] you " +
    "pass to browser_click / browser_type. ALWAYS snapshot before acting, and " +
    "re-snapshot after any navigation or page change (refs are only valid for the " +
    "latest snapshot). Sensitive inputs (passwords) show as [sensitive] with no value.",
  inputSchema: { type: "object", properties: {} },
};

export async function browserSnapshotTool(_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const snap = await b.snapshot();
  const header = `URL: ${snap.url}${snap.title ? `\nTitle: ${snap.title}` : ""}`;
  const human = snap.needsHuman ? `\n\n⚠ ${snap.needsHuman} — please complete it in the browser panel, then continue.` : "";
  return `${header}\n\n${renderElementList(snap.elements)}${human}`;
}

// ---- browser_navigate -------------------------------------------------------

export const browserNavigateToolDef: ToolDefinition = {
  name: "browser_navigate",
  description:
    "Navigate the browser panel to a URL (opens the panel automatically if none " +
    "is open). Then call browser_wait + browser_snapshot to see the page.",
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

// ---- browser_click ----------------------------------------------------------

export const browserClickToolDef: ToolDefinition = {
  name: "browser_click",
  description:
    "Click an element by its ref from the latest browser_snapshot. If the ref is " +
    "stale (page changed), re-run browser_snapshot and use the new ref.",
  inputSchema: {
    type: "object",
    properties: { ref: { type: "string", description: "Element ref, e.g. e3, from browser_snapshot" } },
    required: ["ref"],
  },
};

export async function browserClickTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const ref = args.ref as string;
  if (!ref) return "Error: ref is required";
  const r = await b.click(ref);
  if (r.ok) return `Clicked ${ref}${r.detail ? ` — ${r.detail}` : ""}`;
  return r.staleRef
    ? `Error: ref ${ref} is no longer valid (page changed). Re-run browser_snapshot.`
    : `Error: ${r.detail ?? "click failed"}`;
}

// ---- browser_type -----------------------------------------------------------

export const browserTypeToolDef: ToolDefinition = {
  name: "browser_type",
  description:
    "Type text into an element (input/textbox) by its ref from the latest " +
    "browser_snapshot. Focuses the element first. Re-snapshot if the ref is stale.",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Element ref, e.g. e2, from browser_snapshot" },
      text: { type: "string", description: "Text to type" },
    },
    required: ["ref", "text"],
  },
};

export async function browserTypeTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const ref = args.ref as string;
  const text = args.text as string;
  if (!ref) return "Error: ref is required";
  if (typeof text !== "string") return "Error: text is required";
  const r = await b.type(ref, text);
  if (r.ok) return `Typed into ${ref}`;
  return r.staleRef
    ? `Error: ref ${ref} is no longer valid (page changed). Re-run browser_snapshot.`
    : `Error: ${r.detail ?? "type failed"}`;
}

// ---- browser_scroll ---------------------------------------------------------

export const browserScrollToolDef: ToolDefinition = {
  name: "browser_scroll",
  description: "Scroll the page up or down (e.g. to reveal more elements), then re-snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
      amount: { type: "number", description: "Pixels to scroll (default: one viewport)" },
    },
    required: ["direction"],
  },
};

export async function browserScrollTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const dir = args.direction as "up" | "down";
  if (dir !== "up" && dir !== "down") return "Error: direction must be 'up' or 'down'";
  const r = await b.scroll(dir, args.amount as number | undefined);
  return r.ok ? `Scrolled ${dir}` : `Error: ${r.detail ?? "scroll failed"}`;
}

// ---- browser_read_content ---------------------------------------------------

export const browserReadContentToolDef: ToolDefinition = {
  name: "browser_read_content",
  description:
    "Read the current page's main readable text content (for summarizing or " +
    "extracting an article/post). Returns cleaned visible text (long pages are " +
    "truncated — scroll + read again for more). Use this to 'scrape' a page after " +
    "navigating to it.",
  inputSchema: { type: "object", properties: {} },
};

export async function browserReadContentTool(_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const c = await b.readContent();
  if (!c.ok) return `Error: ${c.detail ?? "could not read page content"}`;
  const head = `URL: ${c.url}${c.title ? `\nTitle: ${c.title}` : ""}${c.truncated ? "\n(content truncated)" : ""}`;
  return `${head}\n\n${c.text || "(no readable text)"}`;
}

// ---- browser_wait -----------------------------------------------------------

export const browserWaitToolDef: ToolDefinition = {
  name: "browser_wait",
  description:
    "Wait for the page to finish loading (e.g. after a navigation or a click " +
    "that loads new content) before snapshotting or reading. Returns when the " +
    "page is ready or after a timeout.",
  inputSchema: {
    type: "object",
    properties: { timeout_ms: { type: "number", description: "Max wait in ms (default 10000)" } },
  },
};

export async function browserWaitTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const r = await b.waitForLoad(args.timeout_ms as number | undefined);
  return r.ok ? `Page ready${r.detail ? ` (${r.detail})` : ""}` : `Error: ${r.detail ?? "wait failed"}`;
}

// ---- browser_press_enter ----------------------------------------------------

export const browserPressEnterToolDef: ToolDefinition = {
  name: "browser_press_enter",
  description:
    "Press Enter — typically to submit a search after browser_type into a search " +
    "box. Optionally focus a ref first. Follow with browser_wait + browser_snapshot.",
  inputSchema: {
    type: "object",
    properties: { ref: { type: "string", description: "Optional element ref to focus before Enter" } },
  },
};

export async function browserPressEnterTool(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const b = bridge(ctx);
  if (!b) return NO_BROWSER;
  const r = await b.pressEnter(args.ref as string | undefined);
  if (r.ok) return "Pressed Enter";
  return r.staleRef
    ? `Error: ref ${args.ref} is no longer valid (page changed). Re-run browser_snapshot.`
    : `Error: ${r.detail ?? "press Enter failed"}`;
}

/** True when the session has a browser bridge wired (used to gate visibility). */
export function isBrowserAutomationAvailable(ctx?: ToolContext): boolean {
  return bridge(ctx) !== undefined;
}
