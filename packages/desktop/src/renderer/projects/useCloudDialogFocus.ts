import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface CloudFocusLease {
  source: HTMLElement;
  scope: HTMLElement;
  identity: string;
  wholeDialog: boolean;
  cancelled: boolean;
}

/** Cloud UI-only focus ownership. Native disabling may leave BODY focused;
 * an explicit pointer/focus move or window blur permanently cancels recovery. */
export function useCloudDialogFocus(scopeRef: RefObject<HTMLElement | null>, identity = "") {
  const live = useRef(true);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const leases = useRef(new Set<CloudFocusLease>());
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
    const onBlur = () => {
      for (const lease of leases.current) lease.cancelled = true;
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onBlur);
    return () => {
      live.current = false;
      for (const lease of leases.current) lease.cancelled = true;
      leases.current.clear();
      document.removeEventListener("focusin", onFocus, true);
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
      (focused && focused !== document.body && focused !== lease.source && focused.isConnected)
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
  return { capture, discard, recover, restoreReturn };
}
