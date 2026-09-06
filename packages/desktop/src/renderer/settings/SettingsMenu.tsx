import React, { useRef, useState } from "react";
import {
  Settings as SettingsIcon,
  Globe,
  ArrowRight,
  Ghost,
  History,
  MessageSquare,
  Activity,
  ShieldCheck,
  ScrollText,
} from "lucide-react";
import { saveUILanguage, languageLabel, type UILanguage } from "../uiLanguage";
import { useT } from "../i18n/I18nProvider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type ActivityPage = "sessions" | "runs" | "approvals" | "logs";

interface Props {
  onOpenSettingsPage: () => void;
  /** History pages also stay available from the global command palette. */
  onNavigate?: (page: ActivityPage) => void;
  /** When sidebar is collapsed the trigger goes straight to settings. */
  sidebarCollapsed?: boolean;
  petWidgetVisible: boolean;
  onTogglePetWidget: () => void;
}

const LANGUAGES: UILanguage[] = ["zh", "en"];

/** Bottom settings menu, with explicit click/keyboard submenus and native menu focus. */
export function SettingsMenu({
  onOpenSettingsPage,
  onNavigate,
  sidebarCollapsed,
  petWidgetVisible,
  onTogglePetWidget,
}: Props) {
  const { t, lang } = useT();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<"activity" | "language" | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const languageRef = useRef<HTMLDivElement>(null);
  const closeThenNavigate = (navigate: () => void) => {
    pendingNavigationRef.current = navigate;
    setSubmenu(null);
    setOpen(false);
  };
  const closeSubmenu = (event: KeyboardEvent, kind: "activity" | "language") => {
    event.preventDefault();
    if (event.isComposing || event.keyCode === 229) return;
    setSubmenu(null);
    (kind === "activity" ? activityRef : languageRef).current?.focus();
  };
  const trigger = (
    <Button
      ref={triggerRef}
      type="button"
      variant="ghost"
      className={cn(
        "h-9 w-full justify-start gap-2 rounded-lg px-2 text-sm text-muted-foreground",
        open && "bg-accent text-accent-foreground",
      )}
      onClick={sidebarCollapsed ? onOpenSettingsPage : undefined}
    >
      <SettingsIcon size={14} className="shrink-0" aria-hidden />
      <span className="truncate">{t("settingsX.menu.settings")}</span>
    </Button>
  );
  if (sidebarCollapsed) return trigger;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) pendingNavigationRef.current = null;
        setOpen(next);
        if (!next) setSubmenu(null);
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={t("settingsX.menu.settings")}
        side="top"
        align="start"
        className="w-60 max-w-[calc(100vw-1.5rem)] rounded-xl p-1.5"
        onCloseAutoFocus={(event) => {
          const navigate = pendingNavigationRef.current;
          if (!navigate) return;
          pendingNavigationRef.current = null;
          event.preventDefault();
          triggerRef.current?.focus({ preventScroll: true });
          // Let the menu release its modal pointer/focus locks before its
          // parent drawer closes or the settings surface replaces the chrome.
          navigate();
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing || event.keyCode === 229) event.preventDefault();
        }}
      >
        {onNavigate && (
          <DropdownMenuSub
            open={submenu === "activity"}
            onOpenChange={(next) => setSubmenu(next ? "activity" : null)}
          >
            <DropdownMenuSubTrigger
              ref={activityRef}
              className="gap-2 rounded-lg py-2"
              onPointerMove={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                setSubmenu((current) => (current === "activity" ? null : "activity"));
              }}
            >
              <History size={14} aria-hidden />
              {t("settingsX.menu.activity")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                aria-label={t("settingsX.menu.activity")}
                className="w-48 min-w-0 max-w-[min(var(--radix-dropdown-menu-content-available-width),calc(100vw-1.5rem))] rounded-xl p-1.5"
                onEscapeKeyDown={(event) => closeSubmenu(event, "activity")}
              >
                {[
                  {
                    page: "sessions" as const,
                    label: t("auto.sessions.title"),
                    Icon: MessageSquare,
                  },
                  { page: "runs" as const, label: t("auto.runs.title"), Icon: Activity },
                  {
                    page: "approvals" as const,
                    label: t("auto.approvals.title"),
                    Icon: ShieldCheck,
                  },
                  { page: "logs" as const, label: t("auto.logs.title"), Icon: ScrollText },
                ].map(({ page, label, Icon }) => (
                  <DropdownMenuItem
                    key={page}
                    className="rounded-lg py-2"
                    onSelect={() => closeThenNavigate(() => onNavigate(page))}
                  >
                    <Icon size={14} aria-hidden />
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem className="rounded-lg py-2" onSelect={onTogglePetWidget}>
          <Ghost size={14} aria-hidden />
          {t(petWidgetVisible ? "pet.widget.hide" : "pet.widget.show")}
        </DropdownMenuItem>
        <DropdownMenuSub
          open={submenu === "language"}
          onOpenChange={(next) => setSubmenu(next ? "language" : null)}
        >
          <DropdownMenuSubTrigger
            ref={languageRef}
            className="gap-2 rounded-lg py-2"
            onPointerMove={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault();
              setSubmenu((current) => (current === "language" ? null : "language"));
            }}
          >
            <Globe size={14} aria-hidden />
            {t("settingsX.menu.switchLanguage")}
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent
              aria-label={t("settingsX.menu.switchLanguage")}
              className="w-44 min-w-0 max-w-[min(var(--radix-dropdown-menu-content-available-width),calc(100vw-1.5rem))] rounded-xl p-1.5"
              onEscapeKeyDown={(event) => closeSubmenu(event, "language")}
            >
              <DropdownMenuRadioGroup
                value={lang}
                onValueChange={(value) => {
                  if (LANGUAGES.includes(value as UILanguage)) saveUILanguage(value as UILanguage);
                }}
              >
                {LANGUAGES.map((code) => (
                  <DropdownMenuRadioItem key={code} value={code} className="rounded-lg py-2">
                    {languageLabel(code)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="rounded-lg py-2 font-medium text-primary"
          onSelect={() => closeThenNavigate(onOpenSettingsPage)}
        >
          <SettingsIcon size={14} aria-hidden />
          {t("settingsX.menu.openSettings")}
          <ArrowRight size={12} className="ml-auto" aria-hidden />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
