import React from "react";
import { Keyboard } from "lucide-react";
import { useT } from "../i18n/I18nProvider";

interface Shortcut {
  label: string;
  keys: string[];
  hint?: string;
}

export function ShortcutsSection({ isMac = false }: { isMac?: boolean }) {
  const { t } = useT();
  const id = React.useId();
  const mod = isMac ? "⌘" : "Ctrl";
  // App.tsx owns Mod+K/P/F/B/1–9. The native new-window accelerator
  // lives in main/menu.ts, whose menu is installed only on macOS.
  const navigation: Shortcut[] = [
    { label: t("settingsX.adv.scCommandPalette"), keys: [mod, "K"] },
    { label: t("settingsX.adv.scSearchAll"), keys: [mod, "P"] },
    { label: t("settingsX.adv.scToggleSidebar"), keys: [mod, "B"] },
    { label: t("settingsX.adv.scJumpSession"), keys: [mod, "1–9"] },
    ...(isMac ? [{ label: t("settingsX.adv.scNewWindow"), keys: [mod, "Shift", "N"] }] : []),
  ];
  // Composer history is entered only from an empty input; once browsing,
  // Down returns toward the draft. Do not present these as app-global keys.
  const conversation: Shortcut[] = [
    { label: t("settingsX.adv.scSearchConv"), keys: [mod, "F"] },
    { label: t("settingsX.adv.scSend"), keys: ["Enter"] },
    { label: t("settingsX.adv.scNewline"), keys: ["Shift", "Enter"] },
    {
      label: t("settingsX.adv.scPreviousInput"),
      keys: ["↑"],
      hint: t("settingsX.adv.scPreviousInputHint"),
    },
    {
      label: t("settingsX.adv.scNextInput"),
      keys: ["↓"],
      hint: t("settingsX.adv.scNextInputHint"),
    },
  ];
  const groups = [
    { id: `${id}-navigation`, title: t("settingsX.adv.scNavigationGroup"), rows: navigation },
    { id: `${id}-conversation`, title: t("settingsX.adv.scConversationGroup"), rows: conversation },
  ];

  return (
    <section aria-label={t("settingsX.adv.shortcutsTitle")} className="flex min-w-0 flex-col gap-5">
      <p className="text-sm leading-6 text-muted-foreground">
        {t("settingsX.adv.scDescription", { modifier: isMac ? "⌘" : "Ctrl" })}
      </p>
      {groups.map((group) => (
        <section
          key={group.id}
          aria-labelledby={group.id}
          className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card"
        >
          <h2
            id={group.id}
            className="flex items-center gap-2 border-b border-border/60 bg-muted/25 px-4 py-3 text-sm font-semibold"
          >
            <Keyboard size={15} className="shrink-0 text-primary" aria-hidden="true" />
            {group.title}
          </h2>
          <dl className="divide-y divide-border/60">
            {group.rows.map((shortcut) => (
              <div
                key={shortcut.label}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
              >
                <dt className="min-w-0 text-sm leading-5 [overflow-wrap:anywhere]">
                  {shortcut.label}
                  {shortcut.hint ? (
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {shortcut.hint}
                    </span>
                  ) : null}
                </dt>
                <dd className="flex flex-wrap items-center justify-end gap-1">
                  {shortcut.keys.map((key, index) => (
                    <React.Fragment key={`${key}-${index}`}>
                      {index > 0 ? (
                        <span className="text-[10px] text-muted-foreground" aria-hidden="true">
                          +
                        </span>
                      ) : null}
                      <kbd
                        aria-label={
                          key === "⌘"
                            ? "Command"
                            : key === "↑"
                              ? t("settingsX.adv.scArrowUp")
                              : key === "↓"
                                ? t("settingsX.adv.scArrowDown")
                                : undefined
                        }
                        className="inline-flex min-h-7 min-w-7 items-center justify-center whitespace-nowrap rounded-md border border-border bg-background px-2 font-mono text-[11px] font-medium text-foreground shadow-sm"
                      >
                        {key}
                      </kbd>
                    </React.Fragment>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </section>
  );
}
