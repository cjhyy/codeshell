import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";
import { cn } from "@/lib/utils";
import { useT } from "../../i18n";
import { usePetSprite } from "../../petSprite";
import { MIMI_SETTINGS_SECTIONS, type MimiSettingsSection } from "./mimiSettingsSections";
import { MIMI_SETTINGS_SECTION_META } from "./sectionMeta";

export interface PetSettingsShellProps {
  section: MimiSettingsSection;
  onSectionChange: (section: MimiSettingsSection) => void;
  /** Names the surface "back" returns to (Mimi, Settings, Credentials…). */
  backLabel: string;
  onBack: () => void;
  /**
   * The active section's content. As a function it gets `jumpTo`, for links
   * inside a section ("管理消息连接"): it opens the target section and moves
   * focus to that section's heading, as choosing from the narrow picker does.
   */
  children: ReactNode | ((jumpTo: (section: MimiSettingsSection) => void) => ReactNode);
}

/**
 * Mimi settings layout: a left section list beside one section at a time.
 * Below 720px of its own width the list becomes a select above the content,
 * so the page also fits beside the app sidebar in a narrow window.
 */
export function PetSettingsShell({
  section,
  onSectionChange,
  backLabel,
  onBack,
  children,
}: PetSettingsShellProps) {
  const { t } = useT();
  const sprite = usePetSprite();
  const contentRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navItems = useRef(new Map<MimiSettingsSection, HTMLButtonElement>());
  const focusHeading = useRef(false);
  const meta = MIMI_SETTINGS_SECTION_META[section];
  const SectionIcon = meta.Icon;

  useLayoutEffect(() => {
    // Each section starts at its heading, however far the previous one scrolled.
    if (contentRef.current) contentRef.current.scrollTop = 0;
    if (focusHeading.current) {
      focusHeading.current = false;
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [section]);

  const jumpTo = (next: MimiSettingsSection) => {
    focusHeading.current = true;
    onSectionChange(next);
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = MIMI_SETTINGS_SECTIONS.length - 1;
    const next =
      event.key === "ArrowDown"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowUp"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    navItems.current.get(MIMI_SETTINGS_SECTIONS[next])?.focus();
  };

  return (
    <section
      className="@container/mimi-settings flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      aria-label={t("pet.settings.title")}
      data-pet-settings-page="standalone"
    >
      <div className="flex min-h-0 flex-1 @max-[720px]/mimi-settings:flex-col">
        <nav
          aria-label={t("mimiSettings.navLabel")}
          className="flex min-h-0 w-60 shrink-0 flex-col border-r border-border/70 bg-muted/25 px-3 pb-4 pt-3 @max-[1000px]/mimi-settings:w-56 @max-[720px]/mimi-settings:hidden"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mb-3 h-8 w-full justify-start gap-2 rounded-lg px-2 text-xs text-muted-foreground"
            data-pet-settings-back
            onClick={onBack}
          >
            <ArrowLeft size={14} aria-hidden />
            <span className="truncate">{backLabel}</span>
          </Button>
          <div className="mb-4 flex items-center gap-2.5 px-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <img src={sprite} alt="" draggable={false} className="size-8 object-contain" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold tracking-tight">
                {t("pet.settings.title")}
              </span>
            </span>
          </div>
          <ul className="grid gap-0.5">
            {MIMI_SETTINGS_SECTIONS.map((id, index) => {
              const { Icon, title } = MIMI_SETTINGS_SECTION_META[id];
              const active = id === section;
              return (
                <li key={id}>
                  <Button
                    ref={(node) => {
                      if (node) navItems.current.set(id, node);
                      else navItems.current.delete(id);
                    }}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-[13px] font-normal",
                      active
                        ? "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary"
                        : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                    )}
                    aria-current={active ? "page" : undefined}
                    data-pet-settings-nav-item={id}
                    onClick={() => onSectionChange(id)}
                    onKeyDown={(event) => moveFocus(event, index)}
                  >
                    <Icon size={15} className="shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-left">{t(title)}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="hidden shrink-0 items-center gap-2 border-b border-border/70 bg-muted/25 px-3 py-3 @max-[720px]/mimi-settings:flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={backLabel}
            title={backLabel}
            data-pet-settings-back
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <SimpleSelect<MimiSettingsSection>
            value={section}
            ariaLabel={t("mimiSettings.sectionPicker")}
            className="min-w-0 flex-1 rounded-lg bg-background"
            triggerProps={{ "data-pet-settings-section-picker": true }}
            options={MIMI_SETTINGS_SECTIONS.map((id) => ({
              value: id,
              label: t(MIMI_SETTINGS_SECTION_META[id].title),
            }))}
            onChange={jumpTo}
          />
        </div>

        <div
          ref={contentRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-8 pb-10 pt-8 @max-[1000px]/mimi-settings:px-6 @max-[720px]/mimi-settings:px-4 @max-[720px]/mimi-settings:pt-5"
          data-pet-settings-section={section}
        >
          <div className="mx-auto w-full max-w-4xl">
            <header className="mb-6 flex min-w-0 items-start gap-3.5">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/10 text-primary">
                <SectionIcon size={21} aria-hidden />
              </span>
              <div className="min-w-0">
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="break-words text-xl font-semibold tracking-tight focus:outline-none"
                >
                  {t(meta.title)}
                </h1>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {t(meta.description)}
                </p>
              </div>
            </header>
            <div className="grid min-w-0 gap-5 [&>*]:min-w-0">
              {typeof children === "function" ? children(jumpTo) : children}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
