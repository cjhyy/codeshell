import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
  const [nameEdited, setNameEdited] = useState(false);
  const [connectAtStartup, setConnectAtStartup] = useState(true);
  const [saving, setSaving] = useState(false);
  const [account, setAccount] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [phoneQr, setPhoneQr] = useState<string | undefined>();
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
  // Offer the computer's own name until the user types one.
  useEffect(() => {
    if (!nameEdited) setName(status.registered && status.name ? status.name : status.suggestedName);
  }, [nameEdited, status.registered, status.name, status.suggestedName]);
  const signedIn = account.state === "signed-in" && !!account.origin;
  // The account directory lists every computer of the signed-in account; it
  // carries no credential, so it is safe to show as a QR code.
  const phoneEntry =
    status.registered && status.accountId && status.relayOrigin
      ? `${status.relayOrigin}/`
      : undefined;
  useEffect(() => {
    if (!phoneEntry) {
      setPhoneQr(undefined);
      return;
    }
    let cancelled = false;
    void import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(phoneEntry, { width: 180, margin: 1 }))
      .then((url) => {
        if (!cancelled) setPhoneQr(url);
      })
      .catch(() => {
        if (!cancelled) setPhoneQr(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [phoneEntry]);
  const reportError = (error: unknown) =>
    toast({
      message: error instanceof Error ? error.message : t("settingsX.adv.relayFailed"),
      variant: "error",
    });
  const enrollAccount = async () => {
    if (account.state !== "signed-in" || !account.origin) return;
    setSaving(true);
    try {
      await window.codeshell.mobileRemote.relay.enroll({
        relayOrigin: account.origin,
        authorization: "account",
        name: name.trim(),
      });
      await window.codeshell.mobileRemote.relay.setAutoConnect(connectAtStartup);
      toast({ message: t("settingsX.adv.relaySaved"), variant: "success" });
      // One step: connecting still requires the passcode, reported if missing.
      await window.codeshell.mobileRemote.start({ mode: "relay" }).catch(reportError);
      await refresh();
    } catch (error) {
      reportError(error);
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
      reportError(error);
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const setAutoConnect = async (enabled: boolean) => {
    setSaving(true);
    try {
      await window.codeshell.mobileRemote.relay.setAutoConnect(enabled);
      await refresh();
    } catch (error) {
      reportError(error);
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
      reportError(error);
    } finally {
      setSaving(false);
    }
  };
  const enrollment = (
    <div className="space-y-3">
      <label className="block space-y-1 text-sm">
        {t("settingsX.adv.relayName")}
        <Input
          value={name}
          onChange={(event) => {
            setNameEdited(true);
            setName(event.target.value);
          }}
          maxLength={signedIn ? 80 : 100}
          disabled={saving || busy}
        />
      </label>
      {signedIn ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsX.adv.relayAccountHint", { origin: account.origin ?? "" })}
          </p>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t("settingsX.adv.relayAutoConnect")}</span>
            <Switch
              checked={connectAtStartup}
              onCheckedChange={setConnectAtStartup}
              disabled={saving || busy}
            />
          </label>
          <Button disabled={saving || busy || !name.trim()} onClick={() => void enrollAccount()}>
            {t("settingsX.adv.relayAccountEnroll")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("settingsX.adv.relaySignInHint")}</p>
      )}
      <details className="space-y-3" open={!signedIn && !status.registered}>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t("settingsX.adv.relayAdvanced")}
        </summary>
        <div className="mt-3 space-y-3">
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
      </details>
    </div>
  );
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{t("settingsX.adv.relayTrust")}</p>
      <p role="status" className="text-sm">
        {t(`settingsX.adv.relayState_${status.state}`)}
      </p>
      {status.registered ? (
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <p>
              {status.name} · {status.relayOrigin}
            </p>
            <p className="break-all text-xs text-muted-foreground">{status.publicOrigin}</p>
          </div>
          <label className="flex items-center justify-between gap-3">
            <span className="space-y-0.5">
              <span className="block">{t("settingsX.adv.relayAutoConnect")}</span>
              <span className="block text-xs text-muted-foreground">
                {t("settingsX.adv.relayAutoConnectHint")}
              </span>
            </span>
            <Switch
              checked={status.autoConnect}
              onCheckedChange={(enabled) => void setAutoConnect(enabled)}
              disabled={saving}
            />
          </label>
          {phoneEntry ? (
            <div className="space-y-2">
              <p>{t("settingsX.adv.relayPhoneEntry")}</p>
              <p className="text-xs text-muted-foreground">
                {t("settingsX.adv.relayPhoneEntryHint")}
              </p>
              {phoneQr ? (
                <img
                  src={phoneQr}
                  alt={t("settingsX.adv.relayPhoneEntry")}
                  className="h-[180px] w-[180px] rounded bg-white p-1"
                />
              ) : null}
              <p className="break-all text-xs text-muted-foreground select-all">{phoneEntry}</p>
            </div>
          ) : null}
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
      {status.registered ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {t("settingsX.adv.relayReenroll")}
          </summary>
          <div className="mt-3">{enrollment}</div>
        </details>
      ) : (
        enrollment
      )}
    </div>
  );
}
