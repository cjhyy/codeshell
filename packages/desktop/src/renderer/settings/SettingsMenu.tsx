import React, { useEffect, useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  Globe,
  Check,
  ArrowRight,
  ChevronRight,
  Ghost,
} from "lucide-react";
import { loadUILanguage, saveUILanguage, languageLabel, type UILanguage } from "../uiLanguage";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** Switch to the full-page Settings view. */
  onOpenSettingsPage: () => void;
  /** When sidebar is collapsed the trigger goes straight to settings. */
  sidebarCollapsed?: boolean;
  /** Floating Pet state and toggle live in this bottom menu, not under Pet navigation. */
  petWidgetVisible: boolean;
  onTogglePetWidget: () => void;
}

const LANGUAGES: UILanguage[] = ["zh", "en"];

/**
 * Bottom-left settings entry.
 *
 * Clicking opens an upward popover with navigation, Pet visibility and
 * language controls. Language reveals a cascading submenu on the right.
 *
 * The submenu is `position: fixed` and anchored to the hovered item's
 * bounding rect, so it escapes the sidebar's `overflow: hidden` instead
 * of being clipped by it (same approach as the project ContextMenu).
 */
export function SettingsMenu({
  onOpenSettingsPage,
  sidebarCollapsed,
  petWidgetVisible,
  onTogglePetWidget,
}: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<UILanguage>(() => loadUILanguage());
  const [submenu, setSubmenu] = useState<{ left: number; bottom: number } | null>(null);
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

  const openSubmenu = (element: HTMLElement): void => {
    const r = element.getBoundingClientRect();
    // Anchor the submenu's BOTTOM to the trigger item's bottom so it grows
    // upward — the settings menu lives in the bottom-left corner, so a
    // downward submenu would overflow the viewport. Clamp left into the
    // viewport in case the sidebar is wide.
    const left = Math.min(r.right + 4, window.innerWidth - 176 - 8);
    setSubmenu({ left: Math.max(8, left), bottom: window.innerHeight - r.bottom - 4 });
  };

  const chooseLanguage = (next: UILanguage): void => {
    setLang(next);
    saveUILanguage(next);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant="ghost"
        className={cn(
          "h-9 w-full justify-start gap-2 px-2 text-sm text-muted-foreground",
          open && "bg-accent text-accent-foreground",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={sidebarCollapsed ? onOpenSettingsPage : () => setOpen((o) => !o)}
      >
        <SettingsIcon size={14} className="shrink-0" />
        <span className="truncate">{t("settingsX.menu.settings")}</span>
      </Button>
      {open && (
        <ul
          role="menu"
          className="cs-popup-surface absolute bottom-full left-0 z-40 mb-2 min-w-56 rounded-md p-1"
        >
          <li role="none">
            <Button
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              className="cs-menu-item h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-medium text-primary"
              onClick={() => {
                setOpen(false);
                onOpenSettingsPage();
              }}
            >
              <SettingsIcon size={13} />
              <span>{t("settingsX.menu.openSettings")}</span>
              <ArrowRight size={11} className="ml-auto text-muted-foreground" />
            </Button>
          </li>
          <li role="separator" className="my-1 h-px bg-border" />
          <li role="none">
            <Button
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              className="cs-menu-item h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-normal"
              onClick={() => {
                onTogglePetWidget();
                setOpen(false);
              }}
            >
              <Ghost size={14} />
              <span>{t(petWidgetVisible ? "pet.widget.hide" : "pet.widget.show")}</span>
            </Button>
          </li>
          <li role="none">
            <Button
              type="button"
              role="menuitem"
              variant="ghost"
              size="sm"
              className="cs-menu-item h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-normal"
              aria-haspopup="menu"
              aria-expanded={submenu !== null}
              onMouseEnter={(event) => openSubmenu(event.currentTarget)}
              onFocus={(event) => openSubmenu(event.currentTarget)}
            >
              <Globe size={13} />
              <span>{t("settingsX.menu.switchLanguage")}</span>
              <ChevronRight size={12} className="ml-auto text-muted-foreground" />
            </Button>
          </li>
        </ul>
      )}
      {open && submenu && (
        <ul
          role="menu"
          className="cs-popup-surface fixed z-50 min-w-44 rounded-md p-1"
          style={{ left: submenu.left, bottom: submenu.bottom }}
        >
          {LANGUAGES.map((code) => (
            <li key={code} role="none">
              <Button
                type="button"
                role="menuitemradio"
                aria-checked={lang === code}
                variant="ghost"
                size="sm"
                className="cs-menu-item h-auto w-full justify-start gap-2 px-2 py-1.5 text-sm font-normal"
                onClick={() => chooseLanguage(code)}
              >
                <span className="flex-1 text-left">{languageLabel(code)}</span>
                <span className="text-primary">{lang === code && <Check size={12} />}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
