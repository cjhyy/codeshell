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

const LANGUAGES: Array<{ id: UILanguage; description: string }> = [
  { id: "zh", description: "界面使用中文" },
  { id: "en", description: "Use English for the interface" },
];

function LanguageBlock() {
  const [lang, setLang] = useState<UILanguage>(() => loadUILanguage());

  const choose = (next: UILanguage): void => {
    setLang(next);
    saveUILanguage(next);
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">语言</h3>
      <p className="settings-section-help">
        应用界面语言。实际文案翻译仍在逐步完善中。
      </p>
      <div className="settings-option-grid">
        {LANGUAGES.map((item) => (
          <button
            key={item.id}
            className={`settings-option-card${lang === item.id ? " active" : ""}`}
            onClick={() => choose(item.id)}
          >
            <span className="settings-option-title">{languageLabel(item.id)}</span>
            <span className="settings-option-desc">{item.description}</span>
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
