import React from "react";
import type { MobileRuntimeModel } from "../src/hooks/useRemoteApp.js";

/** Persisted provider identity also covers sessions saved without a model alias. */
export function desktopRuntimeModel(session?: { model?: string; provider?: string }): string {
  if (/^(codex|claude-code)\//.test(session?.model ?? "")) return session!.model!;
  if (session?.provider === "codex" || session?.provider === "claude-code")
    return `${session.provider}/${session.model ?? ""}`;
  return "";
}

export function DesktopModelPicker({
  models,
  value,
  defaultLabel,
  loading,
  error,
  disabled,
  onChange,
  onRefresh,
  onRetryCreation,
}: {
  models: MobileRuntimeModel[];
  value: string;
  defaultLabel: string;
  loading?: boolean;
  error?: string;
  disabled: boolean;
  onChange: (modelKey: string) => void;
  onRefresh?: () => void;
  onRetryCreation?: () => void;
}) {
  return (
    <div className="desktop-model-picker">
      <select
        className="model-button"
        aria-label="选择模型或外部运行时"
        title={error || "选择本次会话使用的模型"}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{defaultLabel}</option>
        {value && !models.some((model) => model.key === value) ? (
          <option value={value}>{value} · 当前会话</option>
        ) : null}
        {(["claude-code", "codex"] as const).map((kind) => {
          const entries = models.filter((model) => model.kind === kind);
          return entries.length ? (
            <optgroup key={kind} label={kind === "codex" ? "Codex" : "Claude Code"}>
              {entries.map((model) => (
                <option key={model.key} value={model.key}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        {!models.length ? (
          <option disabled>{loading ? "正在检测外部模型…" : error || "暂无可用的外部模型"}</option>
        ) : null}
      </select>
      {onRetryCreation ? (
        <button className="library-button" disabled={disabled} onClick={onRetryCreation}>
          重试建立会话
        </button>
      ) : null}
      {!models.length && !loading && onRefresh ? (
        <button className="library-button" disabled={disabled} onClick={onRefresh}>
          重新检测
        </button>
      ) : null}
    </div>
  );
}
