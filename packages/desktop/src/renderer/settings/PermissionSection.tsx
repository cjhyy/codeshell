import React, { useEffect, useState } from "react";

const MODES = ["plan", "default", "accept_edits", "bypass"] as const;
type Mode = (typeof MODES)[number];

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

export function PermissionSection({ scope, activeRepoPath }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [saving, setSaving] = useState(false);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const m = typeof s.permissionMode === "string" ? (s.permissionMode as Mode) : "default";
    setMode(MODES.includes(m) ? m : "default");
  };

  useEffect(() => {
    void load();
  }, [scope, activeRepoPath]);

  const choose = async (m: Mode) => {
    setSaving(true);
    try {
      await window.codeshell.updateSettings(scope, { permissionMode: m }, cwd);
      setMode(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">Permission mode</h3>
      <p className="settings-section-help">
        <strong>plan</strong>：仅生成方案，所有写工具拒绝。
        <strong>default</strong>：写工具弹审批。
        <strong>accept_edits</strong>：文件编辑自动通过，命令仍审批。
        <strong>bypass</strong>：跳过所有审批 — 仅信任的本地环境使用。
      </p>
      <div className="permission-modes">
        {MODES.map((m) => (
          <button
            key={m}
            className={`logs-bucket${mode === m ? " active" : ""}`}
            disabled={saving}
            onClick={() => void choose(m)}
          >
            {m}
          </button>
        ))}
      </div>
    </section>
  );
}
