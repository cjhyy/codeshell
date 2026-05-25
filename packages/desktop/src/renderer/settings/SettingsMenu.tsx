import React, { useEffect, useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  Cpu,
  Lock,
  Download,
  Plug,
  ArrowRight,
} from "lucide-react";
import { SettingsModal } from "./SettingsModal";

export type SettingsSection =
  | "model"
  | "permission"
  | "mcp"
  | "update"
  | "json";

interface Props {
  activeRepoPath: string | null;
  /** Switch to the full-page Settings view. */
  onOpenSettingsPage: () => void;
}

/**
 * Bottom-left settings entry.
 *
 * Clicking opens an upward popover with quick shortcuts. The full
 * Settings page lives behind the primary row — clicking it
 * navigates to viewMode === 'settings_page' (handled by App).
 *
 * Quick shortcuts (model / permission / mcp / update) open the legacy
 * focused modal for speed; deep configuration lives on the page.
 */
export function SettingsMenu({
  activeRepoPath,
  onOpenSettingsPage,
}: Props) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<SettingsSection | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const pick = (id: SettingsSection): void => {
    setOpen(false);
    setModal(id);
  };

  const quickItems: Array<{
    id: SettingsSection;
    label: string;
    Icon: React.ComponentType<{ size?: number }>;
  }> = [
    { id: "model", label: "模型配置", Icon: Cpu },
    { id: "permission", label: "权限默认值", Icon: Lock },
    { id: "mcp", label: "MCP", Icon: Plug },
    { id: "update", label: "检查更新", Icon: Download },
  ];

  return (
    <div className="settings-menu" ref={ref}>
      <button
        className={`sidebar-item settings-menu-trigger${open ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <SettingsIcon size={14} />
        <span className="sidebar-item-label">设置</span>
      </button>
      {open && (
        <ul className="settings-popover">
          <li
            className="settings-popover-item settings-popover-primary"
            onClick={() => {
              setOpen(false);
              onOpenSettingsPage();
            }}
          >
            <SettingsIcon size={13} />
            <span>打开设置…</span>
            <ArrowRight size={11} className="settings-popover-chevron" />
          </li>
          <li className="settings-popover-divider" />
          {quickItems.map(({ id, label, Icon }) => (
            <li key={id} className="settings-popover-item" onClick={() => pick(id)}>
              <Icon size={13} />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      )}
      {modal && (
        <SettingsModal
          section={modal}
          activeRepoPath={activeRepoPath}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
