import type { BrowserWaitCondition } from "@cjhyy/code-shell-core";

/** Serialized into the main document by either maintained browser library. */
export function pageWaitCondition(
  condition?: BrowserWaitCondition,
): boolean | { invalidSelector: true } {
  if (!condition?.selector && !condition?.text) return document.readyState !== "loading";
  if (!document.body) return false;
  let elements: Element[];
  try {
    elements = condition.selector
      ? Array.from(document.querySelectorAll(condition.selector))
      : [document.body];
  } catch {
    // Polling libraries can swallow predicate errors and report a timeout.
    // Return a truthy sentinel so invalid input fails immediately at the host.
    return { invalidSelector: true };
  }
  const visible = elements.some((element) => {
    const rect = element.getBoundingClientRect();
    // A body containing only fixed/absolute-positioned controls can have zero
    // height even though its text is rendered. Only element targets need a box.
    if (condition.selector && (rect.width <= 0 || rect.height <= 0)) return false;
    // Check ancestors too: a nonzero box can still be hidden by an ancestor.
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      )
        return false;
    }
    if (!condition.text) return true;
    // innerText omits hidden descendants and never reads input/password values.
    return (
      element instanceof HTMLElement ? element.innerText : (element.textContent ?? "")
    ).includes(condition.text);
  });
  return condition.state === "hidden" ? !visible : visible;
}

export function browserWaitTimeout(timeoutMs?: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs! > 0 ? Math.min(timeoutMs!, 60_000) : 30_000;
}
