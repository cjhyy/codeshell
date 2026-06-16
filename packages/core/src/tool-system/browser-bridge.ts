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

export interface BrowserBridge {
  snapshot(): Promise<BrowserSnapshot>;
  click(ref: string): Promise<BrowserResult>;
  type(ref: string, text: string): Promise<BrowserResult>;
  navigate(url: string): Promise<BrowserResult>;
  scroll(dir: "up" | "down", amount?: number): Promise<BrowserResult>;
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
