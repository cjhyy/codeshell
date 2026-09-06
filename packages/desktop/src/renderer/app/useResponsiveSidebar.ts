import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export const SIDEBAR_BREAKPOINT = 640;

function subscribeToWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const isNarrowWindow = () => window.innerWidth < SIDEBAR_BREAKPOINT;

/** Narrow navigation is temporary; resizing never rewrites the desktop preference. */
export function useResponsiveSidebar(
  desktopCollapsed: boolean,
  toggleDesktop: () => void,
  available = true,
) {
  const narrow = useSyncExternalStore(subscribeToWidth, isNarrowWindow, () => false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pendingNavigation = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!narrow || !available) setDrawerOpen(false);
  }, [narrow, available]);
  useEffect(
    () => () => {
      pendingNavigation.current = null;
    },
    [],
  );

  const close = useCallback(() => setDrawerOpen(false), []);
  const toggle = useCallback(() => {
    if (!available) return;
    if (narrow) setDrawerOpen((open) => !open);
    else toggleDesktop();
  }, [available, narrow, toggleDesktop]);
  const navigate = useCallback(
    (action: () => void) => {
      if (narrow && drawerOpen) {
        pendingNavigation.current = action;
        setDrawerOpen(false);
      } else action();
    },
    [narrow, drawerOpen],
  );
  const afterClose = useCallback(() => {
    const action = pendingNavigation.current;
    pendingNavigation.current = null;
    action?.();
  }, []);

  return {
    narrow,
    visible: narrow ? available && drawerOpen : !desktopCollapsed,
    toggle,
    close,
    navigate,
    afterClose,
  };
}
