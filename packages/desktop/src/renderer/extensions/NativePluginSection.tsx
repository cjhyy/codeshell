import { useCallback, useEffect, useState } from "react";
import { Cpu, Loader2, RefreshCw, ScrollText, ShieldAlert, ShieldCheck } from "lucide-react";
import type {
  NativePluginReview,
  NativePluginRuntimeView,
  PluginDetail,
} from "../../preload/types";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
import { useToast } from "../ui/ToastProvider";
import { useConfirm } from "../ui/DialogProvider";
import { signalHotReload } from "./applyUpdates";
import {
  changePluginApproval,
  nativeRuntimeOf,
  nativeSurfaceRows,
  type NativeRuntimePlace,
} from "./pluginPresentation";

const PLACE_TEXT = {
  off: "off",
  "no-worker": "noWorker",
  "not-loaded": "notLoaded",
  "not-in-worker": "notInWorker",
} as const;

/**
 * A native plugin on its detail page: what it declares, the one approval that
 * covers all of it, and how its process is doing in the running agent.
 */
export function NativePluginSection({
  installKey,
  name,
  review,
  onDetail,
}: {
  installKey: string;
  name: string;
  review: NativePluginReview;
  onDetail(detail: PluginDetail | null): void;
}) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<"approve" | "revoke" | "restart" | null>(null);
  const [runtime, setRuntime] = useState<NativePluginRuntimeView | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const approved = review.state === "approved";

  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await window.codeshell.nativePluginRuntime("status"));
    } catch {
      setRuntime(null);
    }
  }, []);

  useEffect(() => {
    setLog(null);
    if (approved) void refreshRuntime();
    else setRuntime(null);
  }, [approved, installKey, refreshRuntime]);

  if (review.state === "none") return null;
  const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

  const changeApproval = async (action: "approve" | "revoke") => {
    if (action === "approve") {
      const confirmed = await confirm({
        title: t("ext.pluginDetail.native.approveConfirmTitle"),
        message: t("ext.pluginDetail.native.approveConfirmMessage", { name }),
        confirmLabel: t("ext.pluginDetail.native.approve"),
      });
      if (!confirmed) return;
    }
    setBusy(action);
    try {
      await changePluginApproval(window.codeshell, action, installKey);
      // Running agents re-read the registry; a revoke takes effect at once.
      signalHotReload();
      onDetail(await window.codeshell.getPluginDetail(installKey));
      toast({
        message: t(
          action === "approve"
            ? "ext.pluginDetail.native.approvedToast"
            : "ext.pluginDetail.native.revokedToast",
        ),
        variant: "success",
      });
    } catch (cause) {
      toast({
        message: t("ext.pluginDetail.native.approvalFailed", { error: errorText(cause) }),
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    setBusy("restart");
    try {
      setRuntime(await window.codeshell.nativePluginRuntime("restart", installKey));
      toast({ message: t("ext.pluginDetail.native.runtime.restartedToast"), variant: "success" });
    } catch (cause) {
      toast({
        message: t("ext.pluginDetail.native.runtime.restartFailed", { error: errorText(cause) }),
        variant: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleLog = async () => {
    if (log !== null) {
      setLog(null);
      return;
    }
    try {
      setLog(await window.codeshell.nativePluginLog(installKey));
    } catch {
      setLog("");
    }
  };

  const rows = nativeSurfaceRows(review);
  const surface = review.surface;
  const backgroundChanged = review.baselineAvailable && review.diff?.background !== undefined;
  const place = nativeRuntimeOf(runtime, installKey);
  const tone =
    review.state === "approved"
      ? "bg-muted/20"
      : review.state === "pending"
        ? "border-status-warn/50 bg-status-warn/5"
        : "border-status-err/50 bg-status-err/5";

  return (
    <section className={`space-y-2 rounded-md border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        {approved ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-status-ok" />
        ) : (
          <ShieldAlert
            className={`h-4 w-4 shrink-0 ${
              review.state === "pending" ? "text-status-warn" : "text-status-err"
            }`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">
            {t(`ext.pluginDetail.native.state.${review.state}.title`)}
          </div>
          <div className="break-words text-[11px] text-muted-foreground">
            {t(`ext.pluginDetail.native.state.${review.state}.description`, {
              error: review.error ?? "",
            })}
          </div>
        </div>
        {review.state === "pending" && (
          <Button
            type="button"
            size="sm"
            variant="solid"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={busy !== null}
            onClick={() => void changeApproval("approve")}
          >
            {busy === "approve" && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("ext.pluginDetail.native.approve")}
          </Button>
        )}
        {approved && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={busy !== null}
            onClick={() => void changeApproval("revoke")}
          >
            {busy === "revoke" && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("ext.pluginDetail.native.revoke")}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-status-warn">{t("ext.pluginDetail.native.processNote")}</p>
      {surface && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium">{t("ext.pluginDetail.native.surfaceTitle")}</div>
          {review.state !== "approved" && (
            <p className="text-[11px] text-muted-foreground">
              {review.baselineAvailable
                ? t("ext.pluginDetail.native.diffBaseline")
                : t("ext.pluginDetail.native.diffNoBaseline")}
            </p>
          )}
          {rows.map((row) => (
            <div key={row.list} className="flex flex-wrap items-baseline gap-1">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">
                {t(`ext.pluginDetail.native.list.${row.list}`)}
              </span>
              {row.items.map((item) => (
                <span
                  key={`${item.change ?? "same"}:${item.name}`}
                  title={
                    item.change ? t(`ext.pluginDetail.native.change.${item.change}`) : undefined
                  }
                  className={`rounded px-1 font-mono text-[10px] ${
                    item.change === "added"
                      ? "bg-status-warn/10 text-status-warn"
                      : item.change === "removed"
                        ? "bg-status-err/10 text-status-err line-through"
                        : "bg-muted"
                  }`}
                >
                  {item.name}
                </span>
              ))}
            </div>
          ))}
          {(surface.background || backgroundChanged) && (
            <div className="text-[11px] text-muted-foreground">
              {t(
                surface.background
                  ? "ext.pluginDetail.native.backgroundOn"
                  : "ext.pluginDetail.native.backgroundOff",
              )}
              {backgroundChanged && (
                <span className="ml-1 text-status-warn">
                  {t("ext.pluginDetail.native.changedSinceApproval")}
                </span>
              )}
            </div>
          )}
          {(surface.coreCapabilities.length > 0 || surface.hostCapabilities.length > 0) && (
            <p className="text-[11px] text-muted-foreground">
              {t("ext.pluginDetail.native.capabilitiesNote")}
            </p>
          )}
        </div>
      )}
      {approved && (
        <NativeRuntimeRow
          place={place}
          busy={busy}
          log={log}
          onRefresh={() => void refreshRuntime()}
          onRestart={() => void restart()}
          onToggleLog={() => void toggleLog()}
        />
      )}
    </section>
  );
}

function NativeRuntimeRow({
  place,
  busy,
  log,
  onRefresh,
  onRestart,
  onToggleLog,
}: {
  place: NativeRuntimePlace;
  busy: "approve" | "revoke" | "restart" | null;
  log: string | null;
  onRefresh(): void;
  onRestart(): void;
  onToggleLog(): void;
}) {
  const { t } = useT();
  const status = place.kind === "status" ? place.status : undefined;
  const summary =
    place.kind === "unknown"
      ? t("ext.common.loading")
      : place.kind !== "status"
        ? t(`ext.pluginDetail.native.runtime.${PLACE_TEXT[place.kind]}`)
        : [
            t(`ext.pluginDetail.native.runtime.states.${place.status.state}`),
            place.status.pid !== undefined
              ? t("ext.pluginDetail.native.runtime.pid", { pid: place.status.pid })
              : place.status.state === "running"
                ? t("ext.pluginDetail.native.runtime.idle")
                : undefined,
            t("ext.pluginDetail.native.runtime.counters", {
              calls: place.status.calls,
              failures: place.status.failures,
              timeouts: place.status.timeouts,
            }),
          ]
            .filter(Boolean)
            .join(" · ");
  return (
    <div className="space-y-1.5 rounded bg-muted/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-medium">
          {t("ext.pluginDetail.native.runtime.title")}
        </span>
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{summary}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={onRefresh}
        >
          <RefreshCw className="h-3 w-3" />
          {t("ext.pluginDetail.native.runtime.refresh")}
        </Button>
        {status && status.state !== "revoked" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-1.5 text-[11px]"
            disabled={busy !== null}
            onClick={onRestart}
          >
            {busy === "restart" && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("ext.pluginDetail.native.runtime.restart")}
          </Button>
        )}
        {status && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={onToggleLog}
          >
            <ScrollText className="h-3 w-3" />
            {log === null
              ? t("ext.pluginDetail.native.runtime.showLog")
              : t("ext.pluginDetail.native.runtime.hideLog")}
          </Button>
        )}
      </div>
      {status && (status.error || status.lastError) && (
        <div className="break-all text-[11px] text-status-err">
          {t("ext.pluginDetail.native.runtime.lastError", {
            error: status.error ?? status.lastError ?? "",
          })}
        </div>
      )}
      {log !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[10px]">
          {log || t("ext.pluginDetail.native.runtime.emptyLog")}
        </pre>
      )}
    </div>
  );
}
