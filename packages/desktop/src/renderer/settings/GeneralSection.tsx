/**
 * 常规 (General) settings page.
 *
 * Groups the always-global basics into one scrollable page, matching the
 * reference layout: 权限 (permission default) → 语言 (UI language) →
 * 更新 (app updates). Each block reuses an existing section/row where one
 * exists so we don't fork their behaviour.
 *
 * Note: the reference design also shows "默认打开目标" (external editor)
 * and "在菜单栏中显示" (tray) — both need main-process support that
 * doesn't exist yet, so they're intentionally omitted rather than shipped
 * as no-op switches.
 */
import React, { useState } from "react";
import { PermissionSection } from "./PermissionSection";
import { UpdaterSettingsRow } from "../updater/UpdaterBanner";
import {
  loadUILanguage,
  saveUILanguage,
  languageLabel,
  type UILanguage,
} from "../uiLanguage";
import { cn } from "@/lib/utils";
import { useT } from "../i18n";
import type { TranslationKey } from "../i18n";

const LANGUAGES: Array<{ id: UILanguage; descriptionKey: TranslationKey }> = [
  { id: "zh", descriptionKey: "settings.general.langZhDescription" },
  { id: "en", descriptionKey: "settings.general.langEnDescription" },
];

function LanguageBlock() {
  const { t } = useT();
  const [lang, setLang] = useState<UILanguage>(() => loadUILanguage());

  const choose = (next: UILanguage): void => {
    setLang(next);
    saveUILanguage(next);
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">{t("settings.general.languageTitle")}</h3>
      <p className="m-0 text-xs text-muted-foreground">
        {t("settings.general.languageDescription")}
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {LANGUAGES.map((item) => (
          <button
            key={item.id}
            className={cn(
              "flex cursor-pointer flex-col items-start gap-1 rounded-md border bg-transparent p-3 text-left hover:bg-accent",
              lang === item.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            onClick={() => choose(item.id)}
          >
            <span className="text-sm font-medium text-foreground">{languageLabel(item.id)}</span>
            <span className="text-xs text-muted-foreground">{t(item.descriptionKey)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

export function GeneralSection({ scope, activeRepoPath }: Props) {
  return (
    <>
      <PermissionSection scope={scope} activeRepoPath={activeRepoPath} />
      <LanguageBlock />
      <UpdaterSettingsRow />
    </>
  );
}
