import { type RefObject, useCallback, useEffect, useState } from "react";
import { PICKER_SCRIPT, type PickedElement } from "./pickerScript";
import { NEW_TAB, type WebviewElement } from "./types";

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

  const startPicking = useCallback(async () => {
    const view = viewRef.current;
    if (!view || activeUrl === NEW_TAB) return;
    const pickUrl = activeUrl;
    setSelecting(true);
    // Safety net: if the picker promise never settles (e.g. a navigation tears
    // down the guest without rejecting executeJavaScript), don't leave the
    // button permanently disabled.
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), 60_000));
    try {
      const result = (await Promise.race([
        view.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickedElement | null>,
        timeout,
      ])) as (Omit<PickedElement, "url"> & { url?: string }) | null;
      // Prefer the picker's own location.href (authoritative) over the host's
      // active.url bookkeeping (can be stale across guest-side redirects).
      if (result) setPicked({ ...result, url: result.url || pickUrl });
    } catch {
      /* navigation/CSP interrupted the picker — just exit select mode */
    } finally {
      setSelecting(false);
    }
  }, [viewRef, activeUrl]);

  // If the active tab changes while picking, abandon select mode so the button
  // can't get stuck (the guest running the picker may have been torn down).
  useEffect(() => {
    if (selecting) setSelecting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  return { selecting, picked, setPicked, startPicking };
}
