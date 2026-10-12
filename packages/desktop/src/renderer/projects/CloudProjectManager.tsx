import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CloudAccountStatus } from "../../shared/cloud-account.js";
import type {
  CloudManagementRequest,
  CloudManagementResult,
  CloudProject,
} from "../../shared/cloud-management.js";
import { CloudAccountSettings } from "../settings/CloudAccountSettings";
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
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
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
        setView(null);
        setConnected("");
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
  const act = async (action: CloudManagementRequest["action"], projectId?: string) => {
    if (pending.current) return;
    const captured = authority.current;
    const currentStatus = captured.status;
    if (currentStatus.state !== "signed-in" || !currentStatus.origin || !currentStatus.account)
      return;
    let cloudOrigin: string;
    try {
      const url = new URL(address.trim());
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
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const identity = {
        accountOrigin: currentStatus.origin,
        accountId: currentStatus.account.id,
        cloudOrigin,
      };
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
        if (result.action === "open") onOpened(cloudOrigin);
      }
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : t("cloudManager.failed"));
        setUncertain(true);
      }
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const canAct = !busy && !uncertain && connected === address.trim().replace(/\/$/, "");
  return (
    <div className="grid max-h-[65vh] gap-4 overflow-y-auto">
      {status.state !== "signed-in" ? (
        <>
          <p className="text-sm text-muted-foreground">{t("cloudManager.signIn")}</p>
          <CloudAccountSettings embedded />
        </>
      ) : (
        <>
          <p className="break-words text-sm">
            {status.account?.username} · {status.origin}
          </p>
          <form
            className="grid gap-2"
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
              id={id}
              value={address}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
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
            <Button type="submit" disabled={busy || !address.trim()}>
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
                className="flex gap-2"
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
                  aria-label={t("cloudManager.projectName")}
                  maxLength={80}
                  value={name}
                  disabled={busy}
                  placeholder={t("cloudManager.projectName")}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button type="submit" disabled={!canAct || !name.trim()}>
                  {t("cloudManager.create")}
                </Button>
              </form>
              {view.projects.length === 0 && (
                <p className="text-sm text-muted-foreground">{t("cloudManager.empty")}</p>
              )}
              <ul className="grid gap-3">
                {view.projects.map((project: CloudProject) => (
                  <li key={project.id} className="grid gap-2 rounded-lg border p-3">
                    <p className="break-words font-medium">{project.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`cloudManager.${project.status}`)}
                    </p>
                    {project.error && (
                      <p role="status" className="break-words text-sm text-destructive">
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
          {connected && (
            <div className="grid gap-2">
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
        <p role="alert" className="break-words text-sm text-destructive">
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
