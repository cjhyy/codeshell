import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FolderTree } from "lucide-react";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PanelCatalogContext, type PanelCatalogState } from "./PanelCatalogContext";
import { PanelLauncher } from "./PanelLauncher";
import type { PanelEntry } from "./PanelRegistry";

const nodes = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(nodes)];
const text = (node: any): string =>
  node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : node.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node.textContent ?? "");
const props = (node: any): Record<string, any> => {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
};
const tool: PanelEntry = {
  key: "catalog-tool",
  owner: { kind: "builtin" },
  title: { kind: "literal", value: "Available tool" },
  icon: FolderTree,
  order: 0,
  singleton: false,
  enabled: () => true,
  render: () => null,
};
let root: Root | null;
let container: HTMLElement;
let refreshes = 0;
let picks: string[] = [];
const refresh = () => {
  refreshes++;
};
const render = async ({
  loading = false,
  error = null,
  active = true,
  focusRequest = 0,
  entries = [],
}: {
  loading?: boolean;
  error?: string | null;
  active?: boolean;
  focusRequest?: number;
  entries?: readonly PanelEntry[];
} = {}) => {
  const state: PanelCatalogState = { loading, error, refresh };
  await act(async () => {
    root!.render(
      <PanelCatalogContext.Provider value={state}>
        <PanelLauncher
          entries={entries}
          onPick={(kind) => picks.push(kind)}
          active={active}
          focusRequest={focusRequest}
        />
      </PanelCatalogContext.Provider>,
    );
    await flushMicrotasks();
  });
};
const refreshButton = () =>
  nodes(container).find((node) => props(node)["data-panel-launcher-refresh"] !== undefined);

beforeEach(() => {
  ensureMiniDom();
  refreshes = 0;
  picks = [];
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("PanelLauncher catalog feedback", () => {
  test("keeps a refresh action available after a successful empty catalog", async () => {
    await render();
    expect(refreshButton()).toBeDefined();
    expect(refreshButton().getAttribute("disabled")).toBeNull();
    expect(
      nodes(container).some((node) => props(node)["data-panel-launcher-group"] === "panels"),
    ).toBe(false);
    const before = refreshes;
    await act(async () => {
      props(refreshButton()).onClick();
      await flushMicrotasks();
    });
    expect(refreshes).toBe(before + 1);
  });

  test("shows loading and recoverable failures without a false empty state or disabling loaded tools", async () => {
    await render({ loading: true });
    expect(text(container)).toContain("正在加载面板");
    expect(text(container)).not.toContain("暂无可用工具或面板");
    expect(refreshButton().getAttribute("disabled")).not.toBeNull();
    await render({ error: "One project is unavailable", entries: [tool] });
    expect(nodes(container).some((node) => props(node).role === "alert")).toBe(true);
    expect(text(container)).toContain("One project is unavailable");
    expect(text(container)).not.toContain("暂无可用工具或面板");
    const card = nodes(container).find(
      (node) => props(node)["data-panel-launcher-kind"] === tool.key,
    );
    expect(card.getAttribute("disabled")).toBeNull();
    await act(async () => {
      props(card).onClick();
      await flushMicrotasks();
    });
    expect(picks).toEqual([tool.key]);
    const before = refreshes;
    await act(async () => {
      props(refreshButton()).onClick();
      await flushMicrotasks();
    });
    expect(refreshes).toBe(before + 1);
  });

  test("refreshes once on activation or an explicit plus request, not on loading rerenders", async () => {
    await render({ active: false });
    expect(refreshes).toBe(0);
    await render({ active: true });
    expect(refreshes).toBe(1);
    await render({ loading: true });
    await render({ loading: false });
    expect(refreshes).toBe(1);
    await render({ focusRequest: 1 });
    expect(refreshes).toBe(2);
    await render({ focusRequest: 1, error: "temporary" });
    expect(refreshes).toBe(2);
    await render({ active: false, focusRequest: 1 });
    await render({ active: true, focusRequest: 1 });
    expect(refreshes).toBe(3);
  });
});
