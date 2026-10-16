import { useCallback, useRef, useState } from "react";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";

/** Lock before opening dialogs or awaiting IPC so repeated actions cannot
 * enqueue another write. Keep bridge errors out of notifications: a rejected
 * credential write can include sensitive request data in its error message. */
export function useCredentialMutation() {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { t } = useT();
  const run = useCallback(
    async <T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      if (locked.current) return { ok: false };
      locked.current = true;
      setBusy(true);
      try {
        return { ok: true, value: await operation() };
      } catch {
        toast({ message: t("ext.credentials.operationFailed"), variant: "error" });
        return { ok: false };
      } finally {
        locked.current = false;
        setBusy(false);
      }
    },
    [t, toast],
  );
  return { busy, run };
}
