import React, { useEffect, useState } from "react";
import {
  fromSettingsPermissionMode,
  toCorePermissionMode,
  type PermissionMode,
} from "../chat/PermissionPill";

const MODES: PermissionMode[] = ["plan", "default", "accept_edits", "goal"];
const MODE_LABELS: Record<PermissionMode, string> = {
  plan: "计划模式",
  default: "默认权限",
  accept_edits: "接受编辑",
  goal: "Goal 模式",
};

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
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      setMode(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">默认权限</h3>
      <p className="settings-section-help">
        当前项目设置会覆盖全局默认；输入框里的权限只影响当前对话。
      </p>
      <div className="permission-modes">
        {MODES.map((m) => (
          <button
            key={m}
            className={`logs-bucket${mode === m ? " active" : ""}`}
            disabled={saving}
            onClick={() => void choose(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
    </section>
  );
}
