/**
 * BrowserBridge — driver-agnostic contract between the browser tools (core)
 * and whatever drives the actual browser (renderer's webview via CDP).
 *
 * Spec: docs/superpowers/specs/2026-06-16-browser-automation-mvp.md
 *
 * The core tools only know this interface. The renderer implements it on top
 * of the webview's `webContents.debugger` (CDP): observe via
 * Accessibility.getFullAXTree, act via DOM.getBoxModel → Input.dispatchMouseEvent.
 * Keeping it driver-agnostic means a future implementation (a hidden
 * BrowserWindow for unattended runs, or an external engine) can swap in without
 * touching the tools. Undefined on ToolContext → headless / no panel → tools
 * degrade with a clear error.
 */

/** One interactive element from the page's accessibility tree. */
export interface BrowserElement {
  /** Per-snapshot reference id (e1, e2, …); the renderer maps it back to a
   *  backendDOMNodeId for the action tools. Reassigned each snapshot. */
  ref: string;
  /** ARIA role (button, link, textbox, checkbox, combobox, …). */
  role: string;
  /** Accessible name (visible text / label). May be empty. */
  name: string;
  /** True for password/sensitive inputs — value is never captured (security). */
  sensitive?: boolean;
  /** Optional value for non-sensitive inputs (e.g. current textbox text). */
  value?: string;
}

export interface BrowserSnapshot {
  url: string;
  title?: string;
  elements: BrowserElement[];
  /** Set when the page needs the user to act (login wall / 2FA) — agent should
   *  hand control back to the user rather than retry. */
  needsHuman?: string;
}

export interface BrowserResult {
  ok: boolean;
  /** Human-readable detail (error reason, or short success note). */
  detail?: string;
  /** True when a ref no longer resolves (DOM changed) → agent should re-snapshot. */
  staleRef?: boolean;
}

/** Result of reading the page's main textual content (扒内容). */
export interface BrowserContent {
  ok: boolean;
  url: string;
  title?: string;
  /** Extracted readable text (main content, scripts/styles/nav stripped). */
  text: string;
  /** True if the text was truncated to a cap. */
  truncated?: boolean;
  detail?: string;
}

/** One hyperlink extracted from the page (a[href]). */
export interface BrowserLink {
  /** Visible link text (trimmed, may be empty for icon-only links). */
  text: string;
  /** Absolute URL (href resolved against the page). */
  url: string;
}

/** One image extracted from the page (img[src]). */
export interface BrowserImage {
  /** Absolute image URL (src resolved against the page). */
  url: string;
  /** alt text if present (helps the agent know what the image is). */
  alt?: string;
}

/**
 * Result of extracting the page's link/image URLs (扒链接/图片地址).
 * The a11y snapshot deliberately omits href/src (token economy); this is the
 * explicit opt-in for "I need the actual URLs" — e.g. collect article links,
 * find a video/image source to hand to yt-dlp/curl.
 */
export interface BrowserExtract {
  ok: boolean;
  url: string;
  title?: string;
  links: BrowserLink[];
  images: BrowserImage[];
  /** True if either list was capped (page had more) — narrow the page first. */
  truncated?: boolean;
  detail?: string;
}

export interface BrowserBridge {
  snapshot(): Promise<BrowserSnapshot>;
  click(ref: string): Promise<BrowserResult>;
  type(ref: string, text: string): Promise<BrowserResult>;
  navigate(url: string): Promise<BrowserResult>;
  scroll(dir: "up" | "down", amount?: number): Promise<BrowserResult>;
  /** Read the page's main readable text content (for summarizing / extraction). */
  readContent(): Promise<BrowserContent>;
  /** Extract the page's hyperlink + image URLs (href/src the a11y tree omits). */
  extractLinks(): Promise<BrowserExtract>;
  /** Wait until the page finishes loading (or a timeout). */
  waitForLoad(timeoutMs?: number): Promise<BrowserResult>;
  /** Press Enter on the focused element / a given ref (submit a search box). */
  pressEnter(ref?: string): Promise<BrowserResult>;
}

/**
 * Minimal shape of a CDP Accessibility.getFullAXTree node we depend on.
 * (The real payload has more fields; we read only these.)
 */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/** Roles we surface as actionable/meaningful to the agent. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "option",
]);

/** Input-ish roles whose value we may show (unless sensitive). */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "slider"]);

function propValue(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

/**
 * Pure: flatten a CDP accessibility tree into the compact, ref-tagged element
 * list the LLM sees. Token-economical (role + name + key props only, no DOM
 * markup). Returns elements in tree order with refs e1, e2, …, plus a
 * `refToBackendId` map the caller (renderer) keeps so action tools can resolve
 * a ref back to a backendDOMNodeId.
 *
 * Filtering: drop ignored nodes; keep nodes whose role is interactive (or that
 * are explicitly focusable), and that have a name OR are a value input. Password
 * / sensitive inputs are marked `sensitive` and their value is NEVER included.
 */
export function flattenAxTree(nodes: AXNode[]): {
  elements: BrowserElement[];
  refToBackendId: Record<string, number>;
} {
  const elements: BrowserElement[] = [];
  const refToBackendId: Record<string, number> = {};
  let counter = 0;

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!role) continue;

    const focusable = propValue(node, "focusable") === true;
    if (!INTERACTIVE_ROLES.has(role) && !focusable) continue;

    const name = (node.name?.value ?? "").trim();
    const isValueRole = VALUE_ROLES.has(role);
    // Skip nameless non-input noise (e.g. a focusable wrapper with no label).
    if (!name && !isValueRole) continue;

    // backendDOMNodeId is required to act on the element later; without it the
    // element isn't actionable, so don't surface it.
    if (node.backendDOMNodeId === undefined) continue;

    const sensitive =
      propValue(node, "protected") === true || // ARIA "protected" → password-like
      role === "textbox" && /password|密码/i.test(name);

    counter += 1;
    const ref = `e${counter}`;
    refToBackendId[ref] = node.backendDOMNodeId;

    const el: BrowserElement = { ref, role, name };
    if (sensitive) {
      el.sensitive = true; // value intentionally omitted
    } else if (isValueRole) {
      const v = (node.value?.value as string | undefined)?.toString();
      if (v) el.value = v;
    }
    elements.push(el);
  }

  return { elements, refToBackendId };
}

/** Default cap for extracted page text (chars) — keeps content within a sane
 *  token budget; the agent can scroll + re-read for more. */
export const CONTENT_CHAR_CAP = 12_000;

/** Cap for extracted links/images per call — keeps the result token-bounded;
 *  a busy page can have thousands of <a>/<img>. The agent narrows the page
 *  (navigate/scroll) and re-extracts for more. */
export const EXTRACT_LINK_CAP = 200;

/**
 * In-page JS (string) that collects deduped, absolute link + image URLs and
 * returns them as a JSON-serializable object. Run via CDP Runtime.evaluate with
 * returnByValue. Kept here (not in the renderer) so the extraction contract is
 * defined alongside its types and is unit-testable. `cap` bounds each list;
 * `truncated` is set when either hit the cap.
 *
 * - Links: <a href> with a real navigable href (skips javascript:/empty/#-only).
 * - Images: <img src> (skips empty/data: noise beyond a length sanity bound is
 *   left to the page; data URLs are dropped — they're inline, not fetchable URLs).
 * - URLs are absolute (the DOM's .href/.src already resolve against the base).
 */
export function buildExtractLinksScript(cap = EXTRACT_LINK_CAP): string {
  return `(function(){
    var cap=${cap};
    var links=[],images=[],lt=false,it=false,seenL={},seenI={};
    var as=document.querySelectorAll('a[href]');
    for(var i=0;i<as.length;i++){
      var a=as[i],u=a.href;
      if(!u||u.indexOf('javascript:')===0||u==='#'||u.charAt(u.length-1)==='#'&&u.indexOf('#')===u.length-1)continue;
      if(seenL[u])continue;seenL[u]=1;
      if(links.length>=cap){lt=true;break;}
      links.push({text:(a.textContent||'').trim().slice(0,200),url:u});
    }
    var ims=document.querySelectorAll('img[src]');
    for(var j=0;j<ims.length;j++){
      var im=ims[j],s=im.src;
      if(!s||s.indexOf('data:')===0)continue;
      if(seenI[s])continue;seenI[s]=1;
      if(images.length>=cap){it=true;break;}
      var o={url:s};var alt=(im.getAttribute('alt')||'').trim();if(alt)o.alt=alt.slice(0,200);
      images.push(o);
    }
    return {links:links,images:images,truncated:lt||it};
  })()`;
}

/**
 * Pure: normalize raw extracted page text — collapse runs of whitespace/blank
 * lines, trim, and cap to `cap` chars (marking truncation). The renderer pulls
 * raw innerText via CDP; this keeps the cleanup logic testable and consistent.
 */
export function cleanPageText(raw: string, cap: number = CONTENT_CHAR_CAP): { text: string; truncated: boolean } {
  const normalized = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= cap) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, cap) + "\n…(truncated)", truncated: true };
}

/** Render a snapshot's element list as the compact text block shown to the LLM. */
export function renderElementList(elements: BrowserElement[]): string {
  if (elements.length === 0) return "(no interactive elements found)";
  return elements
    .map((e) => {
      const namePart = e.name ? ` "${e.name}"` : "";
      const valuePart = e.sensitive
        ? " [sensitive]"
        : e.value
          ? ` =${JSON.stringify(e.value)}`
          : "";
      return `[ref=${e.ref}] ${e.role}${namePart}${valuePart}`;
    })
    .join("\n");
}
