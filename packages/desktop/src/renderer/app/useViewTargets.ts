import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { ViewMode, ViewState } from "../view";

/** One-shot targets a navigation hands to the page it opens. */
export function useViewTargets(viewMode: ViewMode, setView: Dispatch<SetStateAction<ViewState>>) {
  // A history open started under one view is discarded once the view changes.
  const historyViewIntentRef = useRef({ mode: viewMode, revision: 0 });
  if (historyViewIntentRef.current.mode !== viewMode) {
    historyViewIntentRef.current = {
      mode: viewMode,
      revision: historyViewIntentRef.current.revision + 1,
    };
  }
  const [credentialsInitialTab, setCredentialsInitialTab] = useState<"link" | undefined>();
  useEffect(() => {
    if (viewMode !== "credentials") setCredentialsInitialTab(undefined);
  }, [viewMode]);
  const [traceTarget, setTraceTarget] = useState<{ sessionId?: string; traceId?: string }>({});
  const openTrace = useCallback(
    (sessionId?: string, traceId?: string) => {
      setTraceTarget({ sessionId, traceId });
      setView((current) => ({ ...current, viewMode: "traces" }));
    },
    [setView],
  );
  /** Ordinary navigation opens Traces unfiltered. */
  const navigateTo = useCallback(
    (mode: ViewMode) => {
      if (mode === "traces") setTraceTarget({});
      setView((current) => ({ ...current, viewMode: mode }));
    },
    [setView],
  );
  const openLinkCredentials = useCallback(() => {
    setCredentialsInitialTab("link");
    setView((current) => ({ ...current, viewMode: "credentials" }));
  }, [setView]);
  return {
    historyViewIntentRef,
    credentialsInitialTab,
    traceTarget,
    openTrace,
    navigateTo,
    openLinkCredentials,
  };
}
