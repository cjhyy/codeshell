import React from "react";
import type { RendererConfigurationTarget } from "../../preload/types";
import type { ProfileSwitchPreview } from "../../shared/profile-switch";
import { useT } from "../i18n/I18nProvider";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { ensureDigitalHumanRequirements } from "./profileRequirements";
import { useDigitalHumanContext } from "./useDigitalHumansLibrary";

/** Shared project-default flow. Session's explicit binding picker remains independent. */
export function useProfileSwitch(
  target: RendererConfigurationTarget,
  onAdopted: () => Promise<unknown>,
  recoveryCheckReady = false,
) {
  const { t } = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const captureContext = useDigitalHumanContext(target);
  const key = JSON.stringify(target);
  const lock = React.useRef(false);
  const [loading, setLoading] = React.useState(false);
  const [adopting, setAdopting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unavailableDefault, setUnavailableDefault] =
    React.useState<ProfileSwitchPreview["before"]>(null);
  const [pending, setPending] = React.useState<{
    key: string;
    target: RendererConfigurationTarget;
    name: string | null;
    preview: ProfileSwitchPreview;
    isCurrent: () => boolean;
  } | null>(null);
  React.useLayoutEffect(() => {
    lock.current = false;
    setPending(null);
    setError(null);
    setLoading(false);
    setAdopting(false);
    setUnavailableDefault(null);
  }, [key]);

  React.useEffect(() => {
    if (!recoveryCheckReady) {
      setUnavailableDefault(null);
      return;
    }
    const isCurrent = captureContext();
    let cancelled = false;
    void window.codeshell
      .previewProfileSwitch(target, null)
      .then((preview) => {
        if (!cancelled && isCurrent())
          setUnavailableDefault(preview.before?.available === false ? preview.before : null);
      })
      .catch(() => {
        /* The main library already owns configuration load errors. */
      });
    return () => {
      cancelled = true;
    };
  }, [key, recoveryCheckReady, captureContext]);

  const open = async (name: string | null) => {
    if (lock.current) return;
    lock.current = true;
    const isCurrent = captureContext();
    setLoading(true);
    setError(null);
    try {
      if (
        name !== null &&
        !(await ensureDigitalHumanRequirements({
          name,
          configurationTarget: target,
          api: window.codeshell,
          confirm,
          toast,
          t,
          isCurrent,
        }))
      )
        return;
      if (!isCurrent()) return;
      // Dependency installs can change inventory; review only their final state.
      const preview = await window.codeshell.previewProfileSwitch(target, name);
      if (!isCurrent()) return;
      setPending({ key, target, name, preview, isCurrent });
    } catch (caught) {
      if (isCurrent())
        toast({
          message: caught instanceof Error ? caught.message : String(caught),
          variant: "error",
        });
    } finally {
      if (isCurrent()) {
        setLoading(false);
        lock.current = false;
      }
    }
  };

  const close = () => {
    if (adopting) return;
    setPending(null);
    setError(null);
  };
  const adopt = async () => {
    const review = pending;
    if (!review || !review.isCurrent() || lock.current) return;
    lock.current = true;
    setAdopting(true);
    setError(null);
    try {
      const result = await window.codeshell.adoptProfileSwitch(
        review.target,
        review.name,
        review.preview.revision,
      );
      if (!review.isCurrent()) return;
      if (result.status === "stale") {
        // Never silently apply a replacement plan: show its changes for another explicit review.
        const preview = await window.codeshell.previewProfileSwitch(review.target, review.name);
        if (!review.isCurrent()) return;
        setPending({ ...review, preview });
        setError(t("digitalHumans.switchPreview.stale"));
        return;
      }
      setPending(null);
      setUnavailableDefault(null);
      // Main's existing configuration gate has already reloaded/notified once.
      // Dispatching settings-changed here would cause a second, unguarded reload.
      await onAdopted();
      if (review.isCurrent()) toast({ message: t("digitalHumans.switchPreview.applied") });
    } catch (caught) {
      if (review.isCurrent()) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (review.isCurrent()) {
        lock.current = false;
        setAdopting(false);
      }
    }
  };
  return {
    open,
    close,
    adopt,
    preview: pending?.key === key ? pending.preview : null,
    error,
    adopting,
    busy: loading || adopting || Boolean(pending?.key === key),
    unavailableDefault,
  };
}
