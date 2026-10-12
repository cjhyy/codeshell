import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CloudAccountIdentity } from "../../shared/cloud-account.js";
import {
  normalizeCloudDisplayName,
  normalizeCloudUsername,
} from "../../shared/cloud-account-profile.js";
import { useT } from "../i18n/I18nProvider";

export function CloudAccountProfile({
  identity,
  account,
  enabled,
  pending,
  current,
}: {
  identity: { origin: string; accountId: string };
  account: CloudAccountIdentity;
  enabled: boolean;
  pending: boolean;
  current: () => boolean;
}) {
  const { t } = useT();
  const id = useId();
  const [displayName, setDisplayName] = useState(account.displayName ?? account.username);
  const [username, setUsername] = useState(account.username);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const active = useRef(true);
  const busyRef = useRef(false);
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    setDisplayName(account.displayName ?? account.username);
    setUsername(account.username);
  }, [account.displayName, account.username]);
  const errorMessage = (cause: unknown) => {
    const text =
      cause instanceof Error
        ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
        : "";
    const key = text.includes("昵称需为")
      ? "displayNameInvalid"
      : text.includes("用户名需为")
        ? "profileUsernameInvalid"
        : text.includes("用户名已被使用")
          ? "profileUsernameUnavailable"
          : text.includes("无法保存到本机")
            ? "profileStorageFailed"
            : text.includes("尚未启用账号资料")
              ? "profileUnavailable"
              : text.includes("授权已失效") ||
                  text.includes("授权已过期") ||
                  text.includes("请先登录")
                ? "profileAuthFailed"
                : "profileFailed";
    return t(`settingsX.cloudAccount.${key}`);
  };
  useEffect(() => {
    active.current = true;
    let live = true;
    setError("");
    busyRef.current = false;
    setBusy(false);
    if (enabled) {
      busyRef.current = true;
      setBusy(true);
      void window.codeshell.cloudAccount
        .profile({ ...identity, action: "read" })
        .then(
          () => {},
          (cause) => {
            if (live && currentRef.current()) setError(errorMessage(cause));
          },
        )
        .finally(() => {
          if (live) {
            busyRef.current = false;
            setBusy(false);
          }
        });
    }
    return () => {
      live = false;
      active.current = false;
    };
  }, [identity.origin, identity.accountId, enabled]);
  const normalizedName = normalizeCloudDisplayName(displayName);
  const normalizedUsername = normalizeCloudUsername(username);
  const dirty =
    normalizedName !== (account.displayName ?? account.username) ||
    normalizedUsername !== account.username;
  const disabled = !enabled || pending || busy;
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-3"
      noValidate
      aria-label={t("settingsX.cloudAccount.profileTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          disabled ||
          busyRef.current ||
          !normalizedName ||
          !normalizedUsername ||
          !dirty ||
          !current()
        )
          return;
        busyRef.current = true;
        setBusy(true);
        setError("");
        setMessage("");
        void window.codeshell.cloudAccount
          .profile({
            ...identity,
            action: "update",
            displayName: normalizedName,
            username: normalizedUsername,
          })
          .then(
            () => {
              if (active.current && current()) setMessage(t("settingsX.cloudAccount.profileSaved"));
            },
            (cause) => {
              if (active.current && current()) setError(errorMessage(cause));
            },
          )
          .finally(() => {
            if (active.current) {
              busyRef.current = false;
              setBusy(false);
            }
          });
      }}
    >
      <p className="font-medium">{t("settingsX.cloudAccount.profileTitle")}</p>
      <label className="block space-y-1">
        {t("settingsX.cloudAccount.displayName")}
        <Input
          name="displayName"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={disabled}
          autoComplete="nickname"
          aria-describedby={`${id}-displayName`}
          aria-invalid={!!displayName && !normalizedName}
        />
      </label>
      <p id={`${id}-displayName`} className="text-xs text-muted-foreground">
        {t("settingsX.cloudAccount.displayNameHelp")}
      </p>
      {!!displayName && !normalizedName && (
        <p className="text-xs text-status-err" role="alert">
          {t("settingsX.cloudAccount.displayNameInvalid")}
        </p>
      )}
      <label className="block space-y-1">
        {t("settingsX.cloudAccount.loginUsername")}
        <Input
          name="profileUsername"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={disabled}
          maxLength={128}
          autoComplete="username"
          aria-describedby={`${id}-username`}
          aria-invalid={!!username && !normalizedUsername}
        />
      </label>
      <p id={`${id}-username`} className="text-xs text-muted-foreground">
        {t("settingsX.cloudAccount.profileUsernameHelp")}
      </p>
      {!!username && !normalizedUsername && (
        <p className="text-xs text-status-err" role="alert">
          {t("settingsX.cloudAccount.profileUsernameInvalid")}
        </p>
      )}
      {!enabled && (
        <p className="text-xs text-muted-foreground">
          {t("settingsX.cloudAccount.profileUnavailable")}
        </p>
      )}
      {error && (
        <p className="text-sm text-status-err" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="text-sm" role="status">
          {message}
        </p>
      )}
      <Button type="submit" disabled={disabled || !normalizedName || !normalizedUsername || !dirty}>
        {t(busy ? "settingsX.cloudAccount.profileSaving" : "settingsX.cloudAccount.profileSave")}
      </Button>
    </form>
  );
}
