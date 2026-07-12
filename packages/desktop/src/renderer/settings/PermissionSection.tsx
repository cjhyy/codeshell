import React, { useState } from "react";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import {
  fromSettingsPermissionMode,
  toCorePermissionMode,
  type PermissionMode,
} from "../chat/PermissionPill";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";

const MODES: PermissionMode[] = ["plan", "default", "accept_edits", "bypass"];

interface Props {
  scope: "user" | "project";
  activeProjectPath: string | null;
}

export function PermissionSection({ scope, activeProjectPath }: Props) {
  const { t } = useT();
  const MODE_LABELS: Record<PermissionMode, string> = {
    plan: t("settingsX.permission.planLabel"),
    default: t("settingsX.permission.defaultLabel"),
    accept_edits: t("settingsX.permission.acceptEditsLabel"),
    bypass: t("settingsX.permission.bypassLabel"),
  };
  const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
    plan: t("settingsX.permission.planDesc"),
    default: t("settingsX.permission.defaultDesc"),
    accept_edits: t("settingsX.permission.acceptEditsDesc"),
    bypass: t("settingsX.permission.bypassDesc"),
  };
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [saving, setSaving] = useState(false);

  const cwd = scope === "project" ? (activeProjectPath ?? undefined) : undefined;

  const load = async () => {
    try {
      const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
      const permissions =
        s.permissions && typeof s.permissions === "object"
          ? (s.permissions as Record<string, unknown>)
          : {};
      setMode(fromSettingsPermissionMode(s.permissionMode ?? permissions.defaultMode));
    } catch (err) {
      console.error("getSettings failed", err);
    }
  };

  // Load on mount/scope switch + auto-refresh on config change anywhere.
  useRefreshOnSettingsChange(() => void load(), [scope, activeProjectPath]);

  const choose = async (m: PermissionMode) => {
    setSaving(true);
    try {
      await window.codeshell.updateSettings(
        scope,
        {
          permissionMode: m,
          permissions: { defaultMode: toCorePermissionMode(m) },
        },
        cwd,
      );
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      setMode(m);
    } catch (err) {
      console.error("updateSettings failed", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
        {t("settingsX.permission.title")}
      </h3>
      <p className="m-0 text-xs text-muted-foreground">{t("settingsX.permission.desc")}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {MODES.map((m) => (
          <button
            key={m}
            className={cn(
              "flex cursor-pointer flex-col items-start gap-1 rounded-md border bg-transparent p-3 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
              mode === m && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            aria-pressed={mode === m}
            disabled={saving}
            onClick={() => void choose(m)}
          >
            <span className="text-sm font-medium text-foreground">{MODE_LABELS[m]}</span>
            <span className="text-xs text-muted-foreground">{MODE_DESCRIPTIONS[m]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
