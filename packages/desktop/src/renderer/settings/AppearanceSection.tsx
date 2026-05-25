import React, { useState } from "react";
import { applyTheme, loadTheme, saveTheme, type Theme } from "../theme";

const THEMES: Array<{ id: Theme; label: string; description: string }> = [
  { id: "system", label: "跟随系统", description: "根据 macOS 外观自动切换" },
  { id: "light", label: "浅色", description: "始终使用浅色界面" },
  { id: "dark", label: "深色", description: "始终使用深色界面" },
];

export function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  const choose = (next: Theme): void => {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">主题</h3>
      <p className="settings-section-help">选择应用界面的显示模式。</p>
      <div className="settings-option-grid">
        {THEMES.map((item) => (
          <button
            key={item.id}
            className={`settings-option-card${theme === item.id ? " active" : ""}`}
            onClick={() => choose(item.id)}
          >
            <span className="settings-option-title">{item.label}</span>
            <span className="settings-option-desc">{item.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
