import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectionBanner,
  isImeComposing,
  submitsOnEnter,
  transferredFiles,
} from "./composer-input.js";
import type { WorkbenchController } from "./workbench-types.js";

describe("composer Enter handling", () => {
  test("IME confirmation is detected from isComposing or Safari's keyCode 229", () => {
    expect(isImeComposing({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeComposing({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(isImeComposing({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(isImeComposing({ key: "Enter", keyCode: 13 })).toBe(false);
  });

  test("Enter submits on wide screens only, never with Shift or during IME", () => {
    expect(submitsOnEnter({ key: "Enter", keyCode: 13 }, false)).toBe(true);
    expect(submitsOnEnter({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(submitsOnEnter({ key: "Enter", keyCode: 229 }, false)).toBe(false);
    expect(submitsOnEnter({ key: "Enter" }, true)).toBe(false);
    expect(submitsOnEnter({ key: "a" }, false)).toBe(false);
  });
});

describe("transferred files", () => {
  test("only a non-empty file list counts; plain-text paste is left alone", () => {
    const files = { length: 1 } as unknown as FileList;
    expect(transferredFiles({ files } as DataTransfer)).toBe(files);
    expect(transferredFiles({ files: { length: 0 } } as unknown as DataTransfer)).toBeNull();
    expect(transferredFiles(null)).toBeNull();
  });
});

describe("ConnectionBanner", () => {
  const banner = (patch: Partial<WorkbenchController>) =>
    renderToStaticMarkup(
      <ConnectionBanner controller={{ connection: "closed", ...patch } as WorkbenchController} />,
    );

  test("offers an immediate retry only while closed and only when supported", () => {
    const retryConnection = () => {};
    const label = "立即重连";
    expect(banner({ retryConnection })).toContain(label);
    expect(banner({})).not.toContain(label);
    expect(banner({ connection: "connecting", retryConnection })).not.toContain(label);
    expect(banner({ connection: "open", retryConnection })).toBe("");
  });

  test("keeps the host-provided connection message", () => {
    expect(banner({ connectionMessage: "暂时无法连接电脑" })).toContain("暂时无法连接电脑");
    expect(banner({})).toContain("已断开，重连中…");
  });
});

describe("web app shell", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  test("viewport reaches the safe areas so env(safe-area-inset-*) padding applies", () => {
    expect(html).toMatch(/name="viewport"[\s\S]*viewport-fit=cover/);
    expect(html).toMatch(/interactive-widget=resizes-content/);
  });
  test("browser chrome follows the light and dark theme", () => {
    expect(html).toMatch(/theme-color" media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/theme-color" media="\(prefers-color-scheme: dark\)"/);
  });
});
