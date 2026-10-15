import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";

/** Track UI intent from an asynchronous opener through its eventual Dialog. */
export function createDialogFocusLease(
  opener: HTMLElement | null,
  id = `dialog-owner-${++nextId}`,
) {
  let content: HTMLElement | null = null,
    nestedRequests = 0,
    stop: (() => void) | null = null;
  const surfaces = new Set<HTMLElement>();
  const lease = {
    id,
    opener,
    ownsFocus: true,
    attach(node: HTMLElement | null) {
      content = node;
    },
    cancel() {
      lease.ownsFocus = false;
    },
    dispose() {
      stop?.();
      stop = null;
    },
    async withNestedFocus<T>(action: () => Promise<T>): Promise<T> {
      nestedRequests += 1;
      try {
        return await action();
      } finally {
        nestedRequests -= 1;
      }
    },
    start() {
      if (stop) return;
      // A child can autofocus before the portaled parent ref attaches. The
      // unique marker identifies only this lease's newly mounted Dialog.
      const currentContent = () =>
        content ?? document.querySelector<HTMLElement>(`[data-dialog-focus-owner="${id}"]`);
      const inside = (node: Node | null) => {
        const dialog = currentContent();
        return (
          (!!node && (dialog ? dialog.contains(node) : opener?.contains(node))) ||
          (!!node && [...surfaces].some((surface) => surface.contains(node)))
        );
      };
      const accepts = (target: EventTarget | null, source: EventTarget | null) => {
        if (
          !(target instanceof HTMLElement) ||
          target === document.body ||
          target.hasAttribute("data-radix-focus-guard") ||
          inside(target)
        )
          return true;
        if (source instanceof HTMLElement && inside(source)) {
          const controls = source.getAttribute("aria-controls");
          const portal = controls ? document.getElementById(controls) : null;
          if (portal?.contains(target)) {
            surfaces.add(portal);
            return true;
          }
        }
        const child = target.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
        if (
          lease.ownsFocus &&
          nestedRequests > 0 &&
          child &&
          (source === null ||
            source === document.body ||
            (source instanceof Node && inside(source)))
        ) {
          // A disabled asynchronous opener can leave BODY focused before its
          // explicitly requested confirmation mounts. This never revives a
          // lease already relinquished to external input.
          surfaces.add(child);
          return true;
        }
        return false;
      };
      const onFocus = (event: FocusEvent) => {
        if (!accepts(event.target, event.relatedTarget)) lease.cancel();
      };
      const onFocusOut = (event: FocusEvent) => {
        // Radix may restore the previous focus before an external focusin.
        if (event.relatedTarget && !accepts(event.relatedTarget, event.target)) lease.cancel();
      };
      const onPointer = (event: PointerEvent) => {
        const target = event.target as Node;
        const overlay = [currentContent(), ...surfaces].some(
          (dialog) =>
            dialog?.matches('[role="dialog"], [role="alertdialog"]') &&
            dialog.previousElementSibling === target,
        );
        if (!inside(target) && !overlay) lease.cancel();
      };
      document.addEventListener("focusin", onFocus, true);
      document.addEventListener("focusout", onFocusOut, true);
      document.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("blur", lease.cancel);
      stop = () => {
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("focusout", onFocusOut, true);
        document.removeEventListener("pointerdown", onPointer, true);
        window.removeEventListener("blur", lease.cancel);
      };
    },
  };
  return lease;
}
let nextId = 0;
export type DialogFocusLease = ReturnType<typeof createDialogFocusLease>;

/** Imperative Dialogs preserve their actual opener without taking focus back
 * from another surface or an unmounted configuration target. */
export function useDialogFocus(
  open: boolean,
  opener?: HTMLElement | null,
  providedLease?: DialogFocusLease | null,
) {
  const id = useId();
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const session = useRef<DialogFocusLease | null>(null);
  const contentLeases = useRef(new WeakMap<HTMLElement, DialogFocusLease>());
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (mounted.current) return;
        session.current?.cancel();
        session.current?.dispose();
      });
    };
  }, []);
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    session.current?.attach(node);
    if (node && session.current) contentLeases.current.set(node, session.current);
    setContent(node);
  }, []);
  const withNestedFocus = useCallback(
    <T>(action: () => Promise<T>): Promise<T> =>
      session.current ? session.current.withNestedFocus(action) : action(),
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const ownership = providedLease ?? createDialogFocusLease(opener ?? null, id);
    if (session.current !== ownership) {
      session.current?.cancel();
      session.current?.dispose();
    }
    session.current = ownership;
    ownership.attach(nodeRef.current);
    if (nodeRef.current) contentLeases.current.set(nodeRef.current, ownership);
    ownership.start();
    // FocusScope restores focus after its unmount, on a later task. Keep the
    // intent listeners until that callback consumes the return lease.
  }, [open, opener, providedLease, id]);
  useLayoutEffect(() => {
    if (!open || !content) return;
    let active = true;
    const ensureFocusedVisible = () => {
      if (!active) return;
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !content.contains(focused)) return;
      for (
        let parent = focused.parentElement;
        parent && parent !== content;
        parent = parent.parentElement
      ) {
        if (!parent.hasAttribute("data-dialog-scroll")) continue;
        const bounds = parent.getBoundingClientRect(),
          target = focused.getBoundingClientRect();
        if (bounds.height <= 0) continue;
        if (target.height > bounds.height) {
          const center = target.top + target.height / 2;
          if (center < bounds.top || center > bounds.bottom)
            parent.scrollTop += center - (bounds.top + bounds.height / 2);
        } else if (target.top < bounds.top) parent.scrollTop += target.top - bounds.top;
        else if (target.bottom > bounds.bottom) parent.scrollTop += target.bottom - bounds.bottom;
      }
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(ensureFocusedVisible);
    observer?.observe(content);
    content.querySelectorAll("[data-dialog-scroll]").forEach((node) => observer?.observe(node));
    content.addEventListener("focusin", ensureFocusedVisible);
    ensureFocusedVisible();
    return () => {
      active = false;
      observer?.disconnect();
      content.removeEventListener("focusin", ensureFocusedVisible);
    };
  }, [open, content]);
  const onCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    // A previous Dialog may dispatch this after another review has opened.
    // Consume the lease of the actual closing content, never its successor.
    const ownership =
        event.target instanceof HTMLElement
          ? contentLeases.current.get(event.target)
          : session.current,
      opener = ownership?.opener,
      focused = document.activeElement;
    if (
      ownership?.ownsFocus &&
      opener?.isConnected &&
      !opener.matches(":disabled") &&
      (!focused || focused === document.body || !focused.isConnected)
    )
      opener.focus();
    ownership?.dispose();
  }, []);
  return {
    contentRef,
    onCloseAutoFocus,
    withNestedFocus,
    focusOwnerId: providedLease?.id ?? id,
  };
}
