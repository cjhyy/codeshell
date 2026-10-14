import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import { useT } from "../i18n/I18nProvider";
import { CloudAccountSettings } from "../settings/CloudAccountSettings";
import { SettingsMenu, type SettingsMenuProps } from "../settings/SettingsMenu";
import { useToast } from "../ui/ToastProvider";

type Props = Omit<SettingsMenuProps, "account" | "trigger" | "sidebarCollapsed">;

/** Global account access stays visible even when no project or chat is open. */
export function AccountSidebarEntry(props: Props) {
  const { t } = useT();
  const toast = useToast();
  const [status, setStatus] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const loggingOutRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const statusRevisionRef = useRef(0);
  const activeRef = useRef(false);
  const detailId = useId();

  useEffect(() => {
    let active = true;
    activeRef.current = true;
    let receivedStatus = false;
    const api = window.codeshell.cloudAccount;
    const unsubscribe = api.onStatus((next) => {
      if (!active) return;
      receivedStatus = true;
      statusRevisionRef.current += 1;
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
      activeRef.current = false;
      unsubscribe();
    };
  }, []);

  const username = status.account?.username;
  const name = status.account?.displayName || username;
  const label = name || t("settingsX.cloudAccount.signInAccount");
  const accessibleLabel = name ? `${t("settingsX.cloudAccount.manage")}: ${name}` : label;
  const detail = unavailable
    ? t("settingsX.cloudAccount.unavailable")
    : status.state === "signed-in"
      ? t("settingsX.cloudAccount.signedIn")
      : status.state === "signing-in"
        ? t("settingsX.cloudAccount.signingIn")
        : status.state === "storage-error"
          ? t("settingsX.cloudAccount.storageError")
          : t("settingsX.cloudAccount.localMode");
  const logoutDisabled =
    loggingOut || status.state === "signing-in" || status.githubConnection?.state === "pending";
  const logout = async () => {
    if (loggingOutRef.current || logoutDisabled) return;
    loggingOutRef.current = true;
    setLoggingOut(true);
    try {
      await window.codeshell.cloudAccount.logout();
      // Refresh services that do not emit an event, without overwriting a newer
      // account event that arrives while this local snapshot is in transit.
      const revision = statusRevisionRef.current;
      const next = await window.codeshell.cloudAccount.status().catch((error) => {
        if (revision !== statusRevisionRef.current) return undefined;
        throw error;
      });
      if (activeRef.current && revision === statusRevisionRef.current && next) {
        setStatus(next);
        setUnavailable(false);
      }
    } catch (error) {
      if (activeRef.current) {
        toast({
          message: error instanceof Error ? error.message : t("settingsX.cloudAccount.failed"),
          variant: "error",
        });
      }
    } finally {
      loggingOutRef.current = false;
      if (activeRef.current) setLoggingOut(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <SettingsMenu
        {...props}
        account={{
          label,
          username,
          detail,
          onManage: () => setOpen(true),
          onLogout:
            status.account || status.state === "storage-error" ? () => void logout() : undefined,
          logoutDisabled,
        }}
        trigger={
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            className="h-10 w-full min-w-0 justify-start gap-2.5 rounded-lg px-2 text-sm text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
            aria-label={accessibleLabel}
            aria-describedby={detailId}
            title={`${accessibleLabel}\n${detail}`}
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted text-xs font-semibold text-foreground"
              aria-hidden
            >
              {name ? Array.from(name)[0]?.toUpperCase() : <UserRound size={14} />}
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-foreground">{label}</span>
            <ChevronDown size={14} className="shrink-0" aria-hidden />
          </Button>
        }
      />
      <span id={detailId} className="sr-only">
        {detail}
      </span>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus({ preventScroll: true });
        }}
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
