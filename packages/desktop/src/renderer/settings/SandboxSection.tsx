/**
 * SandboxSection — sandbox (isolation + network) config, scoped global or per
 * project. Drill-in IA (matches 本地环境/钩子/记忆/子代理): a list shows a
 * 全局 row plus each project; selecting one opens its editor with a ← back
 * button. Split out of the local-environment editor so it's decoupled from env
 * (which used to save sandbox together, mis-writing a default 'auto' the user
 * never chose). Model (see 2026-06-16-sandbox-scope-model-design.md):
 *   - global default = off (don't write sandbox = off).
 *   - project "跟随全局" = don't write the project's sandbox field.
 *   - project/global with a mode = that applies (engine resolves
 *     config > project > global > default).
 */
import React, { useCallback, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ProjectPicker } from "./ProjectPicker";
import { repoLabel, type Repo } from "../repos";
import { writeSettings } from "../settingsBus";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import { useT } from "../i18n/I18nProvider";

const FOLLOW = "__follow__"; // project-only: don't write sandbox → follow global

function objectOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function strOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function arrText(v: unknown): string {
  return Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === "string").join("\n") : "";
}
function lines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function SandboxSection({ repos }: { repos: Repo[] }) {
  const { t } = useT();
  // selectedPath: undefined = list view; null = global (user scope); a repo
  // path = that project. Distinguishing undefined from null is what makes the
  // 全局 row a real selection (drill-in) instead of the default.
  const [selectedPath, setSelectedPath] = useState<string | null | undefined>(undefined);
  const selectedRepo = selectedPath ? repos.find((r) => r.path === selectedPath) ?? null : null;

  // List view: 全局 + per-project picker. Same shape as EnvironmentSection.
  if (selectedPath === undefined) {
    return (
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{t("settingsX.sandbox.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("settingsX.sandbox.desc")}</p>
        </div>
        <ProjectPicker
          repos={repos}
          includeGlobal
          globalHint={t("settingsX.sandbox.globalHint")}
          onSelect={(path) => setSelectedPath(path)}
        />
      </section>
    );
  }

  // Editor view: a chosen scope (全局 or a project). Keyed so switching scope
  // remounts the editor and its form state reloads cleanly.
  const isGlobal = selectedPath === null;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-muted-foreground"
          onClick={() => setSelectedPath(undefined)}
        >
          <ArrowLeft size={14} />
          <span>{t("settingsX.sandbox.backToList")}</span>
        </Button>
        <span className="truncate text-sm font-medium text-foreground">
          {isGlobal
            ? t("settingsX.sandbox.scopeGlobal")
            : selectedRepo
              ? repoLabel(selectedRepo)
              : selectedPath}
        </span>
      </div>
      <SandboxEditor
        key={selectedPath ?? "__global__"}
        scope={isGlobal ? "user" : "project"}
        cwd={isGlobal ? undefined : selectedPath}
        isGlobal={isGlobal}
      />
    </section>
  );
}

/** Editor for a single scope. Remounted per scope (key) so state is per-scope. */
function SandboxEditor({
  scope,
  cwd,
  isGlobal,
}: {
  scope: "user" | "project";
  cwd: string | undefined;
  isGlobal: boolean;
}) {
  const { t } = useT();
  const [mode, setMode] = useState<string>(isGlobal ? "off" : FOLLOW);
  const [network, setNetwork] = useState("allow");
  const [writableRoots, setWritableRoots] = useState("");
  const [deniedReads, setDeniedReads] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const sandbox = objectOf((s as Record<string, unknown>).sandbox);
    const m = strOf(sandbox.mode);
    // No mode written: global → off (the default), project → follow global.
    setMode(m || (isGlobal ? "off" : FOLLOW));
    setNetwork(strOf(sandbox.network) || "allow");
    setWritableRoots(arrText(sandbox.writableRoots));
    setDeniedReads(arrText(sandbox.deniedReads));
  }, [scope, cwd, isGlobal]);

  useRefreshOnSettingsChange(() => void load(), [load]);

  const save = async () => {
    setSaving(true);
    try {
      // 跟随全局 (project only): write an empty sandbox object (no mode). The
      // engine's resolveSandboxConfig treats a layer without `mode` as "unset /
      // follow", so this falls through to global without relying on field
      // deletion. Otherwise write the chosen mode + fields.
      const sandbox =
        mode === FOLLOW
          ? {}
          : { mode, network, writableRoots: lines(writableRoots), deniedReads: lines(deniedReads) };
      await writeSettings(scope, { sandbox }, cwd);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  const field = "flex flex-col gap-1.5";
  const hint = "mt-1 text-xs text-muted-foreground";
  const showDetail = mode !== FOLLOW && mode !== "off";
  const modeOptions = [
    ...(isGlobal ? [] : [{ value: FOLLOW, label: t("settingsX.sandbox.follow"), description: t("settingsX.sandbox.followDesc") }]),
    { value: "off", label: "off", description: t("settingsX.sandbox.offDesc") },
    { value: "auto", label: "auto", description: t("settingsX.sandbox.autoDesc") },
    { value: "seatbelt", label: "seatbelt", description: t("settingsX.sandbox.seatbeltDesc") },
    { value: "bwrap", label: "bwrap", description: t("settingsX.sandbox.bwrapDesc") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <label className={field}>
          <span className="text-sm text-muted-foreground">{t("settingsX.sandbox.mode")}</span>
          <Select value={mode} onChange={setMode} options={modeOptions} />
        </label>
        {showDetail && (
          <label className={field}>
            <span className="text-sm text-muted-foreground">{t("settingsX.sandbox.network")}</span>
            <Select
              value={network}
              onChange={setNetwork}
              options={[
                { value: "allow", label: "allow", description: t("settingsX.sandbox.networkAllow") },
                { value: "deny", label: "deny", description: t("settingsX.sandbox.networkDeny") },
              ]}
            />
          </label>
        )}
        {showDetail && (
          <>
            <label className={field}>
              <span className="text-sm text-muted-foreground">{t("settingsX.sandbox.writableRoots")}</span>
              <Textarea
                value={writableRoots}
                onChange={(e) => setWritableRoots(e.target.value)}
                className="min-h-[80px] resize-y font-mono text-sm"
              />
              <span className={hint}>{t("settingsX.sandbox.writableRootsHint")}</span>
            </label>
            <label className={field}>
              <span className="text-sm text-muted-foreground">{t("settingsX.sandbox.deniedReads")}</span>
              <Textarea
                value={deniedReads}
                onChange={(e) => setDeniedReads(e.target.value)}
                className="min-h-[80px] resize-y font-mono text-sm"
              />
              <span className={hint}>{t("settingsX.sandbox.deniedReadsHint")}</span>
            </label>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="solid" className="w-fit" onClick={() => void save()} disabled={saving}>
          {saving ? t("settingsX.sandbox.saving") : t("settingsX.sandbox.saveBtn")}
        </Button>
        {savedAt && (
          <span className="text-sm text-status-ok">
            {t("settingsX.sandbox.savedAt", { time: new Date(savedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) })}
          </span>
        )}
      </div>
    </div>
  );
}
