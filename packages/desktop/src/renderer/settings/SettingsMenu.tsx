import React, { useEffect, useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  Globe,
  Check,
  ArrowRight,
  ChevronRight,
} from "lucide-react";
import {
  loadUILanguage,
  saveUILanguage,
  languageLabel,
  type UILanguage,
} from "../uiLanguage";

interface Props {
  /** Switch to the full-page Settings view. */
  onOpenSettingsPage: () => void;
  /** When sidebar is collapsed the trigger goes straight to settings. */
  sidebarCollapsed?: boolean;
}

const LANGUAGES: UILanguage[] = ["zh", "en"];

/**
 * Bottom-left settings entry.
 *
 * Clicking opens an upward popover with two items: "打开设置…" navigates
 * to the full Settings page, and "切换语言" reveals a cascading submenu
 * on the right for picking the UI language (no dialog).
 *
 * The submenu is `position: fixed` and anchored to the hovered item's
 * bounding rect, so it escapes the sidebar's `overflow: hidden` instead
 * of being clipped by it (same approach as the project ContextMenu).
 */
export function SettingsMenu({ onOpenSettingsPage, sidebarCollapsed }: Props) {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<UILanguage>(() => loadUILanguage());
  const [submenu, setSubmenu] = useState<{ left: number; top: number } | null>(null);
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

  // Closing the whole popover also retracts the submenu.
  useEffect(() => {
    if (!open) setSubmenu(null);
  }, [open]);

  const openSubmenu = (e: React.MouseEvent<HTMLLIElement>): void => {
    const r = e.currentTarget.getBoundingClientRect();
    setSubmenu({ left: r.right + 4, top: r.top - 4 });
  };

  const chooseLanguage = (next: UILanguage): void => {
    setLang(next);
    saveUILanguage(next);
    setOpen(false);
  };

  return (
    <div className="settings-menu" ref={ref}>
      <button
        className={`sidebar-item settings-menu-trigger${open ? " active" : ""}`}
        onClick={sidebarCollapsed ? onOpenSettingsPage : () => setOpen((o) => !o)}
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
          <li
            className="settings-popover-item"
            onMouseEnter={openSubmenu}
          >
            <Globe size={13} />
            <span>切换语言</span>
            <ChevronRight size={12} className="settings-popover-chevron" />
          </li>
        </ul>
      )}
      {open && submenu && (
        <ul
          className="settings-submenu"
          style={{ left: submenu.left, top: submenu.top }}
        >
          {LANGUAGES.map((code) => (
            <li
              key={code}
              className="settings-popover-item"
              onClick={() => chooseLanguage(code)}
            >
              <span className="settings-submenu-check">
                {lang === code && <Check size={12} />}
              </span>
              <span>{languageLabel(code)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
