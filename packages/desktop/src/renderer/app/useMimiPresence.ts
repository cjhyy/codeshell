import { useCallback, useEffect, useRef, useState } from "react";
import type { MimiPresencePatch, MimiPresenceSnapshot } from "../../shared/mimi-presence";

const effectiveVisible = (snapshot: MimiPresenceSnapshot) =>
  snapshot.visible && !(snapshot.effectiveMode === "docked" && snapshot.dockedError);

/** One subscription drives both the legacy menu label and the Mimi settings. */
export function useMimiPresence() {
  const [petWidgetVisible, setPetWidgetVisible] = useState(false);
  const [mimiPresence, setMimiPresence] = useState<MimiPresenceSnapshot | null>(null);
  // The last change or retry the owner refused; the settings page shows it.
  const [presenceError, setPresenceError] = useState<string | null>(null);
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

  /** A change or retry: its failure is kept in `presenceError` instead of being dropped. */
  const report = useCallback(
    (request: () => Promise<MimiPresenceSnapshot> | undefined): void => {
      void run(request).then(
        () => {
          if (mounted.current) setPresenceError(null);
        },
        (error: unknown) => {
          if (mounted.current)
            setPresenceError(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [run],
  );
  const dismissPresenceError = useCallback(() => setPresenceError(null), []);
  const changeMimiPresence = useCallback(
    (patch: MimiPresencePatch): void => report(() => window.codeshell.pet?.setPresence?.(patch)),
    [report],
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
  const retryMimi = useCallback(
    (): void => report(() => window.codeshell.pet?.retryPresence?.()),
    [report],
  );
  return {
    petWidgetVisible,
    mimiPresence,
    presenceError,
    dismissPresenceError,
    setPetWidgetVisibility,
    togglePetWidget,
    changeMimiPresence,
    previewMimi,
    retryMimi,
  };
}
