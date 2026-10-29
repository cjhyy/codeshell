import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  ComputerUsePermissionKind,
  ComputerUsePermissionState,
  ComputerUseSettingsStatus,
} from "../../shared/computer-use";
import { useT } from "../i18n";

/** OS permission prompts are issued only by an explicit action in this card. */
export function ComputerUseSettings() {
  const { t } = useT();
  const [status, setStatus] = useState<ComputerUseSettingsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const reading = useRef<number | null>(null);
  const operation = useRef<string | null>(null);
  const refreshPending = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    if (operation.current) {
      refreshPending.current = true;
      return;
    }
    if (reading.current !== null) return;
    const current = ++generation.current;
    reading.current = current;
    setRefreshing(true);
    setFailed(false);
    try {
      const next = await window.codeshell.computerUse.status();
      if (mounted.current && generation.current === current) setStatus(next);
    } catch {
      if (mounted.current && generation.current === current) setFailed(true);
    } finally {
      if (reading.current === current) reading.current = null;
      if (mounted.current && generation.current === current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      generation.current += 1;
      reading.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  /** Stop and resume never wait behind another settings operation. */
  async function controlInput(
    action: () => Promise<ComputerUseSettingsStatus | undefined> | undefined,
  ) {
    try {
      const next = await action();
      if (mounted.current && next) setStatus(next);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }

  async function perform(name: string, action: () => Promise<ComputerUseSettingsStatus | void>) {
    // A ref also locks same-frame double-clicks, before React updates disabled.
    if (operation.current || !status?.permissions.supported) return;
    operation.current = name;
    const current = ++generation.current;
    reading.current = null;
    setRefreshing(false);
    setBusy(name);
    setFailed(false);
    try {
      const next = await action();
      if (mounted.current && generation.current === current && next) setStatus(next);
    } catch {
      if (mounted.current && generation.current === current) setFailed(true);
    } finally {
      operation.current = null;
      if (mounted.current && generation.current === current) {
        setBusy(null);
        if (refreshPending.current) {
          refreshPending.current = false;
          void refresh();
        }
      }
    }
  }

  function permissionRow(kind: ComputerUsePermissionKind, state: ComputerUsePermissionState) {
    const granted = state === "granted";
    const unavailable = state === "unsupported";
    const canRequest = kind === "accessibility" || status?.permissions.screenRequestAvailable;
    return (
      <div key={kind} className="flex flex-wrap items-center justify-between gap-3 py-2">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t(`settingsX.computerUse.${kind}`)}</span>
          <span className="text-xs text-muted-foreground" role="status">
            {t(`settingsX.computerUse.state_${state}`)}
          </span>
        </div>
        {!granted && !unavailable && (
          <div className="flex flex-wrap gap-2">
            {canRequest && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!!busy || !status?.enabled}
                onClick={() =>
                  void perform(kind, () => window.codeshell.computerUse.requestPermission(kind))
                }
              >
                {t(`settingsX.computerUse.request_${kind}`)}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                void perform(`settings-${kind}`, () =>
                  window.codeshell.computerUse.openSettings(kind),
                )
              }
            >
              {t(`settingsX.computerUse.open_${kind}`)}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="mb-6 flex flex-col gap-3" aria-labelledby="computer-use-settings-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="computer-use-settings-title" className="m-0 text-[0.95rem] font-semibold">
          {t("settingsX.computerUse.title")}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!!busy || refreshing}
          onClick={() => void refresh()}
        >
          {t("settingsX.computerUse.refresh")}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.computerUse.description")}</p>
      {failed && (
        <p className="m-0 text-xs text-status-err" role="alert">
          {t("settingsX.computerUse.failed")}
        </p>
      )}
      {!status && refreshing && (
        <p className="m-0 text-xs text-muted-foreground" role="status">
          {t("settingsX.computerUse.loading")}
        </p>
      )}
      {status && !status.permissions.supported && (
        <p className="m-0 text-xs text-muted-foreground">
          {t("settingsX.computerUse.unsupported")}
        </p>
      )}
      {status?.permissions.supported && (
        <>
          <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
            {t("settingsX.computerUse.enable")}
            <Switch
              checked={status.enabled}
              disabled={!!busy || (!status.enabled && !status.driverAvailable)}
              onCheckedChange={(enabled) =>
                void perform("enable", () => window.codeshell.computerUse.setEnabled(enabled))
              }
            />
          </label>
          <p className="m-0 text-xs text-muted-foreground" role="status">
            {t(status.active ? "settingsX.computerUse.active" : "settingsX.computerUse.inactive")}
          </p>
          {status.input && (
            <div
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
              data-computer-input-control
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{t("settingsX.computerUse.inputTitle")}</span>
                {status.input.stopped || status.input.foregroundHeld ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void controlInput(() => window.codeshell.computerUse.controlInput?.("resume"))
                    }
                  >
                    {t("settingsX.computerUse.inputResume")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() =>
                      void controlInput(() => window.codeshell.computerUse.controlInput?.("stop"))
                    }
                  >
                    {t("settingsX.computerUse.inputStop")}
                  </Button>
                )}
              </div>
              <p className="m-0 text-xs text-muted-foreground" role="status">
                {t(
                  status.input.stopped
                    ? "settingsX.computerUse.inputStopped"
                    : status.input.foregroundHeld
                      ? "settingsX.computerUse.inputForegroundHeld"
                      : "settingsX.computerUse.inputRunning",
                )}
                {status.input.userActive && !status.input.stopped
                  ? ` ${t("settingsX.computerUse.inputUserActive")}`
                  : ""}
              </p>
              <p className="m-0 text-xs text-muted-foreground">
                {t("settingsX.computerUse.inputShortcut")}
              </p>
              {status.active && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() =>
                      void perform("force-stop", async () =>
                        window.codeshell.computerUse.controlInput?.("forceStop"),
                      )
                    }
                  >
                    {t("settingsX.computerUse.inputForceStop")}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("settingsX.computerUse.inputForceStopHint")}
                  </span>
                </div>
              )}
            </div>
          )}
          {status.companion && (
            <div
              className="flex flex-col gap-3 rounded-lg border border-border p-3"
              data-mimi-companion-settings
            >
              <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                {t("settingsX.computerUse.companionEnable")}
                <Switch
                  checked={status.companion.enabled}
                  disabled={!!busy || !status.companion.available}
                  onCheckedChange={(enabled) =>
                    void perform("companion", () =>
                      window.codeshell.computerUse.setCompanion({ enabled }),
                    )
                  }
                />
              </label>
              <p className="m-0 text-xs text-muted-foreground">
                {t("settingsX.computerUse.companionDescription")}
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
                  <div className="font-medium">{t("settingsX.computerUse.companionSprite")}</div>
                  <div className="mt-1 text-muted-foreground">
                    {t("settingsX.computerUse.companionSpriteHint")}
                  </div>
                </div>
                <div className="rounded-md border border-dashed border-border p-3">
                  <div className="font-medium">Live2D</div>
                  <div className="mt-1 text-muted-foreground">
                    {t("settingsX.computerUse.companionLive2dHint")}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-xs">
                  {t("settingsX.computerUse.companionSize")}
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
                    value={status.companion.size}
                    disabled={!!busy}
                    onChange={(event) => {
                      const size = Number(event.target.value);
                      void perform("companion-size", () =>
                        window.codeshell.computerUse.setCompanion({ size }),
                      );
                    }}
                  >
                    {[240, 320, 400, 480].map((size) => (
                      <option key={size} value={size}>
                        {size} px
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void perform("companion-preview", () =>
                      window.codeshell.computerUse.previewCompanion(),
                    )
                  }
                >
                  {t("settingsX.computerUse.companionPreview")}
                </Button>
              </div>
              {status.companion.error && (
                <p className="m-0 text-xs text-status-err" role="alert">
                  {status.companion.error}
                </p>
              )}
            </div>
          )}
          {!status.driverAvailable && (
            <p className="m-0 text-xs text-status-warn">
              {t("settingsX.computerUse.driverUnavailable")}
            </p>
          )}
          {!status.packaged && (
            <p className="m-0 text-xs text-muted-foreground">
              {t("settingsX.computerUse.development")}
            </p>
          )}
          <div className="divide-y divide-border rounded-md border border-border px-3">
            {permissionRow("accessibility", status.permissions.accessibility)}
            {permissionRow("screenRecording", status.permissions.screenRecording)}
          </div>
          {!status.enabled && (
            <p className="m-0 text-xs text-muted-foreground">
              {t("settingsX.computerUse.enableFirst")}
            </p>
          )}
          {!status.permissions.screenRequestAvailable &&
            status.permissions.screenRecording !== "granted" && (
              <p className="m-0 text-xs text-muted-foreground">
                {t("settingsX.computerUse.screenSettingsHint")}
              </p>
            )}
          {status.permissions.error && (
            <p className="m-0 text-xs text-status-warn" role="alert">
              {t("settingsX.computerUse.checkFailed")}
            </p>
          )}
          {(status.restartRequired || status.permissions.restartRequired) && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
              <p className="m-0 text-xs text-muted-foreground">
                {t("settingsX.computerUse.restartHint")}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  void perform("restart", () => window.codeshell.computerUse.restart())
                }
              >
                {t("settingsX.computerUse.restart")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
