import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import type {
  CloudManagementRequest,
  CloudManagementResult,
  CloudProject,
} from "../../shared/cloud-management.js";
import { CloudAccountSettings } from "../settings/CloudAccountSettings";
import { useCloudDialogFocus } from "./useCloudDialogFocus";
import { useT } from "../i18n";

export function CloudProjectManager({
  initialAddress,
  onBack,
  onOpened,
  onBusyChange,
}: {
  initialAddress: string;
  onBack: () => void;
  onOpened: (address: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<CloudAccountStatus>({ state: "signed-out" });
  const [address, setAddress] = useState(initialAddress);
  const [connected, setConnected] = useState("");
  const [attempted, setAttempted] = useState<Pick<
    CloudManagementRequest,
    "accountOrigin" | "accountId" | "cloudOrigin"
  > | null>(null);
  const [view, setView] = useState<Extract<CloudManagementResult, { action: "list" }> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const id = useId();
  const live = useRef(false);
  const pending = useRef(false);
  const composing = useRef(false);
  const operation = useRef(0);
  const authority = useRef({ identity: "", generation: 0, status });
  const contentRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  const focus = useCloudDialogFocus(
    contentRef,
    status.state === "signed-in" ? `${status.origin}\n${status.account?.id}` : "",
  );
  useEffect(() => {
    live.current = true;
    let received = false;
    const apply = (next: CloudAccountStatus) => {
      const identity =
        next.state === "signed-in" && next.account ? `${next.origin}\n${next.account.id}` : "";
      if (identity !== authority.current.identity) {
        authority.current.generation++;
        operation.current++;
        pending.current = false;
        setBusy(false);
        onBusyChange(false);
        setView(null);
        setConnected("");
        setAttempted(null);
        setError("");
        setUncertain(false);
        setConfirmLogout(false);
      }
      authority.current.identity = identity;
      authority.current.status = next;
      setStatus(next);
    };
    const off = window.codeshell.cloudAccount.onStatus((next) => {
      if (live.current) {
        received = true;
        apply(next);
      }
    });
    void window.codeshell.cloudAccount.status().then(
      (next) => {
        if (live.current && !received) apply(next);
      },
      () => {
        if (live.current && !received) setError(t("cloudManager.accountUnavailable"));
      },
    );
    return () => {
      live.current = false;
      operation.current++;
      off();
      onBusyChange(false);
    };
  }, [onBusyChange, t]);
  const guardComposingEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.key === "Enter" &&
      (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
    )
      event.preventDefault();
  };
  const act = async (action: CloudManagementRequest["action"], projectId?: string) => {
    if (pending.current) return;
    const captured = authority.current;
    const currentStatus = captured.status;
    if (currentStatus.state !== "signed-in" || !currentStatus.origin || !currentStatus.account)
      return;
    if (
      action === "logout" &&
      (!attempted ||
        attempted.accountOrigin !== currentStatus.origin ||
        attempted.accountId !== currentStatus.account.id)
    )
      return;
    let cloudOrigin: string;
    try {
      const url = new URL(action === "logout" ? attempted!.cloudOrigin : address.trim());
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
      cloudOrigin = url.origin;
    } catch {
      setError(t("cloudManager.invalidAddress"));
      return;
    }
    const generation = captured.generation,
      attempt = ++operation.current;
    const current = () =>
      live.current && attempt === operation.current && generation === authority.current.generation;
    const lease = focus.capture();
    let opened = false;
    let failed = false;
    pending.current = true;
    setBusy(true);
    // The chooser's close guard must be set before IPC can dispatch another event.
    onBusyChange(true);
    setError("");
    try {
      const identity = {
        accountOrigin: currentStatus.origin,
        accountId: currentStatus.account.id,
        cloudOrigin,
      };
      if (action === "list") setAttempted(identity);
      const request: CloudManagementRequest =
        action === "create"
          ? { ...identity, action, name: name.trim() }
          : action === "list" || action === "logout"
            ? { ...identity, action }
            : { ...identity, action, projectId: projectId! };
      const result = await window.codeshell.openCloudWorkbench(request);
      if (!current()) return;
      if (result.action !== action) throw new Error(t("cloudManager.invalidResponse"));
      if (result.action === "list") {
        setView(result);
        setAddress(cloudOrigin);
        setConnected(cloudOrigin);
        setUncertain(false);
      } else if (result.action === "logout") {
        setView(null);
        setConnected("");
        setAttempted(null);
        setUncertain(false);
        setConfirmLogout(false);
      } else {
        setView(
          (old) =>
            old && {
              ...old,
              projects: old.projects.some((p) => p.id === result.project.id)
                ? old.projects.map((p) => (p.id === result.project.id ? result.project : p))
                : [...old.projects, result.project],
            },
        );
        if (result.action === "create") setName("");
        if (result.action === "open") {
          opened = true;
          onOpened(cloudOrigin);
        }
      }
    } catch (cause) {
      if (current()) {
        failed = true;
        setError(cause instanceof Error ? cause.message : t("cloudManager.failed"));
        setUncertain(true);
      }
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
        onBusyChange(false);
        if (opened) focus.discard(lease);
        else
          focus.recover(
            lease,
            () =>
              failed
                ? (reloadRef.current ?? addressRef.current)
                : action === "create"
                  ? nameRef.current
                  : (reloadRef.current ?? addressRef.current),
            failed,
          );
      } else focus.discard(lease);
    }
  };
  const canAct = !busy && !uncertain && connected === address.trim().replace(/\/$/, "");
  return (
    <div
      ref={contentRef}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 [overflow-wrap:anywhere]"
    >
      {status.state !== "signed-in" ? (
        <>
          <p className="text-sm text-muted-foreground">{t("cloudManager.signIn")}</p>
          <CloudAccountSettings embedded />
        </>
      ) : (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">
            {status.account?.username} · {status.origin}
          </p>
          <form
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!composing.current) void act("list");
            }}
          >
            <label htmlFor={id}>{t("sidebar.cloudAddress")}</label>
            <Input
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              ref={addressRef}
              id={id}
              value={address}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={guardComposingEnter}
              disabled={busy}
              placeholder="https://cloud.example.com"
              onChange={(event) => {
                setAddress(event.target.value);
                setView(null);
                setConnected("");
                setError("");
                setUncertain(false);
                setConfirmLogout(false);
              }}
            />
            <Button ref={reloadRef} type="submit" disabled={busy || !address.trim()}>
              {t(view ? "cloudManager.reload" : "cloudManager.connect")}
            </Button>
          </form>
          {view && (
            <>
              {!view.available && (
                <p role="status" className="text-sm text-destructive">
                  {view.error || t("cloudManager.runtimeUnavailable")}
                </p>
              )}
              <form
                className="flex min-w-0 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!composing.current) void act("create");
                }}
              >
                <Input
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  ref={nameRef}
                  className="min-w-0 flex-1"
                  aria-label={t("cloudManager.projectName")}
                  onKeyDown={guardComposingEnter}
                  maxLength={80}
                  value={name}
                  disabled={busy}
                  placeholder={t("cloudManager.projectName")}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" className="shrink-0" disabled={!canAct || !name.trim()}>
                  {t("cloudManager.create")}
                </Button>
              </form>
              {view.projects.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("cloudManager.empty")}</p>
              )}
              <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
                {view.projects.map((project: CloudProject) => (
                  <li
                    key={project.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border p-3"
                  >
                    <p className="font-medium [overflow-wrap:anywhere]">{project.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`cloudManager.${project.status}`)}
                    </p>
                    {project.error && (
                      <p
                        role="status"
                        className="text-sm text-destructive [overflow-wrap:anywhere]"
                      >
                        {project.error}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !canAct ||
                          !view.available ||
                          !["stopped", "error"].includes(project.status)
                        }
                        onClick={() => void act("start", project.id)}
                      >
                        {t("cloudManager.start")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canAct || !["running", "error"].includes(project.status)}
                        onClick={() => void act("stop", project.id)}
                      >
                        {t("cloudManager.stop")}
                      </Button>
                      <Button
                        type="button"
                        disabled={!canAct || project.status !== "running"}
                        onClick={() => void act("open", project.id)}
                      >
                        {t("sidebar.openCloud")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {attempted && (
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
              <p className="break-all text-xs text-muted-foreground">{attempted.cloudOrigin}</p>
              {confirmLogout && <p className="text-sm">{t("cloudManager.logoutReview")}</p>}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => (confirmLogout ? void act("logout") : setConfirmLogout(true))}
              >
                {t(confirmLogout ? "cloudManager.confirmLogout" : "cloudManager.logout")}
              </Button>
              {confirmLogout && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmLogout(false)}
                >
                  {t("cloudManager.cancel")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {uncertain && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("cloudManager.uncertain")}
        </p>
      )}
      <Button type="button" variant="ghost" disabled={busy} onClick={onBack}>
        {t("sidebar.projectBack")}
      </Button>
    </div>
  );
}
