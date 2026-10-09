import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/ConfirmDialog";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import type { DesktopRelayStatus } from "../../shared/device-relay.js";

export function DeviceRelaySettings({
  status,
  busy,
  refresh,
}: {
  status: DesktopRelayStatus;
  busy: boolean;
  refresh: () => Promise<unknown>;
}) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [origin, setOrigin] = useState("");
  const [ticket, setTicket] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [account, setAccount] = useState<CloudAccountStatus>({ state: "signed-out" });
  useEffect(() => {
    let active = true;
    void window.codeshell.cloudAccount.status().then((next) => {
      if (active) setAccount(next);
    });
    const off = window.codeshell.cloudAccount.onStatus(setAccount);
    return () => {
      active = false;
      off();
    };
  }, []);
  const enrollAccount = async () => {
    if (account.state !== "signed-in" || !account.origin) return;
    setSaving(true);
    try {
      await window.codeshell.mobileRemote.relay.enroll({
        relayOrigin: account.origin,
        authorization: "account",
        name: name.trim(),
      });
      await refresh();
      toast({ message: t("settingsX.adv.relaySaved"), variant: "success" });
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : t("settingsX.adv.relayFailed"),
        variant: "error",
      });
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const enroll = async () => {
    setSaving(true);
    const input = {
      relayOrigin: origin.trim().replace(/\/$/, ""),
      ticket: ticket.trim(),
      name: name.trim(),
    };
    setTicket("");
    try {
      await window.codeshell.mobileRemote.relay.enroll(input);
      await refresh();
      toast({ message: t("settingsX.adv.relaySaved"), variant: "success" });
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : t("settingsX.adv.relayFailed"),
        variant: "error",
      });
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const forget = async () => {
    if (
      !(await confirm({
        title: t("settingsX.adv.relayForget"),
        message: t("settingsX.adv.relayForgetHint"),
        confirmLabel: t("settingsX.adv.relayForget"),
        destructive: true,
      }))
    )
      return;
    setSaving(true);
    try {
      await window.codeshell.mobileRemote.relay.forget();
      await refresh();
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : t("settingsX.adv.relayFailed"),
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{t("settingsX.adv.relayTrust")}</p>
      <p role="status" className="text-sm">
        {t(`settingsX.adv.relayState_${status.state}`)}
      </p>
      {status.registered ? (
        <div className="space-y-1 text-sm">
          <p>
            {status.name} · {status.relayOrigin}
          </p>
          <p className="break-all text-xs text-muted-foreground">{status.publicOrigin}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void forget()}
            disabled={busy || saving}
          >
            {t("settingsX.adv.relayForget")}
          </Button>
        </div>
      ) : null}
      {status.state === "storage-error" ? (
        <Button variant="outline" size="sm" disabled={busy || saving} onClick={() => void forget()}>
          {t("settingsX.adv.relayForget")}
        </Button>
      ) : null}
      <label className="block space-y-1 text-sm">
        {t("settingsX.adv.relayDirectory")}
        <Input
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://directory.example.com"
          maxLength={2048}
          disabled={saving || busy}
        />
      </label>
      <label className="block space-y-1 text-sm">
        {t("settingsX.adv.relayName")}
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          disabled={saving || busy}
        />
      </label>
      {account.state === "signed-in" && account.origin ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsX.adv.relayAccountHint", { origin: account.origin })}
          </p>
          <Button
            variant="outline"
            disabled={saving || busy || !name.trim()}
            onClick={() => void enrollAccount()}
          >
            {t("settingsX.adv.relayAccountEnroll")}
          </Button>
        </div>
      ) : null}
      <label className="block space-y-1 text-sm">
        {t("settingsX.adv.relayTicket")}
        <Input
          type="password"
          autoComplete="off"
          value={ticket}
          onChange={(event) => setTicket(event.target.value)}
          maxLength={128}
          disabled={saving || busy}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t("settingsX.adv.relayTicketHint")}</p>
      <Button
        variant="outline"
        onClick={() => void enroll()}
        disabled={saving || busy || !origin.trim() || !name.trim() || !ticket.trim()}
      >
        {t("settingsX.adv.relayEnroll")}
      </Button>
    </div>
  );
}
