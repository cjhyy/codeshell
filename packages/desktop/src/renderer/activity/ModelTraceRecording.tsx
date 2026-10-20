import React, { useEffect, useRef, useState } from "react";
import type { ModelTraceConfig, ModelTraceConfigPatch } from "../../preload/model-trace-api";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n/I18nProvider";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ModelTraceRecording() {
  const { t } = useT();
  const [config, setConfig] = useState<ModelTraceConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configRevision, setConfigRevision] = useState(0);
  const [configError, setConfigError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [retention, setRetention] = useState("7");
  const mounted = useRef(false);
  const configVersion = useRef(0);
  const configPending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      configVersion.current++;
    };
  }, []);
  useEffect(() => {
    const version = ++configVersion.current;
    setConfigLoading(true);
    setConfigError(null);
    void Promise.resolve()
      .then(() => window.codeshell.modelTraces.getConfig())
      .then((value) => {
        if (!mounted.current || version !== configVersion.current) return;
        setConfig(value);
        setRetention(String(value.retentionDays));
      })
      .catch((error) => {
        if (mounted.current && version === configVersion.current) setConfigError(errorText(error));
      })
      .finally(() => {
        if (mounted.current && version === configVersion.current) setConfigLoading(false);
      });
  }, [configRevision]);

  const saveConfig = async (patch: ModelTraceConfigPatch) => {
    if (
      configPending.current ||
      configLoading ||
      !config ||
      typeof window.codeshell.modelTraces.setConfig !== "function"
    )
      return;
    configPending.current = true;
    setSavingConfig(true);
    setConfigError(null);
    const version = ++configVersion.current;
    try {
      const value = await window.codeshell.modelTraces.setConfig(patch);
      if (mounted.current && version === configVersion.current) {
        setConfig(value);
        if (patch.retentionDays !== undefined) setRetention(String(value.retentionDays));
      }
    } catch (error) {
      if (mounted.current && version === configVersion.current) setConfigError(errorText(error));
    } finally {
      configPending.current = false;
      if (mounted.current) setSavingConfig(false);
    }
  };
  const configDisabled =
    configLoading ||
    savingConfig ||
    !config ||
    typeof window.codeshell.modelTraces?.setConfig !== "function";
  const selectClass =
    "h-9 min-w-0 max-w-full rounded-lg border border-border bg-background px-2 text-xs disabled:opacity-50";
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {(["enabled", "captureContent", "includeEphemeral"] as const).map((key) => (
          <label key={key} className="inline-flex items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              checked={config?.[key] ?? false}
              disabled={configDisabled}
              onChange={(event) => void saveConfig({ [key]: event.target.checked })}
            />
            {t(
              key === "enabled"
                ? "observability.recording"
                : key === "captureContent"
                  ? "observability.captureContent"
                  : "observability.includeEphemeral",
            )}
          </label>
        ))}
        <details className="min-w-0 text-xs">
          <summary className="cursor-pointer rounded p-1 focus-visible:ring-2 focus-visible:ring-ring">
            {t("observability.settings")}
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="space-y-1">
              <span className="block text-muted-foreground">{t("observability.retention")}</span>
              <input
                type="number"
                min={1}
                max={365}
                value={retention}
                onChange={(event) => setRetention(event.target.value)}
                className={`${selectClass} w-20`}
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                configDisabled ||
                !/^\d+$/.test(retention) ||
                Number(retention) < 1 ||
                Number(retention) > 365
              }
              onClick={() => void saveConfig({ retentionDays: Number(retention) })}
            >
              {t(savingConfig ? "observability.saving" : "observability.save")}
            </Button>
          </div>
          <p className="mt-2 max-w-lg leading-relaxed text-muted-foreground">
            {t("observability.ephemeralHint")}
          </p>
        </details>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t("observability.captureHint")}
      </p>
      {config && (!config.enabled || !config.captureContent) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(!config.enabled ? "observability.disabled" : "observability.metadataOnly")}
        </p>
      )}
      {configError && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p
            role="alert"
            className="min-w-0 break-words text-xs text-status-err [overflow-wrap:anywhere]"
          >
            {t("observability.configError", { error: configError })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={configLoading || savingConfig}
            onClick={() => setConfigRevision((value) => value + 1)}
          >
            {t("observability.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
