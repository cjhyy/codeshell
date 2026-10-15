import React, { useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "../i18n/I18nProvider";
import { createDialogFocusLease, useDialogFocus } from "../ui/useDialogFocus";

interface Props {
  projectPath: string | null;
  onDecide: (level: "trusted" | "untrusted") => void;
  /** Re-prompt roots that were previously marked view-only before they become primary. */
  promptWhenUntrusted?: boolean;
}

interface TrustRisks {
  permissionRules: number;
  envKeys: string[];
  hooks: number;
  mcpServers: string[];
  setupScripts: boolean;
}
interface TrustView {
  root: string;
  unknown: boolean;
  risks: TrustRisks | null;
  readError: string | null;
  decisionError: string | null;
}
interface TrustScope {
  root: string;
  live: boolean;
}

export function TrustGate({ projectPath, onDecide, promptWhenUntrusted = false }: Props) {
  const { t } = useT();
  const [view, setView] = useState<TrustView | null>(null);
  const [reload, setReload] = useState(0);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  const scope = useRef<TrustScope | null>(null);
  const decision = useRef<object | null>(null);
  const readPending = useRef(false);
  const focusLease = useRef<ReturnType<typeof createDialogFocusLease> | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const viewOnlyButton = useRef<HTMLButtonElement>(null);
  const handoff = useRef<HTMLButtonElement | null>(null);
  const currentView = view?.root === projectPath ? view : null;
  const open = !!currentView && (currentView.unknown || !!currentView.readError);
  const dialogFocus = useDialogFocus(open, focusLease.current?.opener, focusLease.current);

  useLayoutEffect(() => {
    if (!projectPath) return;
    const focused = document.activeElement;
    const lease = createDialogFocusLease(
      focused instanceof HTMLElement && focused !== document.body ? focused : null,
    );
    focusLease.current = lease;
    lease.start();
    return () => {
      lease.cancel();
      lease.dispose();
    };
  }, [projectPath, promptWhenUntrusted]);

  useLayoutEffect(() => {
    decision.current = null;
    handoff.current = null;
    setPending(false);
    if (!projectPath) {
      scope.current = null;
      readPending.current = false;
      setReading(false);
      setView(null);
      return;
    }
    const request: TrustScope = { root: projectPath, live: true };
    scope.current = request;
    const isCurrent = () => request.live && scope.current === request;
    readPending.current = true;
    setReading(true);
    // A retry keeps its error and button mounted until a real response arrives.
    setView((previous) => (previous?.root === projectPath && previous.readError ? previous : null));
    void window.codeshell
      .getTrust(request.root)
      .then((trust) => {
        if (!isCurrent()) return;
        if (document.activeElement === retryButton.current) handoff.current = retryButton.current;
        const unknown = trust === "unknown" || (promptWhenUntrusted && trust === "untrusted");
        setView({ root: request.root, unknown, risks: null, readError: null, decisionError: null });
        if (unknown) {
          void window.codeshell
            .getTrustRisks(request.root)
            .then((risks) => {
              if (isCurrent())
                setView((previous) =>
                  previous?.root === request.root && previous.unknown
                    ? { ...previous, risks }
                    : previous,
                );
            })
            .catch(() => {
              /* Best-effort summary: the explicit trust decision remains available. */
            });
        } else if (!retryButton.current) focusLease.current?.dispose();
      })
      .catch((error) => {
        if (isCurrent())
          setView({
            root: request.root,
            unknown: false,
            risks: null,
            readError: error instanceof Error ? error.message : String(error),
            decisionError: null,
          });
      })
      .finally(() => {
        if (isCurrent()) {
          readPending.current = false;
          setReading(false);
        }
      });
    return () => {
      request.live = false;
    };
  }, [projectPath, promptWhenUntrusted, reload]);

  useLayoutEffect(() => {
    const source = handoff.current;
    handoff.current = null;
    if (
      source &&
      !source.isConnected &&
      document.activeElement === document.body &&
      currentView?.unknown &&
      focusLease.current?.ownsFocus
    )
      viewOnlyButton.current?.focus();
  }, [currentView]);

  const retryRead = () => {
    if (readPending.current || !currentView?.readError) return;
    readPending.current = true;
    setReload((value) => value + 1);
  };
  const decide = async (level: "trusted" | "untrusted") => {
    const request = scope.current;
    if (
      !request?.live ||
      request.root !== projectPath ||
      !currentView?.unknown ||
      decision.current ||
      readPending.current
    )
      return;
    const operation = {};
    decision.current = operation;
    const isCurrent = () => request.live && scope.current === request;
    setPending(true);
    setView((previous) => previous && { ...previous, decisionError: null });
    try {
      await window.codeshell.setTrust(request.root, level);
      if (!isCurrent()) return;
      onDecide(level);
      if (isCurrent()) setView((previous) => previous && { ...previous, unknown: false });
    } catch (error) {
      if (isCurrent())
        setView(
          (previous) =>
            previous && {
              ...previous,
              decisionError: error instanceof Error ? error.message : String(error),
            },
        );
    } finally {
      if (isCurrent() && decision.current === operation) {
        decision.current = null;
        setPending(false);
      }
    }
  };

  if (!open || !currentView) return null;
  const riskLines: string[] = [];
  const risks = currentView.risks;
  if (risks) {
    if (risks.permissionRules > 0)
      riskLines.push(t("auto.trust.riskPermissions", { n: risks.permissionRules }));
    if (risks.envKeys.length > 0)
      riskLines.push(t("auto.trust.riskEnv", { keys: risks.envKeys.join(", ") }));
    if (risks.hooks > 0) riskLines.push(t("auto.trust.riskHooks", { n: risks.hooks }));
    if (risks.mcpServers.length > 0)
      riskLines.push(t("auto.trust.riskMcp", { names: risks.mcpServers.join(", ") }));
    if (risks.setupScripts) riskLines.push(t("auto.trust.riskSetup"));
  }
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        ref={dialogFocus.contentRef}
        data-dialog-focus-owner={dialogFocus.focusOwnerId}
        onCloseAutoFocus={dialogFocus.onCloseAutoFocus}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (currentView.readError ? retryButton.current : viewOnlyButton.current)?.focus();
        }}
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 max-w-lg flex-col gap-0 overflow-hidden p-0"
        showClose={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4 [@media(max-height:20rem)]:px-3 [@media(max-height:20rem)]:py-2">
          <DialogTitle>
            {t(currentView.readError ? "auto.trust.readErrorTitle" : "auto.trust.title")}
          </DialogTitle>
        </DialogHeader>
        {(currentView.readError || currentView.decisionError) && (
          <p
            role="alert"
            tabIndex={0}
            data-dialog-scroll
            className="mx-5 mt-3 min-h-5 max-h-[25dvh] overflow-y-auto overscroll-contain text-sm text-status-err [overflow-wrap:anywhere] [@media(max-height:20rem)]:mx-3 [@media(max-height:20rem)]:mt-2"
          >
            {t(currentView.readError ? "auto.trust.readError" : "auto.trust.decisionError", {
              error: currentView.readError ?? currentView.decisionError ?? "",
            })}
          </p>
        )}
        <div
          role="region"
          tabIndex={0}
          data-dialog-scroll
          aria-label={t("auto.trust.details")}
          className="min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain p-5 [overflow-wrap:anywhere] [@media(max-height:20rem)]:min-h-12 [@media(max-height:20rem)]:p-2"
        >
          <DialogDescription className="leading-relaxed">
            {t(currentView.readError ? "auto.trust.readErrorDescription" : "auto.trust.body")}
          </DialogDescription>
          <div className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {currentView.root}
          </div>
          {risks ? (
            riskLines.length > 0 ? (
              <div className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2">
                <p className="mb-1.5 text-xs font-medium text-foreground">
                  {t("auto.trust.risksTitle")}
                </p>
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {riskLines.map((line, i) => (
                    <li key={i} className="break-all">
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("auto.trust.risksNone")}</p>
            )
          ) : null}
          {currentView.readError && reading && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("auto.trust.reading")}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 flex-col gap-2 border-t border-border/70 p-4 sm:flex-row sm:space-x-0 [@media(max-height:20rem)]:gap-1 [@media(max-height:20rem)]:p-2 [@media(max-height:20rem)]:[&_button]:h-8 [@media(max-height:20rem)]:[&_button]:text-xs">
          {currentView.readError ? (
            <Button
              ref={retryButton}
              aria-disabled={reading}
              aria-busy={reading}
              onClick={retryRead}
            >
              {reading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {t("auto.trust.retryRead")}
            </Button>
          ) : (
            <>
              <Button
                ref={viewOnlyButton}
                variant="default"
                aria-disabled={pending}
                aria-busy={pending}
                onClick={() => void decide("untrusted")}
              >
                {t("auto.trust.viewOnly")}
              </Button>
              <Button
                variant="solid"
                aria-disabled={pending}
                aria-busy={pending}
                onClick={() => void decide("trusted")}
              >
                {t("auto.trust.trustContinue")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
