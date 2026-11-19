import React from "react";
import {
  loadThemePreference,
  setThemePreference,
  THEME_CHANGE_EVENT,
  type ThemePreference,
} from "./theme.js";
import "./theme-toggle.css";

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: React.ReactNode }> = [
  {
    value: "system",
    label: "跟随系统",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </>
    ),
  },
  {
    value: "light",
    label: "浅色",
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
  },
  {
    value: "dark",
    label: "深色",
    icon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  },
];

/** The stored appearance choice, kept in sync across toggles and tabs. */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = React.useState(loadThemePreference);
  React.useEffect(() => {
    const sync = () => setPreference(loadThemePreference());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);
  return [preference, setThemePreference];
}

/** Compact three-way appearance switch (system / light / dark), as in Desktop's Appearance settings. */
export function ThemeToggle({ className }: { className?: string }) {
  const [preference, choose] = useThemePreference();
  return (
    <div
      className={`theme-toggle${className ? ` ${className}` : ""}`}
      role="group"
      aria-label="外观"
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={preference === option.value}
          aria-label={option.label}
          title={option.label}
          onClick={() => choose(option.value)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {option.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}
