import { useEffect, useRef, type RefObject } from "react";

/** Keep keyboard position when the two CSS-owned navigation layouts exchange visibility. */
export function useSettingsNavigationFocus(
  desktopRef: RefObject<HTMLElement | null>,
  narrowRef: RefObject<HTMLElement | null>,
): (event: Event) => void {
  const afterPopupClose = useRef<(event: Event) => void>(() => {});
  useEffect(() => {
    const desktop = desktopRef.current;
    const narrow = narrowRef.current;
    if (!desktop || !narrow || typeof ResizeObserver === "undefined") return;
    const navigationOf = (node: Node | null) =>
      [desktop, narrow].find((navigation) => node && navigation.contains(node));
    let remembered = navigationOf(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : null;
    let composing: EventTarget | null = null;
    let mounted = true;
    const popupOf = (source: HTMLElement | null) => {
      const id = source?.getAttribute("aria-controls");
      return id ? document.getElementById(id) : null;
    };

    const handoff = (): boolean => {
      if (!mounted) return false;
      const active = document.activeElement;
      // Chromium can move focus to body before delivering the resize callback.
      const source = active === remembered || active === document.body ? remembered : null;
      const previous = navigationOf(source);
      if (
        !source?.isConnected ||
        !previous ||
        previous.getClientRects().length ||
        source === composing ||
        (source.getAttribute("aria-expanded") === "true" && popupOf(source))
      ) {
        return false;
      }
      const next = previous === desktop ? narrow : desktop;
      if (!next.getClientRects().length) return false;
      const module = source.closest<HTMLElement>("[data-settings-module]");
      const selector = source.closest("[data-settings-search-field]")
        ? 'input[type="search"]'
        : source.closest("[data-settings-back]")
          ? "[data-settings-back]"
          : source.closest('[data-notification-action="open"]')
            ? '[data-notification-action="open"]'
            : "[data-settings-module-picker]";
      const matchingModule = Array.from(
        next.querySelectorAll<HTMLElement>("[data-settings-module]"),
      ).find((node) =>
        module
          ? node.dataset.settingsModule === module.dataset.settingsModule
          : node.getAttribute("aria-current") === "page",
      );
      const target =
        next.querySelector<HTMLElement>(selector) ??
        matchingModule ??
        next.querySelector<HTMLInputElement>('input[type="search"]');
      if (!target?.getClientRects().length) return false;
      target.focus();
      if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
        target.setSelectionRange(
          source.selectionStart,
          source.selectionEnd,
          source.selectionDirection ?? undefined,
        );
      }
      return document.activeElement === target;
    };
    afterPopupClose.current = (event) => {
      if (handoff()) event.preventDefault();
    };
    const remember = (event: FocusEvent) => {
      if (event.target === document.body) return;
      // Keep only the popup actually controlled by this navigation trigger.
      // Focus in any other portal or content remains outside our ownership.
      if (event.target instanceof Node && popupOf(remembered)?.contains(event.target)) return;
      remembered =
        event.target instanceof HTMLElement && navigationOf(event.target) ? event.target : null;
    };
    const rememberPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (navigationOf(event.target)) {
        // Radix Select opens on pointerdown and prevents the trigger's native
        // focus. Record its owner before the portal receives focus instead.
        const trigger =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[aria-controls]")
            : null;
        if (trigger && event.button === 0 && !event.ctrlKey) remembered = trigger;
        return;
      }
      if (!popupOf(remembered)?.contains(event.target)) {
        remembered = null;
      }
    };
    const hiddenFocusOut = (event: FocusEvent) => {
      if (event.target === remembered && remembered && !remembered.getClientRects().length) {
        // A rapid resize can return to the original dimensions before RO
        // delivers anything. Handle the actual hidden-control blur as well.
        queueMicrotask(handoff);
      }
    };
    const forget = () => {
      remembered = null;
    };
    const startComposition = (event: CompositionEvent) => {
      if (event.target instanceof Node && navigationOf(event.target)) composing = event.target;
    };
    const endComposition = () => {
      composing = null;
      // Let the final native input and React change handler finish before moving the caret.
      queueMicrotask(handoff);
    };
    const observer = new ResizeObserver(handoff);
    observer.observe(desktop);
    observer.observe(narrow);
    document.addEventListener("focusin", remember);
    document.addEventListener("focusout", hiddenFocusOut);
    document.addEventListener("pointerdown", rememberPointer, { capture: true, passive: true });
    document.addEventListener("compositionstart", startComposition);
    document.addEventListener("compositionend", endComposition);
    window.addEventListener("blur", forget);
    window.addEventListener("resize", handoff);
    return () => {
      mounted = false;
      afterPopupClose.current = () => {};
      observer.disconnect();
      document.removeEventListener("focusin", remember);
      document.removeEventListener("focusout", hiddenFocusOut);
      document.removeEventListener("pointerdown", rememberPointer, true);
      document.removeEventListener("compositionstart", startComposition);
      document.removeEventListener("compositionend", endComposition);
      window.removeEventListener("blur", forget);
      window.removeEventListener("resize", handoff);
    };
  }, [desktopRef, narrowRef]);
  return (event) => afterPopupClose.current(event);
}
