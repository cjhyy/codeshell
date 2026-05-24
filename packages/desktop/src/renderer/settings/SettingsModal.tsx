import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ModelSection } from "./ModelSection";
import { PermissionSection } from "./PermissionSection";
import { McpSection } from "./McpSection";
import { UpdaterSettingsRow } from "../updater/UpdaterBanner";
import type { SettingsSection } from "./SettingsMenu";

interface Props {
  section: SettingsSection;
  activeRepoPath: string | null;
  onClose: () => void;
}

/**
 * Focused modal that shows just one settings section. Driven by the
 * upward-popover SettingsMenu — pick "模型" and you get the model
 * picker dialog, no full-page settings detour.
 */
export function SettingsModal({ section, activeRepoPath, onClose }: Props) {
  const [scope, setScope] = useState<"user" | "project">("user");

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const title = sectionTitle(section);
  // Project scope only matters for sections that are written to repo
  // settings.json (model/permission/mcp/json). Updates / approvals etc
  // are global.
  const supportsProjectScope =
    section === "model" || section === "permission" || section === "mcp" || section === "json";

  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="settings-modal-head">
          <h2 className="settings-modal-title">{title}</h2>
          {supportsProjectScope && (
            <div className="settings-scope">
              <button
                className={`logs-bucket${scope === "user" ? " active" : ""}`}
                onClick={() => setScope("user")}
              >
                user
              </button>
              <button
                className={`logs-bucket${scope === "project" ? " active" : ""}`}
                disabled={!activeRepoPath}
                title={activeRepoPath ?? "先在左侧选一个项目"}
                onClick={() => setScope("project")}
              >
                project
              </button>
            </div>
          )}
          <button
            className="settings-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-modal-body">
          {section === "model" && (
            <ModelSection scope={scope} activeRepoPath={activeRepoPath} />
          )}
          {section === "permission" && (
            <PermissionSection scope={scope} activeRepoPath={activeRepoPath} />
          )}
          {section === "mcp" && (
            <McpSection scope={scope} activeRepoPath={activeRepoPath} />
          )}
          {section === "update" && <UpdaterSettingsRow />}
          {section === "json" && <JsonEditor scope={scope} activeRepoPath={activeRepoPath} />}
        </div>
      </div>
    </div>
  );
}

function sectionTitle(s: SettingsSection): string {
  switch (s) {
    case "model": return "模型";
    case "permission": return "权限";
    case "mcp": return "MCP 插件";
    case "update": return "更新";
    case "approvals": return "审批历史";
    case "runs": return "运行";
    case "logs": return "日志";
    case "json": return "settings.json";
  }
}

/**
 * Inline JSON editor — was previously the 'json' tab in SettingsView.
 * Kept here so the modal can host it standalone.
 */
function JsonEditor({
  scope,
  activeRepoPath,
}: {
  scope: "user" | "project";
  activeRepoPath: string | null;
}) {
  const [draft, setDraft] = useState<string>("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const refresh = async () => {
    setError(null);
    setLoaded(null);
    try {
      const cur = await window.codeshell.getSettings(scope, cwd);
      const text = cur ? JSON.stringify(cur, null, 2) : "{}";
      setLoaded(text);
      setDraft(text);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, [scope, activeRepoPath]);

  const dirty = draft !== loaded;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch = JSON.parse(draft) as Record<string, unknown>;
      await window.codeshell.updateSettings(scope, patch, cwd);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-current">
        <code>
          {scope === "user" ? "~/.code-shell/settings.json" : (activeRepoPath ?? "(no project)") + "/.code-shell/settings.json"}
        </code>
      </div>
      {error && <div className="view-error">{error}</div>}
      <textarea
        className="settings-editor"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="settings-toolbar">
        <button className="approval-btn deny" onClick={() => void refresh()} disabled={saving}>
          Reload
        </button>
        <button
          className="approval-btn approve"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "Save"}
        </button>
      </div>
    </div>
  );
}
