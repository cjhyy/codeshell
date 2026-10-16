import React from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type {
  LinkConnectionInput,
  LinkProviderView,
  MaskedLinkConnection,
} from "@cjhyy/code-shell-link";
import {
  LinkAuthorizationController,
  LinkAuthorizationStepView,
  safeLinkAuthorizationUrl,
  type LinkAuthorizationLabels,
} from "@cjhyy/code-shell-web";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import type { LinkAuthGuide } from "./link-catalog";
import { linkAuthorizationFailureMessage } from "./linkAuthorizationFailure";
import { LinkServiceIcon } from "./LinkServiceIcon";

/** All secrets stay in the current step form until submitted to the owning Host. */
export function LinkConnectionDialog({
  cwd,
  input,
  providerName,
  icon: _Icon,
  brandClass: _brandClass,
  modes,
  authGuide,
  onClose,
  onConnected,
}: {
  cwd: string;
  input: LinkConnectionInput;
  providerName: string;
  icon: LucideIcon;
  brandClass?: string;
  modes: NonNullable<LinkProviderView["authModes"]>;
  authGuide?: LinkAuthGuide;
  onClose: () => void;
  onConnected: (connection?: MaskedLinkConnection) => void;
}) {
  const { t, lang } = useT();
  const [returnFocus] = React.useState(() => {
    const element = typeof document !== "undefined" ? document.activeElement : null;
    return element && "focus" in element ? (element as HTMLElement) : null;
  });
  const designContext = input.methodId === "mcp";
  const requestId = React.useRef<string | undefined>(undefined);
  const api = window.codeshell.links;
  const initialInput = React.useRef(input).current;
  const lifecycles = React.useRef(new Map<LinkAuthorizationController, number>());
  const controller = React.useMemo(
    () =>
      new LinkAuthorizationController({
        begin: (connectionInput, modeId) => {
          const id = crypto.randomUUID();
          requestId.current = id;
          return api.authorizationStart(cwd, id, connectionInput, modeId);
        },
        status: (id) => api.authorizationGet(cwd, id),
        respond: (id, response) => api.authorizationRespond(cwd, id, response),
        cancel: (id) => api.authorizationCancel(cwd, id),
      }),
    [api, cwd],
  );
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const availableModes = modes.filter((mode) => mode.available);
  const preferred = availableModes.find((mode) => mode.preferred) ?? availableModes[0];
  const [modeId, setModeId] = React.useState(preferred?.id);
  const [advancedModes, setAdvancedModes] = React.useState(false);
  const advancedModesId = React.useId();
  const [switching, setSwitching] = React.useState(false);
  const [openError, setOpenError] = React.useState("");
  const [installing, setInstalling] = React.useState(false);
  const [canInstall, setCanInstall] = React.useState(false);
  const completed = React.useRef<string | undefined>(undefined);
  const authorization = state.authorization;
  const mode = availableModes.find((item) => item.id === modeId);
  const connected = authorization?.state === "connected" && Boolean(authorization.connection);
  const terminal = authorization && authorization.state !== "pending";
  const busy = state.busy || switching || installing;
  const begin = React.useCallback(
    async (nextModeId: string) => {
      setOpenError("");
      await controller.begin(initialInput, nextModeId);
    },
    [controller, initialInput],
  );
  React.useEffect(() => {
    const generation = (lifecycles.current.get(controller) ?? 0) + 1;
    lifecycles.current.set(controller, generation);
    if (preferred) void begin(preferred.id);
    return () => {
      // StrictMode remounts effects synchronously; dispose only a real detach.
      queueMicrotask(() => {
        if (lifecycles.current.get(controller) !== generation) return;
        controller.dispose();
        // Startup may still await its first response, before an attempt ID is known.
        if (requestId.current)
          void api.authorizationCancel(cwd, requestId.current).catch(() => undefined);
      });
    };
    // The dialog is remounted for another connection; language changes never restart a login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);
  React.useEffect(() => {
    if (!connected || !authorization || completed.current === authorization.id) return;
    completed.current = authorization.id;
    onConnected(authorization.connection);
  }, [authorization, connected, onConnected]);
  React.useEffect(() => {
    if (
      mode?.kind !== "local-session" ||
      authorization?.step?.kind !== "local-session" ||
      authorization.step.session.canInstall !== true
    ) {
      setCanInstall(false);
      return;
    }
    let active = true;
    void api
      .cliInstallStatus(input.providerId)
      .then((status) => {
        if (active) setCanInstall(status.supported);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [
    api,
    authorization?.step?.kind,
    authorization?.step?.kind === "local-session" && authorization.step.session.canInstall,
    input.providerId,
    mode?.kind,
  ]);

  const changeMode = async (nextModeId: string) => {
    if (busy || nextModeId === modeId) return;
    setSwitching(true);
    try {
      await controller.cancel();
      if (controller.getSnapshot().authorization?.state === "pending") return;
      setModeId(nextModeId);
      await begin(nextModeId);
    } finally {
      setSwitching(false);
    }
  };
  const close = () => {
    if (!terminal) void controller.cancel();
    onClose();
  };
  const openUrl = (url: string) => {
    if (modeId === "remote-link" && authorization) {
      void api.authorizationOpen(cwd, authorization.id).catch((cause) => {
        setOpenError(cause instanceof Error ? cause.message : String(cause));
      });
      return;
    }
    const safeUrl = safeLinkAuthorizationUrl(url);
    if (!safeUrl) return;
    void window.codeshell.openExternal(safeUrl).catch((cause) => {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const install = async () => {
    if (
      !modeId ||
      busy ||
      !canInstall ||
      authorization?.step?.kind !== "local-session" ||
      authorization.step.session.canInstall !== true ||
      authorization.step.session.installed
    )
      return;
    setInstalling(true);
    setOpenError("");
    try {
      await controller.cancel();
      if (controller.getSnapshot().authorization?.state === "pending") return;
      await api.installCli(input.providerId);
      await begin(modeId);
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  };
  const labels: Partial<LinkAuthorizationLabels> = authorizationLabels(
    lang,
    Boolean(input.resourceUrl) && !designContext,
  );
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="link-authorization-dialog w-[calc(100%-2rem)] max-h-[calc(100vh-2rem)] max-w-[480px] gap-0 overflow-y-auto rounded-2xl p-0"
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return;
          event.preventDefault();
          returnFocus.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="flex-row items-start gap-4 space-y-0 p-6 pr-12 text-left sm:text-left">
          <div
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-xl border sm:size-14",
              connected
                ? "border-status-ok/15 bg-status-ok/8 text-status-ok"
                : "border-border/60 bg-background text-foreground",
            )}
          >
            {connected ? (
              <Check className="size-7" aria-hidden />
            ) : (
              <LinkServiceIcon
                providerId={input.providerId}
                name={providerName}
                className="size-7"
              />
            )}
          </div>
          <div className="min-w-0 space-y-2 pt-0.5">
            <DialogTitle className="text-lg leading-6">
              {t(
                input.resourceUrl && !designContext
                  ? connected
                    ? "ext.link.authorizationFileAddedTitle"
                    : "ext.link.authorizationFileTitle"
                  : connected
                    ? "ext.link.authorizationConnectedTitle"
                    : "ext.link.authorizationTitle",
                {
                  name: providerName,
                },
              )}
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {t(
                designContext
                  ? "ext.link.directory.designContextDescription"
                  : input.resourceUrl
                    ? connected
                      ? "ext.link.authorizationFileAddedDescription"
                      : "ext.link.remoteAddFileDescription"
                    : connected &&
                        input.providerId === "figma" &&
                        !authorization?.connection?.account?.resources.length
                      ? "ext.link.remoteNoFiles"
                      : connected
                        ? "ext.link.authorizationConnectedDescription"
                        : "ext.link.authorizationDescription",
              )}
            </DialogDescription>
          </div>
        </DialogHeader>
        <div
          className="space-y-4 px-6 pb-6"
          aria-live="polite"
          data-link-authorization-step={authorization?.step?.kind}
        >
          {input.resourceUrl && (
            <p className="break-all rounded-lg border border-border/60 bg-muted/35 px-3 py-2 text-xs leading-5">
              {input.resourceUrl}
            </p>
          )}
          {!connected && availableModes.length > 1 && (
            <div className="rounded-lg border border-border/60 p-3">
              <button
                type="button"
                aria-expanded={advancedModes}
                aria-controls={advancedModesId}
                onClick={() => setAdvancedModes((open) => !open)}
                className="flex w-full items-center justify-between gap-2 rounded-sm text-left text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("ext.link.directory.advancedSettings")}
                <ChevronDown
                  aria-hidden
                  className={cn("size-3.5 transition-transform", advancedModes && "rotate-180")}
                />
              </button>
              <div
                id={advancedModesId}
                hidden={!advancedModes}
                className="mt-3 flex flex-wrap gap-1 rounded-lg bg-muted/35 p-1"
                aria-label={t("ext.link.authorizationMethod")}
              >
                {availableModes.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={item.id === modeId}
                    data-link-auth-mode={item.id}
                    disabled={busy}
                    className={cn(
                      "min-h-8 min-w-0 flex-1 rounded-md px-3 py-1.5 text-xs transition-colors disabled:opacity-50",
                      item.id === modeId
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => void changeMode(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 [&_.link-authorization-status]:py-0 [&_.link-authorization-status]:text-left [&_.link-authorization-step]:gap-3 [&_.link-authorization-step]:pt-0 [&_.link-authorization-step]:text-left">
            {(authorization?.step?.kind === "redirect" ||
              authorization?.step?.kind === "processing") && (
              <Loader2
                className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            )}
            <div className="min-w-0 flex-1">
              {authorization ? (
                <LinkAuthorizationStepView
                  authorization={authorization}
                  busy={busy}
                  labels={labels}
                  onRespond={(response) => void controller.respond(response)}
                  onOpenUrl={openUrl}
                  onCopy={(value) =>
                    void navigator.clipboard.writeText(value).catch(() => undefined)
                  }
                />
              ) : (
                <div
                  role="status"
                  className="flex min-h-16 items-center gap-3 text-xs leading-5 text-muted-foreground"
                >
                  {preferred && !state.error ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                  ) : null}
                  {preferred
                    ? t("ext.link.authorizationStarting")
                    : t("ext.link.authorizationUnavailable")}
                </div>
              )}
            </div>
          </div>
          {(authorization?.failure || state.error || openError) && (
            <p
              role="alert"
              data-link-auth-failure-stage={authorization?.failure?.stage}
              className="break-words rounded-lg border border-status-err/20 bg-status-err/8 p-3 text-xs leading-5 text-status-err"
            >
              {linkAuthorizationFailureMessage(authorization?.failure, t) ??
                t("ext.link.authorizationFailure.safeFailure")}
            </p>
          )}
          {authorization?.step?.kind === "local-session" &&
            authorization.step.session.canInstall === true &&
            !authorization.step.session.installed &&
            canInstall && (
              <Button
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => void install()}
              >
                {installing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                {t("ext.link.authorizationInstallCli")}
              </Button>
            )}
          {authorization?.step?.kind === "credential-input" && authGuide && (
            <details className="rounded-lg border border-border/70 p-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">
                {authGuide.title}
              </summary>
              <p className="mt-2 leading-5">{authGuide.summary}</p>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-5">
                {authGuide.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <Button
                variant="link"
                size="sm"
                className="mt-1 h-auto p-0 text-xs"
                onClick={() => openUrl(authGuide.createCredentialUrl)}
              >
                {t("ext.link.openCredentialPage")} <ExternalLink className="size-3" aria-hidden />
              </Button>
            </details>
          )}
          {connected && authorization?.connection && (
            <div className="rounded-xl border border-status-ok/20 bg-status-ok/5 p-4 text-left">
              <p className="text-sm font-medium">
                {authorization.connection.account?.label ?? authorization.connection.label}
              </p>
              {!!authorization.connection.account?.resources.length && (
                <p className="mt-1 break-words text-xs text-muted-foreground">
                  {authorization.connection.account.resources.join(" · ")}
                </p>
              )}
            </div>
          )}
          {!connected && (
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t(
                input.methodId === "remote-link"
                  ? "ext.link.authorizationServerPrivacy"
                  : "ext.link.authorizationHostPrivacy",
              )}
            </p>
          )}
        </div>
        <DialogFooter className="flex-row items-center justify-end gap-2 border-t border-border/60 bg-muted/20 p-6 sm:justify-end sm:space-x-0">
          {connected ? (
            <Button className="min-w-24" onClick={onClose}>
              {t("ext.link.authorizationDone")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" className="min-w-24" onClick={close}>
                {t("common.cancel")}
              </Button>
              {(terminal || (state.error && !authorization)) && modeId && (
                <Button className="min-w-24" disabled={busy} onClick={() => void begin(modeId)}>
                  {t("ext.link.authorizationRetry")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function authorizationLabels(
  lang: "zh" | "en",
  addingFile = false,
): Partial<LinkAuthorizationLabels> {
  return lang === "zh"
    ? {
        submit: "验证并连接",
        openPage: "在系统浏览器中继续授权",
        waitingBrowser: addingFile
          ? "请在系统浏览器中确认此文件的只读授权。完成后会自动回到 CodeShell。"
          : "请在系统浏览器中完成登录、二次验证和授权。完成后会自动回到 CodeShell。",
      }
    : {
        openPage: "Continue in your browser",
        waitingBrowser: addingFile
          ? "Confirm read-only access to this file in your browser. CodeShell will return automatically when it is saved."
          : "Complete sign-in, two-factor verification, and authorization in your browser. CodeShell will return automatically when the connection is saved.",
        deviceInstruction: "Enter this code on the authorization page:",
        copy: "Copy code",
        submit: "Verify and connect",
        verifyCode: "Enter the code provided by the provider",
        secondFactor: "Complete the additional verification required by the provider",
        detectSession: "Check sign-in status",
        bindSession: "Use this account",
        loginSession: "Sign in to the provider",
        notInstalled: "The required CLI is not installed in this environment.",
        notAuthenticated: "Sign in to the provider CLI in this environment, then check again.",
        authenticated: "Signed in",
        processing: "Confirming and saving connection…",
        connected: "Connection saved.",
        cancelled: "Authorization cancelled.",
        failed: "Authorization did not complete. Please connect again.",
        expired: "Authorization expired. Please connect again.",
        unsupported: "Update this client to continue this authorization step.",
        invalidUrl: "The authorization address is invalid. Check the service configuration.",
        scan: "Scan this QR code with the provider’s mobile app.",
        confirmOnPhone: "Scanned. Confirm on your phone.",
        qrExpired: "The QR code expired.",
        refreshQr: "Refresh QR code",
        qrError: "Could not display the QR code. Please try again.",
        qrAlt: "Provider authorization QR code",
        confirm: "Confirm authorization",
        resourcesTruncated:
          "Only some resources are shown. Narrow the selection before continuing.",
        expiresAt: "Expires at",
        rejected: "The provider rejected this credential. Check it and try again.",
        cliUnavailable:
          "No signed-in CLI is available. Check sign-in status or choose another method.",
      };
}
