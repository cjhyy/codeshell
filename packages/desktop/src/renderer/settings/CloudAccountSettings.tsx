import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import {
  DEFAULT_CLOUD_ACCOUNT_ORIGIN,
  type CloudAccountCapabilities,
  type CloudAccountStatus,
} from "../../shared/cloud-account.js";

export function CloudAccountSettings({ embedded = false }: { embedded?: boolean }) {
  const { t } = useT();
  const toast = useToast();
  const [status, setStatus] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [origin, setOrigin] = useState(DEFAULT_CLOUD_ACCOUNT_ORIGIN);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusLoadFailed, setStatusLoadFailed] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [checkVersion, setCheckVersion] = useState(0);
  const [service, setService] = useState<{
    origin: string;
    capabilities?: CloudAccountCapabilities;
    failed?: boolean;
  } | null>(null);
  const serviceOrigin = status.account ? (status.origin ?? "") : origin.trim().replace(/\/$/, "");
  useEffect(() => {
    let active = true;
    let receivedStatus = false;
    const off = window.codeshell.cloudAccount.onStatus((next) => {
      if (!active) return;
      receivedStatus = true;
      setStatusLoadFailed(false);
      setStatus(next);
    });
    void window.codeshell.cloudAccount.status().then(
      (next) => {
        if (active && !receivedStatus) setStatus(next);
      },
      () => {
        if (active && !receivedStatus) setStatusLoadFailed(true);
      },
    );
    return () => {
      active = false;
      off();
    };
  }, []);
  // The account form is opened explicitly; the persistent sidebar and local
  // sign-in snapshot never contact the service. Debounce edits and fence replies
  // so capabilities from a previous address cannot enable this one's buttons.
  useEffect(() => {
    let active = true;
    setService(null);
    setOperationError("");
    if (!serviceOrigin) return;
    const timer = setTimeout(() => {
      void window.codeshell.cloudAccount.capabilities(serviceOrigin).then(
        (capabilities) => {
          if (active) setService({ origin: serviceOrigin, capabilities });
        },
        () => {
          if (active) setService({ origin: serviceOrigin, failed: true });
        },
      );
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [serviceOrigin, checkVersion]);
  const capabilities = service?.origin === serviceOrigin ? service.capabilities : undefined;
  const capabilityCheckFailed = service?.origin === serviceOrigin && service.failed;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setOperationError("");
    try {
      await work();
      setStatus(await window.codeshell.cloudAccount.status());
      setStatusLoadFailed(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settingsX.cloudAccount.failed");
      setOperationError(message);
      toast({
        message,
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
    <section
      className={`flex min-w-0 flex-col gap-3 ${embedded ? "" : "mb-6"}`}
      aria-label={t("settingsX.cloudAccount.title")}
    >
      {!embedded && (
        <>
          <h3 className="m-0 text-[0.95rem] font-semibold">{t("settingsX.cloudAccount.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("settingsX.cloudAccount.optional")}</p>
        </>
      )}
      <p role="status" className="text-sm">
        {statusLoadFailed
          ? t("settingsX.cloudAccount.unavailable")
          : t(`settingsX.cloudAccount.state_${status.state}`)}
      </p>
      {operationError && (
        <p role="alert" className="text-sm text-status-err">
          {operationError}
        </p>
      )}
      {!capabilities ? (
        <div className="space-y-2 text-sm text-muted-foreground" role="status">
          <p>
            {t(
              !serviceOrigin
                ? "settingsX.cloudAccount.enterOrigin"
                : capabilityCheckFailed
                  ? "settingsX.cloudAccount.capabilitiesFailed"
                  : "settingsX.cloudAccount.checking",
            )}
          </p>
          {capabilityCheckFailed && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setCheckVersion((v) => v + 1)}
            >
              {t("settingsX.cloudAccount.checkAgain")}
            </Button>
          )}
        </div>
      ) : !capabilities.githubEnabled || (!status.account && !capabilities.registrationAllowed) ? (
        <div className="space-y-1 text-sm text-muted-foreground" role="status">
          {!capabilities.githubEnabled && <p>{t("settingsX.cloudAccount.githubUnavailable")}</p>}
          {!status.account && !capabilities.registrationAllowed && (
            <p>{t("settingsX.cloudAccount.registrationUnavailable")}</p>
          )}
        </div>
      ) : null}
      {status.account ? (
        <div className="space-y-2 text-sm">
          <p className="break-all">
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
              disabled={pending || !capabilities?.githubEnabled}
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
              disabled={
                pending ||
                !capabilities?.registrationAllowed ||
                !origin.trim() ||
                !username.trim() ||
                password.length < 12
              }
              onClick={() => signIn("register")}
            >
              {t("settingsX.cloudAccount.register")}
            </Button>
            <Button
              variant="outline"
              disabled={pending || !origin.trim() || !capabilities?.githubEnabled}
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
