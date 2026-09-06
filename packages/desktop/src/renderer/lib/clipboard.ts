/**
 * Copy text to the clipboard with a fallback for insecure contexts.
 *
 * `navigator.clipboard.writeText` only exists in a *secure context* (HTTPS, or
 * the Electron app origin). The mobile remote UI is served over plain HTTP on a
 * LAN IP, where `navigator.clipboard` is undefined and any call rejects with
 * `NotAllowedError: Write permission denied`. So we try the modern API first
 * and fall back to the legacy `document.execCommand("copy")` over a hidden
 * <textarea>, which works on insecure origins (e.g. the phone).
 *
 * Returns true on success. Never throws / never leaves an unhandled rejection —
 * callers decide whether to toast success or failure.
 */
export async function copyText(text: string): Promise<boolean> {
  // Modern API — only usable in a secure context.
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard?.writeText &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (permission denied, etc.).
    }
  }
  return legacyCopy(text);
}

/** execCommand-based copy: works on insecure HTTP (the mobile case). */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const previousFocus = document.activeElement;
  const dialog =
    previousFocus instanceof HTMLElement ? previousFocus.closest('[role="dialog"]') : null;
  // A modal focus trap redirects focus away from a textarea outside its dialog.
  // Keep selection inside that scope so execCommand copies the requested text.
  const container = dialog instanceof HTMLElement && dialog.isConnected ? dialog : document.body;
  const ta = document.createElement("textarea");
  ta.value = text;
  // Keep it out of view and unfocusable-looking, but still selectable.
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.border = "none";
  ta.style.outline = "none";
  ta.style.boxShadow = "none";
  ta.style.background = "transparent";
  ta.style.opacity = "0";
  container.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.parentNode?.removeChild(ta);
    // Copying from a keyboard action must not strand focus on the document.
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}
