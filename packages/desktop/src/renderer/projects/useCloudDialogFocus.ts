import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface CloudFocusLease {
  source: HTMLElement;
  scope: HTMLElement;
  identity: string;
  wholeDialog: boolean;
  cancelled: boolean;
  disabledFallback: HTMLElement | null;
}

/** Cloud UI-only focus ownership. Native disabling may leave BODY focused;
 * an explicit pointer/focus move or window blur permanently cancels recovery. */
export function useCloudDialogFocus(scopeRef: RefObject<HTMLDivElement | null>, identity = "") {
  const live = useRef(true);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const leases = useRef(new Set<CloudFocusLease>());
  const stopVisibility = useRef<(() => void) | null>(null);
  const attachScope = useCallback(
    (scope: HTMLDivElement | null) => {
      stopVisibility.current?.();
      stopVisibility.current = null;
      scopeRef.current = scope;
      if (!scope) return;
      let active = true;
      const dialog = scope.closest('[role="dialog"]');
      const ensureVisible = () => {
        const focused = document.activeElement;
        if (
          !active ||
          !live.current ||
          !(focused instanceof HTMLElement) ||
          !scope.contains(focused)
        )
          return;
        // Only actual owned auto scrollers move. In particular, never scroll the
        // modal's overflow:hidden shell or move focus after a resize/zoom.
        for (
          let node: HTMLElement | null = focused;
          node && node !== dialog;
          node = node.parentElement
        ) {
          if (!node.hasAttribute("data-cloud-dialog-scroll") || !node.clientHeight) continue;
          const bounds = node.getBoundingClientRect();
          const top = bounds.top + node.clientTop,
            bottom = top + node.clientHeight;
          const target = focused.getBoundingClientRect();
          if (target.height > node.clientHeight) {
            const center = target.top + target.height / 2;
            if (center < top || center > bottom) node.scrollTop += center - (top + bottom) / 2;
          } else if (target.top < top) node.scrollTop += target.top - top;
          else if (target.bottom > bottom) node.scrollTop += target.bottom - bottom;
        }
      };
      const observer =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(ensureVisible);
      observer?.observe(scope);
      if (dialog) {
        observer?.observe(dialog);
        dialog
          .querySelectorAll("[data-cloud-dialog-scroll]")
          .forEach((node) => observer?.observe(node));
      }
      scope.addEventListener("focusin", ensureVisible);
      window.addEventListener("resize", ensureVisible);
      stopVisibility.current = () => {
        active = false;
        observer?.disconnect();
        scope.removeEventListener("focusin", ensureVisible);
        window.removeEventListener("resize", ensureVisible);
      };
    },
    [scopeRef],
  );
  const [recovery, setRecovery] = useState<{
    lease: CloudFocusLease;
    fallback: () => HTMLElement | null;
    preferFallback: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    live.current = true;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.hasAttribute("data-radix-focus-guard")) return;
      for (const lease of leases.current) {
        if (lease.wholeDialog && (target === document.body || lease.scope.contains(target)))
          continue;
        // Electron's FocusScope can focus the modal itself when its active
        // native control becomes disabled. This is still the same operation;
        // an earlier pointer/focus handoff must never regain ownership.
        if (
          !lease.cancelled &&
          lease.source.matches(":disabled") &&
          target === lease.scope.closest('[role="dialog"]') &&
          (!event.relatedTarget ||
            event.relatedTarget === lease.source ||
            event.relatedTarget === document.body)
        ) {
          lease.disabledFallback = target;
          continue;
        }
        if (target !== lease.source && !lease.source.contains(target)) lease.cancelled = true;
      }
    };
    const onPointer = (event: PointerEvent) => {
      for (const lease of leases.current) {
        const target = event.target as Node;
        if (
          lease.wholeDialog
            ? lease.scope.contains(target) || target === lease.scope.previousElementSibling
            : lease.source.contains(target)
        )
          continue;
        lease.cancelled = true;
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (
        !(next instanceof HTMLElement) ||
        next === document.body ||
        next.hasAttribute("data-radix-focus-guard")
      )
        return;
      // FocusScope may synchronously redirect an external focus attempt before
      // it emits focusin. Preserve that explicit handoff intent as well.
      for (const lease of leases.current) {
        if (
          lease.wholeDialog
            ? lease.scope.contains(next)
            : next === lease.source ||
              lease.source.contains(next) ||
              (lease.source.matches(":disabled") && next === lease.scope.closest('[role="dialog"]'))
        )
          continue;
        lease.cancelled = true;
      }
    };
    const onBlur = () => {
      for (const lease of leases.current) lease.cancelled = true;
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onBlur);
    return () => {
      live.current = false;
      for (const lease of leases.current) lease.cancelled = true;
      leases.current.clear();
      stopVisibility.current?.();
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useLayoutEffect(() => {
    for (const lease of leases.current) {
      if (lease.identity !== identity) {
        lease.cancelled = true;
        leases.current.delete(lease);
      }
    }
  }, [identity]);
  const capture = useCallback(
    (wholeDialog = false, opener?: HTMLElement | null): CloudFocusLease | null => {
      const scope = scopeRef.current;
      const source = opener ?? document.activeElement;
      if (
        !scope ||
        !(source instanceof HTMLElement) ||
        source === document.body ||
        (!wholeDialog && !scope.contains(source))
      )
        return null;
      const lease = {
        source,
        scope,
        identity: currentIdentity.current,
        wholeDialog,
        cancelled: false,
        disabledFallback: null,
      };
      leases.current.add(lease);
      return lease;
    },
    [scopeRef],
  );
  const discard = useCallback((lease: CloudFocusLease | null) => {
    if (!lease) return;
    lease.cancelled = true;
    leases.current.delete(lease);
  }, []);
  const owned = useCallback(
    (lease: CloudFocusLease) =>
      live.current && !lease.cancelled && lease.identity === currentIdentity.current,
    [],
  );
  const restoreReturn = (lease: CloudFocusLease | null) => {
    if (!lease) return;
    const canRestore = owned(lease);
    discard(lease);
    const focused = document.activeElement;
    if (
      canRestore &&
      lease.source.isConnected &&
      !lease.source.matches(":disabled") &&
      (!focused || focused === document.body || !focused.isConnected || focused === lease.source)
    )
      lease.source.focus();
  };
  useLayoutEffect(() => {
    if (!recovery) return;
    setRecovery(null);
    const { lease, fallback, preferFallback } = recovery;
    const canRestore = owned(lease);
    discard(lease);
    const focused = document.activeElement;
    if (
      !canRestore ||
      (focused &&
        focused !== document.body &&
        focused !== lease.source &&
        focused !== lease.disabledFallback &&
        focused.isConnected)
    )
      return;
    const source =
      lease.source.isConnected && !lease.source.matches(":disabled") ? lease.source : null;
    const target = preferFallback ? fallback() : (source ?? fallback());
    if (target?.isConnected && !target.matches(":disabled")) target.focus();
  }, [discard, owned, recovery]);
  const recover = (
    lease: CloudFocusLease | null,
    fallback: () => HTMLElement | null,
    preferFallback = false,
  ) => {
    if (lease && owned(lease)) setRecovery({ lease, fallback, preferFallback });
    else discard(lease);
  };
  return { attachScope, capture, discard, recover, restoreReturn };
}
