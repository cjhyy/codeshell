import { useEffect, useId, useState } from "react";
import { UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import { useT } from "../i18n/I18nProvider";
import { CloudAccountSettings } from "../settings/CloudAccountSettings";

/** Global account access stays visible even when no project or chat is open. */
export function AccountSidebarEntry() {
  const { t } = useT();
  const [status, setStatus] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [unavailable, setUnavailable] = useState(false);
  const detailId = useId();

  useEffect(() => {
    let active = true;
    let receivedStatus = false;
    const api = window.codeshell.cloudAccount;
    const unsubscribe = api.onStatus((next) => {
      if (!active) return;
      receivedStatus = true;
      setStatus(next);
      setUnavailable(false);
    });
    // A status event can arrive while this first IPC request is still pending.
    // Its newer state must win over either a stale response or a late failure.
    void api.status().then(
      (next) => {
        if (!active || receivedStatus) return;
        setStatus(next);
      },
      () => {
        if (!active || receivedStatus) return;
        setUnavailable(true);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const username = status.account?.username;
  const label = username || t("settingsX.cloudAccount.signInAccount");
  const accessibleLabel = username ? `${t("settingsX.cloudAccount.manage")}: ${username}` : label;
  const detail = unavailable
    ? t("settingsX.cloudAccount.unavailable")
    : status.state === "signed-in"
      ? t("settingsX.cloudAccount.signedIn")
      : status.state === "signing-in"
        ? t("settingsX.cloudAccount.signingIn")
        : status.state === "storage-error"
          ? t("settingsX.cloudAccount.storageError")
          : t("settingsX.cloudAccount.localMode");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-lg text-muted-foreground"
          aria-label={accessibleLabel}
          aria-describedby={detailId}
          title={`${accessibleLabel}\n${detail}`}
        >
          <span
            className="flex size-6 items-center justify-center rounded-full border border-border/70 bg-muted text-xs font-semibold text-foreground"
            aria-hidden
          >
            {username ? Array.from(username)[0]?.toUpperCase() : <UserRound size={14} />}
          </span>
        </Button>
      </DialogTrigger>
      <span id={detailId} className="sr-only">
        {detail}
      </span>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        <DialogHeader className="pr-6 text-left">
          <DialogTitle>{t("settingsX.cloudAccount.manage")}</DialogTitle>
          <DialogDescription>{t("settingsX.cloudAccount.optional")}</DialogDescription>
        </DialogHeader>
        <CloudAccountSettings embedded />
      </DialogContent>
    </Dialog>
  );
}
