import React, { useState } from "react";
import { applyTheme, loadTheme, saveTheme, type Theme } from "../theme";
import { cn } from "@/lib/utils";

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
    <section className="mb-6 flex flex-col gap-3">
      <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">主题</h3>
      <p className="m-0 text-xs text-muted-foreground">选择应用界面的显示模式。</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        {THEMES.map((item) => (
          <button
            key={item.id}
            className={cn(
              "flex cursor-pointer flex-col items-start gap-1 rounded-md border bg-transparent p-3 text-left hover:bg-accent",
              theme === item.id && "border-primary bg-primary/10 ring-1 ring-primary/30",
            )}
            onClick={() => choose(item.id)}
          >
            <span className="text-sm font-medium text-foreground">{item.label}</span>
            <span className="text-xs text-muted-foreground">{item.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
