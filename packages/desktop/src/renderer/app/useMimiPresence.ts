import { useCallback, useEffect, useRef, useState } from "react";
import type { MimiPresencePatch, MimiPresenceSnapshot } from "../../shared/mimi-presence";

const effectiveVisible = (snapshot: MimiPresenceSnapshot) =>
  snapshot.visible && !(snapshot.effectiveMode === "docked" && snapshot.dockedError);

/** One subscription drives both the legacy menu label and the Mimi settings. */
export function useMimiPresence() {
  const [petWidgetVisible, setPetWidgetVisible] = useState(false);
  const [mimiPresence, setMimiPresence] = useState<MimiPresenceSnapshot | null>(null);
  const revision = useRef(0);
  const requestId = useRef(0);
  const mounted = useRef(true);
  const accept = useCallback((snapshot: MimiPresenceSnapshot) => {
    if (!mounted.current) return;
    setMimiPresence(snapshot);
    setPetWidgetVisible(Boolean(effectiveVisible(snapshot)));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const pet = window.codeshell.pet;
    if (!pet) return;
    const offPresence = pet.onPresenceChanged?.((snapshot) => {
      revision.current++;
      accept(snapshot);
    });
    const offVisibility = pet.onWidgetVisibilityChanged?.((visible) => {
      revision.current++;
      if (mounted.current) setPetWidgetVisible(visible);
    });
    const initialRevision = revision.current;
    const initialRequest = requestId.current;
    const current = () =>
      mounted.current &&
      revision.current === initialRevision &&
      requestId.current === initialRequest;
    if (pet.getPresence) {
      void pet.getPresence().then(
        (snapshot) => {
          if (current()) accept(snapshot);
        },
        (error) => window.codeshell.log("mimi.presence.read.failed", { error: String(error) }),
      );
    } else {
      void pet.getWidgetVisibility().then(
        (visible) => {
          if (current()) setPetWidgetVisible(visible);
        },
        (error) =>
          window.codeshell.log("pet.widget.visibility.read.failed", { error: String(error) }),
      );
    }
    return () => {
      mounted.current = false;
      revision.current++;
      offPresence?.();
      offVisibility?.();
    };
  }, [accept]);

  const run = useCallback(
    async (request: () => Promise<MimiPresenceSnapshot> | undefined) => {
      const id = ++requestId.current;
      const before = revision.current;
      const current = () => mounted.current && id === requestId.current;
      try {
        const actual = await request();
        // A newer host broadcast is authoritative over an older request reply.
        if (actual && current() && before === revision.current) accept(actual);
      } catch (error) {
        window.codeshell.log("mimi.presence.update.failed", { error: String(error) });
        if (current()) {
          const beforeRead = revision.current;
          const actual = await window.codeshell.pet?.getPresence?.().catch(() => undefined);
          if (actual && current() && beforeRead === revision.current) accept(actual);
        }
        throw error;
      }
    },
    [accept],
  );

  const changeMimiPresence = useCallback(
    (patch: MimiPresencePatch): void => {
      void run(() => window.codeshell.pet?.setPresence?.(patch)).catch(() => {});
    },
    [run],
  );
  const setPetWidgetVisibility = useCallback(
    (visible: boolean): void => {
      const pet = window.codeshell.pet;
      if (!pet) return;
      if (pet.setPresence) {
        changeMimiPresence({ visible });
        return;
      }
      const id = ++requestId.current;
      const before = revision.current;
      setPetWidgetVisible(visible);
      void pet.setWidgetVisible(visible).catch((error) => {
        if (mounted.current && id === requestId.current && before === revision.current)
          setPetWidgetVisible(!visible);
        window.codeshell.log("pet.widget.visibility.failed", { error: String(error) });
      });
    },
    [changeMimiPresence],
  );
  const togglePetWidget = useCallback(
    () => setPetWidgetVisibility(!petWidgetVisible),
    [setPetWidgetVisibility, petWidgetVisible],
  );
  const previewMimi = useCallback(
    () => run(() => window.codeshell.pet?.previewPresence?.()),
    [run],
  );
  const retryMimi = useCallback((): void => {
    void run(() => window.codeshell.pet?.retryPresence?.()).catch(() => {});
  }, [run]);
  return {
    petWidgetVisible,
    mimiPresence,
    setPetWidgetVisibility,
    togglePetWidget,
    changeMimiPresence,
    previewMimi,
    retryMimi,
  };
}
