/**
 * SandboxSection — sandbox (isolation + network) config, scoped global or per
 * project. Split out of the local-environment editor so it's decoupled from
 * env (which used to save sandbox together, mis-writing a default 'auto' the
 * user never chose). Model (see 2026-06-16-sandbox-scope-model-design.md):
 *   - global default = off (don't write sandbox = off).
 *   - project "跟随全局" = don't write the project's sandbox field.
 *   - project/global with a mode = that applies (engine resolves
 *     config > project > global > default).
 */
import React, { useCallback, useState } from "react";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ProjectPicker } from "./ProjectPicker";
import { repoLabel, type Repo } from "../repos";
import { writeSettings } from "../settingsBus";
import { useRefreshOnSettingsChange } from "./useSettingsResource";

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
  // selectedPath: null = global (user scope); a repo path = that project.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const isGlobal = selectedPath === null;
  const scope = isGlobal ? "user" : "project";
  const cwd = isGlobal ? undefined : selectedPath;

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

  const selectedRepo = repos.find((r) => r.path === selectedPath);
  const field = "flex flex-col gap-1.5";
  const hint = "mt-1 text-xs text-muted-foreground";
  const modeOptions = [
    ...(isGlobal ? [] : [{ value: FOLLOW, label: "跟随全局", description: "用全局沙箱设置（默认）" }]),
    { value: "off", label: "off", description: "关闭沙箱（不隔离）" },
    { value: "auto", label: "auto", description: "按平台自动选择（macOS Seatbelt / Linux bwrap）" },
    { value: "seatbelt", label: "seatbelt", description: "macOS 沙箱" },
    { value: "bwrap", label: "bwrap", description: "Linux Bubblewrap" },
  ];

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">沙箱</h3>
        <p className="text-sm text-muted-foreground">
          Shell 命令的 OS 级隔离与网络策略。全局默认关闭；项目可单独配置或跟随全局。
        </p>
      </div>

      <ProjectPicker
        repos={repos}
        includeGlobal
        onSelect={(path) => setSelectedPath(path)}
      />

      <div className="rounded-md border border-border bg-muted/40 p-2 text-sm text-muted-foreground">
        当前编辑：{isGlobal ? "全局（所有项目默认）" : `项目 · ${selectedRepo ? repoLabel(selectedRepo) : selectedPath}`}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className={field}>
          <span className="text-sm text-muted-foreground">模式</span>
          <Select value={mode} onChange={setMode} options={modeOptions} />
        </label>
        {mode !== FOLLOW && mode !== "off" && (
          <label className={field}>
            <span className="text-sm text-muted-foreground">网络</span>
            <Select
              value={network}
              onChange={setNetwork}
              options={[
                { value: "allow", label: "allow", description: "允许访问网络" },
                { value: "deny", label: "deny", description: "拒绝网络访问" },
              ]}
            />
          </label>
        )}
        {mode !== FOLLOW && mode !== "off" && (
          <>
            <label className={field}>
              <span className="text-sm text-muted-foreground">可写路径</span>
              <Textarea
                value={writableRoots}
                onChange={(e) => setWritableRoots(e.target.value)}
                className="min-h-[80px] resize-y font-mono text-sm"
              />
              <span className={hint}>每行一个，支持 ${"{workspace}"}、~。命令可写范围。</span>
            </label>
            <label className={field}>
              <span className="text-sm text-muted-foreground">禁读路径</span>
              <Textarea
                value={deniedReads}
                onChange={(e) => setDeniedReads(e.target.value)}
                className="min-h-[80px] resize-y font-mono text-sm"
              />
              <span className={hint}>每行一个，读取这些路径会被沙箱拦截。</span>
            </label>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="solid" className="w-fit" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中..." : "保存沙箱设置"}
        </Button>
        {savedAt && (
          <span className="text-sm text-status-ok">
            已保存 · {new Date(savedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    </section>
  );
}
