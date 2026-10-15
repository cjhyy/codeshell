import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import { CloudAccountLinks } from "./CloudAccountLinks";
import { CloudAccountProfile } from "./CloudAccountProfile";
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
  const [confirmation, setConfirmation] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [connectGitHub, setConnectGitHub] = useState(true);
  const [busy, setBusy] = useState(false);
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false);
  const busyRef = useRef(false);
  const statusRevisionRef = useRef(0);
  const accountIdentityRef = useRef("");
  const authorityGenerationRef = useRef(0);
  const [authorityGeneration, setAuthorityGeneration] = useState(0);
  const applyStatus = (next: CloudAccountStatus) => {
    if (next.account) setLogoutUnconfirmed(false);
    const identity =
      next.state === "signed-in" && next.account ? `${next.origin}\n${next.account.id}` : "";
    if (accountIdentityRef.current !== identity) {
      accountIdentityRef.current = identity;
      authorityGenerationRef.current += 1;
      setAuthorityGeneration(authorityGenerationRef.current);
    }
    setStatus(next);
  };
  const [passwordOperation, setPasswordOperation] = useState(false);
  const helpId = useId();
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
      statusRevisionRef.current += 1;
      setStatusLoadFailed(false);
      applyStatus(next);
    });
    void window.codeshell.cloudAccount.status().then(
      (next) => {
        if (active && !receivedStatus) applyStatus(next);
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
  const githubLinkAvailable =
    capabilities?.githubEnabled === true && capabilities.githubLinkEnabled === true;
  const githubConnectionPending = status.githubConnection?.state === "pending";
  const act = async (
    work: () => Promise<unknown>,
    options: { password?: boolean; success?: string } = {},
  ) => {
    if (busyRef.current || status.state === "signing-in" || githubConnectionPending) return;
    busyRef.current = true;
    setPasswordOperation(!!options.password);
    setBusy(true);
    setOperationError("");
    try {
      await work();
      const revision = statusRevisionRef.current;
      const next = await window.codeshell.cloudAccount.status().catch((error) => {
        if (revision !== statusRevisionRef.current) return undefined;
        throw error;
      });
      // A background GitHub connection can finish while this snapshot is in
      // transit. Preserve any newer status event instead of restoring pending.
      if (next && revision === statusRevisionRef.current) applyStatus(next);
      setStatusLoadFailed(false);
      if (options.success) toast({ message: options.success, variant: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settingsX.cloudAccount.failed");
      setOperationError(message);
      toast({
        message,
        variant: "error",
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPasswordOperation(false);
    }
  };
  const pending = busy || status.state === "signing-in" || githubConnectionPending;
  const logout = () => {
    const generation = authorityGenerationRef.current;
    return act(async () => {
      const result = await window.codeshell.cloudAccount.logout();
      // A result for the previous session must not describe a newer signed-in
      // account as signed out while another window has already authenticated.
      if (accountIdentityRef.current && generation !== authorityGenerationRef.current) return;
      setLogoutUnconfirmed(result.revocation === "unconfirmed");
      if (result.revocation === "unconfirmed") {
        toast({
          message: t("settingsX.cloudAccount.logoutUnconfirmed"),
          durationMs: 10_000,
        });
      }
    });
  };
  const validUsername = /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(username.trim());
  const canSubmit =
    !!origin.trim() &&
    validUsername &&
    password.length >= 12 &&
    password.length <= 1024 &&
    (mode === "login" || (!!capabilities?.registrationAllowed && confirmation === password));
  const signIn = (kind: "login" | "register") => {
    if (pending || busyRef.current || !canSubmit) return;
    const input = { origin: origin.trim().replace(/\/$/, ""), username: username.trim(), password };
    setPassword("");
    setConfirmation("");
    void act(() => window.codeshell.cloudAccount[kind](input), { password: true });
  };
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
          : pending && passwordOperation
            ? t("settingsX.cloudAccount.submitting")
            : t(`settingsX.cloudAccount.state_${status.state}`)}
      </p>
      {status.githubConnection && (
        <div
          role="status"
          aria-label={t("settingsX.cloudAccount.githubConnection")}
          className="space-y-1 text-sm"
        >
          <p className="font-medium">{t("settingsX.cloudAccount.githubConnection")}</p>
          <p
            className={
              status.githubConnection.state === "failed"
                ? "text-status-err"
                : "text-muted-foreground"
            }
          >
            {t(`settingsX.cloudAccount.githubConnection_${status.githubConnection.state}`)}
          </p>
        </div>
      )}
      {operationError && (
        <p role="alert" className="text-sm text-status-err">
          {operationError}
        </p>
      )}
      {logoutUnconfirmed && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("settingsX.cloudAccount.logoutUnconfirmed")}
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
            {status.account.displayName || status.account.username} · {status.origin}
          </p>
          {status.state === "signed-in" && status.origin && (
            <CloudAccountProfile
              key={`profile:${authorityGeneration}`}
              account={status.account}
              identity={{ origin: status.origin, accountId: status.account.id }}
              enabled={capabilities?.profileEnabled === true}
              pending={pending}
              current={() => authorityGenerationRef.current === authorityGeneration}
            />
          )}
          <p className="text-muted-foreground">{t("settingsX.cloudAccount.linkDescription")}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={pending} onClick={() => void logout()}>
              {t("settingsX.cloudAccount.logout")}
            </Button>
            <Button
              variant="outline"
              disabled={pending || !capabilities?.githubEnabled}
              onClick={() =>
                void act(() => window.codeshell.cloudAccount.linkGitHub(), {
                  success: t("settingsX.cloudAccount.linked"),
                })
              }
            >
              {t("settingsX.cloudAccount.linkGitHub")}
            </Button>
          </div>
          {status.state === "signed-in" && status.origin && (
            <CloudAccountLinks
              key={authorityGeneration}
              identity={{ origin: status.origin, accountId: status.account.id }}
              enabled={capabilities?.linkManagementEnabled === true}
              pending={pending}
              current={() => authorityGenerationRef.current === authorityGeneration}
            />
          )}
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
          <div className="space-y-2 border-b border-border/70 pb-4">
            <Button
              type="button"
              className="w-full"
              disabled={pending || !origin.trim() || !capabilities?.githubEnabled}
              onClick={() =>
                void act(() =>
                  window.codeshell.cloudAccount.signInWithGitHub({
                    origin: origin.trim().replace(/\/$/, ""),
                    connectGitHub: githubLinkAvailable && connectGitHub,
                  }),
                )
              }
            >
              {t("settingsX.cloudAccount.github")}
            </Button>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={githubLinkAvailable && connectGitHub}
                disabled={pending || !githubLinkAvailable}
                onChange={(event) => setConnectGitHub(event.target.checked)}
                aria-describedby={`${helpId}-github-connection`}
              />
              {t("settingsX.cloudAccount.connectGitHub")}
            </label>
            <p id={`${helpId}-github-connection`} className="text-xs text-muted-foreground">
              {t(
                !capabilities
                  ? "settingsX.cloudAccount.connectGitHubChecking"
                  : !capabilities.githubEnabled
                    ? "settingsX.cloudAccount.githubUnavailable"
                    : githubLinkAvailable
                      ? "settingsX.cloudAccount.connectGitHubDescription"
                      : "settingsX.cloudAccount.connectGitHubUnavailable",
              )}
            </p>
            {capabilities?.githubEnabled && (
              <p className="text-xs text-muted-foreground">
                {t(
                  capabilities.registrationAllowed
                    ? "settingsX.cloudAccount.githubCreatesAccount"
                    : "settingsX.cloudAccount.githubExistingOnly",
                )}
              </p>
            )}
          </div>
          <div
            className="flex gap-2"
            role="group"
            aria-label={t("settingsX.cloudAccount.passwordMethod")}
          >
            <Button
              type="button"
              variant={mode === "login" ? "default" : "ghost"}
              aria-pressed={mode === "login"}
              disabled={pending}
              onClick={() => {
                setMode("login");
                setConfirmation("");
                setOperationError("");
              }}
            >
              {t("settingsX.cloudAccount.passwordLogin")}
            </Button>
            <Button
              type="button"
              variant={mode === "register" ? "default" : "ghost"}
              aria-pressed={mode === "register"}
              disabled={pending || !capabilities?.registrationAllowed}
              onClick={() => {
                setMode("register");
                setConfirmation("");
                setOperationError("");
              }}
            >
              {t("settingsX.cloudAccount.createAccount")}
            </Button>
          </div>
          <form
            className="space-y-3"
            // canSubmit validates the trimmed username, including when Enter
            // submits a pasted value before the input has lost focus.
            noValidate
            aria-label={t(
              mode === "register"
                ? "settingsX.cloudAccount.createAccount"
                : "settingsX.cloudAccount.passwordLogin",
            )}
            onSubmit={(event) => {
              event.preventDefault();
              signIn(mode);
            }}
          >
            <label className="block space-y-1 text-sm">
              {t("settingsX.cloudAccount.username")}
              <Input
                name="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onBlur={() => setUsername((value) => value.trim())}
                required
                minLength={3}
                maxLength={64}
                pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{2,63}"}
                disabled={pending}
                autoComplete="username"
                aria-describedby={mode === "register" ? `${helpId}-username` : undefined}
              />
            </label>
            {mode === "register" && (
              <p id={`${helpId}-username`} className="text-xs text-muted-foreground">
                {t("settingsX.cloudAccount.usernameHelp")}
              </p>
            )}
            <label className="block space-y-1 text-sm">
              {t("settingsX.cloudAccount.password")}
              <Input
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={12}
                maxLength={1024}
                disabled={pending}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
              />
            </label>
            {mode === "register" && (
              <>
                <label className="block space-y-1 text-sm">
                  {t("settingsX.cloudAccount.confirmPassword")}
                  <Input
                    name="password-confirmation"
                    type="password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    required
                    minLength={12}
                    maxLength={1024}
                    disabled={pending}
                    autoComplete="new-password"
                    aria-invalid={!!confirmation && confirmation !== password}
                    aria-describedby={
                      confirmation && confirmation !== password ? `${helpId}-mismatch` : undefined
                    }
                  />
                </label>
                {confirmation && confirmation !== password && (
                  <p id={`${helpId}-mismatch`} className="text-xs text-status-err" role="alert">
                    {t("settingsX.cloudAccount.passwordMismatch")}
                  </p>
                )}
              </>
            )}
            <Button type="submit" disabled={pending || !canSubmit}>
              {t(
                mode === "register"
                  ? "settingsX.cloudAccount.register"
                  : "settingsX.cloudAccount.login",
              )}
            </Button>
          </form>
        </div>
      )}
      {pending ? (
        <Button
          className="self-start"
          variant="outline"
          onClick={() => void window.codeshell.cloudAccount.cancelSignIn()}
        >
          {t(
            githubConnectionPending
              ? "settingsX.cloudAccount.cancelGitHubConnection"
              : "settingsX.cloudAccount.cancel",
          )}
        </Button>
      ) : null}
      {status.state === "storage-error" ? (
        <Button className="self-start" variant="outline" onClick={() => void logout()}>
          {t("settingsX.cloudAccount.logout")}
        </Button>
      ) : null}
    </section>
  );
}
