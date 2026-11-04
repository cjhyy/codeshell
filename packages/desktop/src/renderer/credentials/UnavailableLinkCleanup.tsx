import { useEffect, useRef, useState } from "react";
import type { MaskedLinkConnection } from "@cjhyy/code-shell-link";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n";
import type { MaskedCredentialView } from "./types";

/** Existing grants remain removable while policy hides their business actions. */
export function UnavailableLinkCleanup({
  cwd,
  connections = [],
  credentials = [],
  reload,
  onChanged,
}: {
  cwd: string;
  connections?: MaskedLinkConnection[];
  credentials?: MaskedCredentialView[];
  reload: () => Promise<void>;
  onChanged: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const [message, setMessage] = useState("");
  const active = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const remote = connections.filter(
    (connection) => connection.authSource === "remote-link" && connection.editable,
  );
  const remove = async (operation: () => Promise<unknown>, label?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await operation();
      if (active.current) {
        setConfirm(undefined);
        if (label && (result as { remoteRevoked?: boolean })?.remoteRevoked === false)
          setMessage(t("ext.link.oauthLogoutWarning", { name: label }));
      }
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      await reload().catch(() => undefined);
      onChanged();
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  if (!remote.length && !credentials.length && !message) return null;
  return (
    <section data-account-link-cleanup className="space-y-3 rounded-xl border p-3">
      <p className="text-sm font-medium">{t("accountFeatures.cleanup")}</p>
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {remote.map((connection) => (
        <div key={connection.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="break-words text-sm">{connection.label}</span>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (confirm !== connection.id) setConfirm(connection.id);
              else
                void remove(() =>
                  window.codeshell.links.remoteDisconnect(cwd, connection.id, connection.revision),
                );
            }}
          >
            {t(
              confirm === connection.id
                ? "ext.link.remoteConfirmDisconnect"
                : "ext.link.remoteDisconnect",
            )}
          </Button>
        </div>
      ))}
      {credentials.map((credential) => (
        <div key={credential.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="break-words text-sm">{credential.label}</span>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void remove(() => window.codeshell.mcpOAuth.logout(credential.id), credential.label)
            }
          >
            {t("ext.link.oauthLogout")}
          </Button>
        </div>
      ))}
    </section>
  );
}
