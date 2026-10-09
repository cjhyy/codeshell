import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import {
  DEFAULT_CLOUD_ACCOUNT_ORIGIN,
  type CloudAccountStatus,
} from "../../shared/cloud-account.js";

export function CloudAccountSettings() {
  const { t } = useT();
  const toast = useToast();
  const [status, setStatus] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [origin, setOrigin] = useState(DEFAULT_CLOUD_ACCOUNT_ORIGIN);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void window.codeshell.cloudAccount.status().then((next) => {
      if (active) setStatus(next);
    });
    const off = window.codeshell.cloudAccount.onStatus(setStatus);
    return () => {
      active = false;
      off();
    };
  }, []);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      setStatus(await window.codeshell.cloudAccount.status());
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : t("settingsX.cloudAccount.failed"),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  const signIn = (kind: "login" | "register") => {
    const input = { origin: origin.trim().replace(/\/$/, ""), username: username.trim(), password };
    setPassword("");
    void act(() => window.codeshell.cloudAccount[kind](input));
  };
  const pending = busy || status.state === "signing-in";
  return (
    <section className="mb-6 flex flex-col gap-3" aria-label={t("settingsX.cloudAccount.title")}>
      <h3 className="m-0 text-[0.95rem] font-semibold">{t("settingsX.cloudAccount.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("settingsX.cloudAccount.optional")}</p>
      <p role="status" className="text-sm">
        {t(`settingsX.cloudAccount.state_${status.state}`)}
      </p>
      {status.account ? (
        <div className="space-y-2 text-sm">
          <p>
            {status.account.username} · {status.origin}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void act(() => window.codeshell.cloudAccount.logout())}
            >
              {t("settingsX.cloudAccount.logout")}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void act(() => window.codeshell.cloudAccount.linkGitHub())}
            >
              {t("settingsX.cloudAccount.linkGitHub")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-lg space-y-3">
          <label className="block space-y-1 text-sm">
            {t("settingsX.cloudAccount.origin")}
            <Input
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              maxLength={2048}
              placeholder={DEFAULT_CLOUD_ACCOUNT_ORIGIN}
              disabled={pending}
              autoComplete="url"
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t("settingsX.cloudAccount.username")}
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={64}
              disabled={pending}
              autoComplete="username"
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t("settingsX.cloudAccount.password")}
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={1024}
              disabled={pending}
              autoComplete="current-password"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={pending || !origin.trim() || !username.trim() || password.length < 12}
              onClick={() => signIn("login")}
            >
              {t("settingsX.cloudAccount.login")}
            </Button>
            <Button
              variant="outline"
              disabled={pending || !origin.trim() || !username.trim() || password.length < 12}
              onClick={() => signIn("register")}
            >
              {t("settingsX.cloudAccount.register")}
            </Button>
            <Button
              variant="outline"
              disabled={pending || !origin.trim()}
              onClick={() =>
                void act(() =>
                  window.codeshell.cloudAccount.signInWithGitHub({
                    origin: origin.trim().replace(/\/$/, ""),
                  }),
                )
              }
            >
              {t("settingsX.cloudAccount.github")}
            </Button>
          </div>
        </div>
      )}
      {pending ? (
        <Button
          className="self-start"
          variant="outline"
          onClick={() => void window.codeshell.cloudAccount.cancelSignIn()}
        >
          {t("settingsX.cloudAccount.cancel")}
        </Button>
      ) : null}
      {status.state === "storage-error" ? (
        <Button
          className="self-start"
          variant="outline"
          onClick={() => void act(() => window.codeshell.cloudAccount.logout())}
        >
          {t("settingsX.cloudAccount.logout")}
        </Button>
      ) : null}
    </section>
  );
}
