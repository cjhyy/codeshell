import React, { useEffect, useState } from "react";
import {
  fromSettingsPermissionMode,
  toCorePermissionMode,
  type PermissionMode,
} from "../chat/PermissionPill";

const MODES: PermissionMode[] = ["plan", "default", "accept_edits", "bypass"];

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

export function PermissionSection({ scope, activeRepoPath }: Props) {
  const [mode, setMode] = useState<PermissionMode | null>(null);
  const [saving, setSaving] = useState(false);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const permissions = s.permissions && typeof s.permissions === "object"
      ? (s.permissions as Record<string, unknown>)
      : {};
    setMode(fromSettingsPermissionMode(s.permissionMode ?? permissions.defaultMode));
  };

  useEffect(() => {
    void load();
  }, [scope, activeRepoPath]);

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
