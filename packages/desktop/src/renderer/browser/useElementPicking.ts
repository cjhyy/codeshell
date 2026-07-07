import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { PICKER_CLEANUP_SCRIPT, PICKER_SCRIPT, type PickedElement } from "./pickerScript";
import { NEW_TAB, type WebviewElement } from "./types";

interface ActivePick {
  view: WebviewElement;
  timeoutId: number;
  resolveAbandon: () => void;
}

/**
 * Element-picking ("圈选"): inject a picker into the guest page that highlights
 * elements on hover and resolves with the clicked element's info. The guest has
 * no preload, so we drive it entirely via executeJavaScript and read the
 * picker's Promise resolution value back here.
 *
 * `activeUrl` gates picking (no picking on the NEW_TAB landing) and is captured
 * as the fallback pick url. `activeId` is watched so a tab switch abandons an
 * in-flight pick.
 */
export function useElementPicking(
  viewRef: RefObject<WebviewElement | null>,
  activeUrl: string,
  activeId: string,
): {
  selecting: boolean;
  picked: PickedElement | null;
  setPicked: React.Dispatch<React.SetStateAction<PickedElement | null>>;
  startPicking: () => Promise<void>;
} {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const activePickRef = useRef<ActivePick | null>(null);

  const cleanupGuestPicker = useCallback((view: WebviewElement): void => {
    void view.executeJavaScript(PICKER_CLEANUP_SCRIPT, true).catch(() => undefined);
  }, []);

  const finishPick = useCallback(
    (pick: ActivePick, opts: { cleanupGuest: boolean; updateState: boolean }): boolean => {
      if (activePickRef.current !== pick) return false;
      activePickRef.current = null;
      window.clearTimeout(pick.timeoutId);
      if (opts.cleanupGuest) cleanupGuestPicker(pick.view);
      if (opts.updateState) setSelecting(false);
      return true;
    },
    [cleanupGuestPicker],
  );

  const abandonActivePick = useCallback(
    (updateState = true): void => {
      const pick = activePickRef.current;
      if (!pick) {
        if (updateState) setSelecting(false);
        return;
      }
      const finished = finishPick(pick, { cleanupGuest: true, updateState });
      if (finished) pick.resolveAbandon();
    },
    [finishPick],
  );

  const startPicking = useCallback(async () => {
    const view = viewRef.current;
    if (!view || activeUrl === NEW_TAB) return;
    abandonActivePick();
    const pickUrl = activeUrl;
    setSelecting(true);
    // Safety net: if the picker promise never settles (e.g. a navigation tears
    // down the guest without rejecting executeJavaScript), don't leave the
    // button permanently disabled, and also tear down the guest listeners.
    let resolveAbandon!: () => void;
    const abandon = new Promise<null>((res) => {
      resolveAbandon = () => res(null);
    });
    const pick: ActivePick = {
      view,
      timeoutId: 0,
      resolveAbandon,
    };
    pick.timeoutId = window.setTimeout(() => {
      if (finishPick(pick, { cleanupGuest: true, updateState: true })) resolveAbandon();
    }, 60_000);
    activePickRef.current = pick;
    let cleanupOnFinally = false;
    try {
      const result = (await Promise.race([
        view.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickedElement | null>,
        abandon,
      ])) as (Omit<PickedElement, "url"> & { url?: string }) | null;
      // Prefer the picker's own location.href (authoritative) over the host's
      // active.url bookkeeping (can be stale across guest-side redirects).
      if (result && activePickRef.current === pick)
        setPicked({ ...result, url: result.url || pickUrl });
    } catch {
      /* navigation/CSP interrupted the picker — just exit select mode */
      cleanupOnFinally = true;
    } finally {
      finishPick(pick, { cleanupGuest: cleanupOnFinally, updateState: true });
    }
  }, [abandonActivePick, activeUrl, finishPick, viewRef]);

  // If the active tab changes while picking, abandon select mode so the button
  // can't get stuck (the guest running the picker may have been torn down).
  useEffect(() => {
    abandonActivePick();
  }, [abandonActivePick, activeId, activeUrl]);

  useEffect(() => () => abandonActivePick(false), [abandonActivePick]);

  return { selecting, picked, setPicked, startPicking };
}
