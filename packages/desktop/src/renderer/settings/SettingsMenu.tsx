import React, { useEffect, useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  Cpu,
  Lock,
  Plug,
  Download,
  Activity,
  ScrollText,
  ShieldAlert,
  Wrench,
  ChevronRight,
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

const ITEMS: Array<{
  id: SettingsSection;
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
}> = [
  { id: "model", label: "模型", Icon: Cpu },
  { id: "permission", label: "权限", Icon: Lock },
  { id: "mcp", label: "MCP 插件", Icon: Plug },
  { id: "update", label: "更新", Icon: Download },
  { id: "approvals", label: "审批历史", Icon: ShieldAlert },
  { id: "runs", label: "运行", Icon: Activity },
  { id: "logs", label: "日志", Icon: ScrollText },
  { id: "json", label: "settings.json", Icon: Wrench },
];

interface Props {
  activeRepoPath: string | null;
  onOpenApprovals: () => void;
  onOpenRuns: () => void;
  onOpenLogs: () => void;
}

/**
 * Bottom-left settings entry: a button that opens a small upward
 * popover. The popover lists sub-sections (模型 / 权限 / MCP / …);
 * clicking one closes the popover and opens a focused SettingsModal
 * dialog containing just that section's form.
 *
 * Routes that already have full-screen views (审批历史 / 运行 / 日志)
 * delegate to the parent via onOpenApprovals/onOpenRuns/onOpenLogs so
 * they keep using the existing viewMode surfaces.
 */
export function SettingsMenu({ activeRepoPath, onOpenApprovals, onOpenRuns, onOpenLogs }: Props) {
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
    // Full-screen views delegate to parent; everything else opens the modal.
    if (id === "approvals") return onOpenApprovals();
    if (id === "runs") return onOpenRuns();
    if (id === "logs") return onOpenLogs();
    setModal(id);
  };

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
          {ITEMS.map(({ id, label, Icon }) => (
            <li
              key={id}
              className="settings-popover-item"
              onClick={() => pick(id)}
            >
              <Icon size={13} />
              <span>{label}</span>
              <ChevronRight size={11} className="settings-popover-chevron" />
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
