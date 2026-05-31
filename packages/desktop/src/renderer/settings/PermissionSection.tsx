import React, { useEffect, useState } from "react";
import {
  fromSettingsPermissionMode,
  toCorePermissionMode,
  type PermissionMode,
} from "../chat/PermissionPill";

const MODES: PermissionMode[] = ["plan", "default", "accept_edits", "bypass"];
const MODE_LABELS: Record<PermissionMode, string> = {
  plan: "计划模式",
  default: "默认权限",
  accept_edits: "接受编辑",
  bypass: "完全访问权限",
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
    try {
      const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
      const permissions = s.permissions && typeof s.permissions === "object"
        ? (s.permissions as Record<string, unknown>)
        : {};
      setMode(fromSettingsPermissionMode(s.permissionMode ?? permissions.defaultMode));
    } catch (err) {
      console.error("getSettings failed", err);
    }
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
    } catch (err) {
      console.error("updateSettings failed", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">默认权限</h3>
      <p className="settings-section-help">
        新会话默认的权限模式；对话中输入框里的临时权限只影响当前对话。
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
