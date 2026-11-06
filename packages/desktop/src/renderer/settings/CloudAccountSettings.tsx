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

export function CloudAccountSettings({
  embedded = false,
  onOpenLink,
}: {
  embedded?: boolean;
  onOpenLink?: () => void;
}) {
  const { t } = useT();
  const toast = useToast();
  const [status, setStatus] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [origin, setOrigin] = useState(DEFAULT_CLOUD_ACCOUNT_ORIGIN);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectGitHub, setConnectGitHub] = useState(false);
  const [githubLinkDefaultCheck, setGitHubLinkDefaultCheck] = useState<
    "checking" | "ready" | "failed"
  >("checking");
  const githubLinkDefaultOverrideRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false);
  const busyRef = useRef(false);
  const statusRevisionRef = useRef(0);
  const accountIdentityRef = useRef("");
  const authorityGenerationRef = useRef(0);
  const [authorityGeneration, setAuthorityGeneration] = useState(0);
  const applyStatus = (next: CloudAccountStatus) => {
    if (next.state === "signed-in") {
      githubLinkDefaultOverrideRef.current = true;
      setConnectGitHub(false);
    }
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
  // Inspect only saved, masked global Link records. Presence preserves the
  // user's existing connection even when its secret or authorization needs repair.
  useEffect(() => {
    let active = true;
    let settled = false;
    const finish = (hasSavedGitHub?: boolean) => {
      if (!active || settled) return;
      settled = true;
      clearTimeout(timer);
      setGitHubLinkDefaultCheck(hasSavedGitHub === undefined ? "failed" : "ready");
      if (!githubLinkDefaultOverrideRef.current) setConnectGitHub(hasSavedGitHub === false);
    };
    const timer = setTimeout(() => finish(), 3_000);
    void Promise.resolve()
      .then(() => window.codeshell.credentials.list(""))
      .then((credentials) =>
        finish(
          credentials.some((credential) => {
            if (
              credential.storeScope === "project" ||
              (credential.type !== "link" && credential.type !== "oauth")
            )
              return false;
            const provider =
              credential.meta?.linkProvider ??
              credential.meta?.oauthProvider ??
              (credential.id === "github-oauth" ? "github" : undefined);
            return provider === "github";
          }),
        ),
      )
      .catch(() => finish());
    return () => {
      active = false;
      clearTimeout(timer);
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
      void window.codeshell.accountFeatures?.refresh(serviceOrigin).catch(() => undefined);
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
  const browserLoginAvailable = capabilities?.browserLoginEnabled === true;
  const githubLinkDefaultPending = githubLinkDefaultCheck === "checking";
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
    !!origin.trim() && validUsername && password.length >= 12 && password.length <= 1024;
  const signIn = () => {
    if (pending || busyRef.current || !canSubmit) return;
    const input = { origin: origin.trim().replace(/\/$/, ""), username: username.trim(), password };
    setPassword("");
    void act(() => window.codeshell.cloudAccount.login(input), { password: true });
  };
  return (
    <section
      className={`flex min-w-0 flex-col gap-6 ${embedded ? "" : "mb-6 w-full max-w-3xl"}`}
      aria-label={t("settingsX.cloudAccount.title")}
    >
      {!embedded && !status.account && (
        <div className="space-y-2">
          <h3 className="m-0 text-base font-semibold">{t("settingsX.cloudAccount.title")}</h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {t("settingsX.cloudAccount.optional")}
          </p>
        </div>
      )}
      <div className="space-y-3">
        <p role="status" className="text-sm leading-6">
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
            className="space-y-1 text-sm leading-6"
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
        {status.state === "signing-in" && !passwordOperation && (
          <p className="text-sm leading-6 text-muted-foreground" role="status">
            {t("settingsX.cloudAccount.browserPending")}
          </p>
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
        ) : !capabilities.githubEnabled ||
          (!status.account && !capabilities.registrationAllowed) ? (
          <div className="space-y-1 text-sm text-muted-foreground" role="status">
            {!capabilities.githubEnabled && <p>{t("settingsX.cloudAccount.githubUnavailable")}</p>}
            {!status.account && !capabilities.registrationAllowed && (
              <p>{t("settingsX.cloudAccount.registrationUnavailable")}</p>
            )}
          </div>
        ) : null}
      </div>
      {status.account ? (
        <div className="space-y-6 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold"
              >
                {Array.from(
                  status.account.displayName || status.account.username,
                )[0]?.toUpperCase()}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="break-words text-base font-semibold">
                  {status.account.displayName || status.account.username}
                </p>
                <p className="break-all text-xs leading-5 text-muted-foreground">
                  @{status.account.username}
                </p>
                <p className="break-all text-xs leading-5 text-muted-foreground">{status.origin}</p>
              </div>
            </div>
            <Button variant="outline" disabled={pending} onClick={() => void logout()}>
              {t("settingsX.cloudAccount.logout")}
            </Button>
          </div>
          {status.state === "signed-in" && status.origin && (
            <details className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer font-medium">
                {t("settingsX.cloudAccount.editProfile")}
              </summary>
              <div className="pt-4">
                <CloudAccountProfile
                  key={`profile:${authorityGeneration}`}
                  account={status.account}
                  identity={{ origin: status.origin, accountId: status.account.id }}
                  enabled={capabilities?.profileEnabled === true}
                  pending={pending}
                  current={() => authorityGenerationRef.current === authorityGeneration}
                />
              </div>
            </details>
          )}
          <section
            className="space-y-3 rounded-lg border border-border p-4"
            aria-label={t("settingsX.cloudAccount.webManagement")}
          >
            <h4 className="font-medium">{t("settingsX.cloudAccount.webManagement")}</h4>
            <p className="leading-6 text-muted-foreground">
              {t("settingsX.cloudAccount.webManagementHint")}
            </p>
            <div className="flex flex-wrap gap-2">
              {(["profile", "security", "sessions", "connections"] as const).map((section) => (
                <Button
                  key={section}
                  variant="outline"
                  disabled={pending || status.state !== "signed-in"}
                  onClick={() =>
                    void act(() => window.codeshell.cloudAccount.openManagement(section))
                  }
                >
                  {t(`settingsX.cloudAccount.webManagement_${section}`)}
                </Button>
              ))}
            </div>
          </section>
          {onOpenLink && (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <h4 className="font-medium">{t("settingsX.cloudAccount.localLinks")}</h4>
              <p className="leading-6 text-muted-foreground">
                {t("settingsX.cloudAccount.localLinksHint")}
              </p>
              <Button variant="outline" disabled={pending} onClick={onOpenLink}>
                {t(
                  status.githubConnection?.state === "failed" ||
                    status.githubConnection?.state === "skipped"
                    ? "settingsX.cloudAccount.retryGitHubConnection"
                    : "settingsX.cloudAccount.manageLocalLinks",
                )}
              </Button>
            </section>
          )}
          {!browserLoginAvailable && (
            <div className="space-y-3 border-t border-border pt-6">
              <h4 className="font-medium">{t("settingsX.cloudAccount.loginMethods")}</h4>
              <p className="leading-6 text-muted-foreground">
                {t("settingsX.cloudAccount.linkDescription")}
              </p>
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
          )}
          {status.state === "signed-in" && status.origin && (
            <CloudAccountLinks
              key={authorityGeneration}
              identity={{ origin: status.origin, accountId: status.account.id }}
              enabled={capabilities?.linkManagementEnabled === true}
              pending={pending}
              autoLoad
              refreshKey={status.githubConnection?.state}
              current={() => authorityGenerationRef.current === authorityGeneration}
            />
          )}
        </div>
      ) : (
        <div className="w-full max-w-lg space-y-5">
          <label className="block space-y-2 text-sm">
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
          {browserLoginAvailable ? (
            <div className="space-y-3">
              <Button
                className="w-full"
                disabled={pending || !origin.trim()}
                onClick={() =>
                  void act(() =>
                    window.codeshell.cloudAccount.signInWithBrowser({ origin: serviceOrigin }),
                  )
                }
              >
                {t("settingsX.cloudAccount.browserLogin")}
              </Button>
              <p className="text-sm leading-6 text-muted-foreground">
                {t("settingsX.cloudAccount.browserLoginHint")}
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3 border-b border-border/70 pb-6">
                <Button
                  type="button"
                  className="w-full"
                  disabled={
                    pending ||
                    (githubLinkAvailable && githubLinkDefaultPending) ||
                    !origin.trim() ||
                    !capabilities?.githubEnabled
                  }
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
                    disabled={pending || githubLinkDefaultPending || !githubLinkAvailable}
                    onChange={(event) => {
                      githubLinkDefaultOverrideRef.current = true;
                      setConnectGitHub(event.target.checked);
                    }}
                    aria-describedby={`${helpId}-github-connection`}
                  />
                  {t("settingsX.cloudAccount.connectGitHub")}
                </label>
                <p
                  id={`${helpId}-github-connection`}
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {t(
                    !capabilities
                      ? "settingsX.cloudAccount.connectGitHubChecking"
                      : !capabilities.githubEnabled
                        ? "settingsX.cloudAccount.githubUnavailable"
                        : !githubLinkAvailable
                          ? "settingsX.cloudAccount.connectGitHubUnavailable"
                          : githubLinkDefaultPending
                            ? "settingsX.cloudAccount.connectGitHubDefaultChecking"
                            : githubLinkDefaultCheck === "failed"
                              ? "settingsX.cloudAccount.connectGitHubDefaultUnavailable"
                              : "settingsX.cloudAccount.connectGitHubDescription",
                  )}
                </p>
                {capabilities?.githubEnabled && (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t(
                      capabilities.registrationAllowed
                        ? "settingsX.cloudAccount.githubCreatesAccount"
                        : "settingsX.cloudAccount.githubExistingOnly",
                    )}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !capabilities?.registrationAllowed}
                  onClick={() =>
                    void act(() => window.codeshell.cloudAccount.openRegistration(serviceOrigin))
                  }
                >
                  {t("accountFeatures.registration")}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t("accountFeatures.registrationHint")}
                </p>
              </div>
              <form
                className="space-y-4"
                // canSubmit validates the trimmed username, including when Enter
                // submits a pasted value before the input has lost focus.
                noValidate
                aria-label={t("settingsX.cloudAccount.passwordLogin")}
                onSubmit={(event) => {
                  event.preventDefault();
                  signIn();
                }}
              >
                <label className="block space-y-2 text-sm">
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
                  />
                </label>
                <label className="block space-y-2 text-sm">
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
                    autoComplete="current-password"
                  />
                </label>
                <Button type="submit" disabled={pending || !canSubmit}>
                  {t("settingsX.cloudAccount.login")}
                </Button>
              </form>
            </>
          )}
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
