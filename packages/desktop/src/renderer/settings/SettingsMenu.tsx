import React, { useEffect, useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  Cpu,
  Lock,
  Download,
  Activity,
  ScrollText,
  ShieldAlert,
  ArrowRight,
} from "lucide-react";
import { SettingsModal } from "./SettingsModal";

export type SettingsSection =
  | "model"
  | "permission"
  | "mcp"
  | "update"
  | "approvals"
  | "runs"
  | "logs"
  | "json";

interface Props {
  activeRepoPath: string | null;
  onOpenApprovals: () => void;
  onOpenRuns: () => void;
  onOpenLogs: () => void;
  /** Switch to the full-page Settings view. */
  onOpenSettingsPage: () => void;
}

/**
 * Bottom-left settings entry.
 *
 * Clicking opens an upward popover with quick shortcuts. The full
 * Settings page lives behind '打开设置…' at the bottom — clicking it
 * navigates to viewMode === 'settings_page' (handled by App).
 *
 * Quick shortcuts (model / permission / update) open the legacy
 * focused modal for speed; deep configuration lives on the page.
 */
export function SettingsMenu({
  activeRepoPath,
  onOpenApprovals,
  onOpenRuns,
  onOpenLogs,
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
    if (id === "approvals") return onOpenApprovals();
    if (id === "runs") return onOpenRuns();
    if (id === "logs") return onOpenLogs();
    setModal(id);
  };

  const quickItems: Array<{
    id: SettingsSection;
    label: string;
    Icon: React.ComponentType<{ size?: number }>;
  }> = [
    { id: "model", label: "模型", Icon: Cpu },
    { id: "permission", label: "权限", Icon: Lock },
    { id: "update", label: "更新", Icon: Download },
    { id: "approvals", label: "审批历史", Icon: ShieldAlert },
    { id: "runs", label: "运行", Icon: Activity },
    { id: "logs", label: "日志", Icon: ScrollText },
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
          {quickItems.map(({ id, label, Icon }) => (
            <li key={id} className="settings-popover-item" onClick={() => pick(id)}>
              <Icon size={13} />
              <span>{label}</span>
            </li>
          ))}
          <li className="settings-popover-divider" />
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
