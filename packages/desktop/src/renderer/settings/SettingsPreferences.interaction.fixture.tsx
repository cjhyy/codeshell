// Keep adjacent section mocks and owned storage/media sources in this child process.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const rootClasses = new Set<string>();
Object.defineProperty(document.documentElement, "classList", {
  value: {
    contains: (name: string) => rootClasses.has(name),
    toggle: (name: string, enabled: boolean) =>
      enabled ? rootClasses.add(name) : rootClasses.delete(name),
  },
});
let deniedFetches = 0;
globalThis.fetch = (() => {
  deniedFetches++;
  throw new Error("Preference fixture denies fetch");
}) as unknown as typeof fetch;
Object.assign(globalThis, { dispatchEvent: window.dispatchEvent.bind(window) });
const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
};
Object.assign(globalThis, { localStorage: storage });
Object.assign(window, {
  localStorage: storage,
  codeshell: { listInstalledThemes: async () => [] },
});
let systemDark = false;
const mediaListeners = new Set<() => void>();
Object.assign(window, {
  matchMedia: () => ({
    get matches() {
      return systemDark;
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }),
});
mock.module("./PermissionSection", () => ({ PermissionSection: () => null }));
mock.module("../updater/UpdaterBanner", () => ({ UpdaterSettingsRow: () => null }));
const { GeneralSection } = await import("./GeneralSection");
const { AppearanceSection } = await import("./AppearanceSection");
const { I18nProvider } = await import("../i18n/I18nProvider");
const { DialogProvider } = await import("../ui/DialogProvider");
const { saveUILanguage } = await import("../uiLanguage");
const { initTheme } = await import("../theme");
const scenario = process.argv[2];
if (scenario === "language-clear") storage.setItem("codeshell.uiLanguage", "en");
if (scenario === "theme-system-after-manual") storage.setItem("codeshell.theme", "dark");
initTheme();
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const nodes = (node: any): any[] => [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  if (node.nodeType === 3) return node.data ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(text).join("") : (node.textContent ?? "");
}
function findButton(predicate: (node: any) => boolean) {
  const button = nodes(container).find((node) => node.tagName === "BUTTON" && predicate(node));
  assert.ok(button, "Expected the production preference control");
  return button;
}
const language = (label: string) => findButton((node) => text(node).startsWith(label));
const mode = (id: string) => findButton((node) => props(node)["data-theme-mode"] === id);
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function media(dark: boolean) {
  await update(() => {
    systemDark = dark;
    for (const listener of mediaListeners) listener();
  });
}
async function changedStorage(key: string | null) {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: key });
  await update(() => window.dispatchEvent(event));
}
try {
  await update(() =>
    root.render(
      <I18nProvider>
        <DialogProvider>
          <GeneralSection scope="user" activeProjectPath={null} />
          <AppearanceSection />
        </DialogProvider>
      </I18nProvider>,
    ),
  );
  if (scenario.startsWith("language-")) {
    if (scenario === "language-card") await update(() => props(language("English")).onClick());
    else if (scenario === "language-local-change") await update(() => saveUILanguage("en"));
    else if (scenario === "language-storage") {
      storage.setItem("codeshell.uiLanguage", "en");
      await changedStorage("codeshell.uiLanguage");
    } else if (scenario === "language-clear") {
      storage.clear();
      await changedStorage(null);
    } else throw new Error("Unknown language scenario");
    const label = scenario === "language-clear" ? "中文" : "English";
    const heading = nodes(container).find((node) => node.tagName === "H3");
    assert.equal(text(heading), scenario === "language-clear" ? "语言" : "Language");
    assert.ok(
      props(language(label)).className.split(/\s+/).includes("ring-1"),
      "The selected language card is stale",
    );
    storage.setItem("codeshell.uiLanguage", label === "English" ? "zh" : "en");
    await changedStorage("unrelated-owned-key");
    assert.equal(
      text(nodes(container).find((node) => node.tagName === "H3")),
      scenario === "language-clear" ? "语言" : "Language",
    );
  } else if (scenario === "theme-manual-after-system") {
    await update(() => props(mode("dark")).onClick());
    await media(true);
    await media(false);
    assert.equal(storage.getItem("codeshell.theme"), "dark");
    assert.equal(props(mode("dark"))["aria-pressed"], true);
    assert.equal(
      document.documentElement.classList.contains("dark"),
      true,
      "System media overrode manual dark",
    );
  } else if (scenario === "theme-system-after-manual") {
    await update(() => props(mode("system")).onClick());
    await media(true);
    assert.equal(
      document.documentElement.classList.contains("dark"),
      true,
      "System mode did not subscribe after manual startup",
    );
    await media(false);
    assert.equal(document.documentElement.classList.contains("dark"), false);
  } else if (scenario === "theme-system") {
    await media(true);
    assert.equal(document.documentElement.classList.contains("dark"), true);
    await media(false);
    assert.equal(document.documentElement.classList.contains("dark"), false);
  } else throw new Error("Unknown preference scenario");
  assert.equal(deniedFetches, 0);
  console.log(JSON.stringify({ scenario, passed: true, deniedFetches }));
} finally {
  await act(async () => root.unmount());
  container.parentNode?.removeChild(container);
}
