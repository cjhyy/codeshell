import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SourceDefinition } from "@cjhyy/code-shell-core";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DataSourceCatalogSection } from "./DataSourceCatalogSection";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function textOf(node: unknown): string {
  const current = node as {
    nodeType?: number;
    data?: string;
    childNodes?: unknown[];
    textContent?: string;
  };
  if (current.nodeType === 3) return current.data ?? current.textContent ?? "";
  const children = Array.from(current.childNodes ?? []);
  if (children.length === 0) return current.textContent ?? "";
  return children.map((child) => textOf(child)).join("");
}

function withDataAttribute(container: HTMLElement, tagName: string, name: string): any[] {
  return findElements(container, tagName).filter(
    (element) => reactPropsOf(element)[name] !== undefined,
  );
}

const mockSource: SourceDefinition = {
  id: "mock-notes",
  kind: "mock",
  label: "Mock Notes",
  adapterConfig: {},
  enabled: true,
};

const mcpSource: SourceDefinition = {
  id: "design-mcp",
  kind: "mcp-resource",
  label: "Design MCP",
  adapterConfig: { server: "figma" },
  enabled: false,
};

let root: Root | null = null;

async function renderSection(): Promise<HTMLElement> {
  const container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <form>
        <DataSourceCatalogSection />
      </form>,
    );
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return container;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("DataSourceCatalogSection", () => {
  test("renders source id, kind, label, and enabled state", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [mockSource, mcpSource],
        saveSourceCatalog: async () => undefined,
        deleteSourceCatalog: async () => undefined,
      },
    });

    const container = await renderSection();

    expect(withDataAttribute(container, "LI", "data-source-definition")).toHaveLength(2);
    expect(textOf(container)).toContain("mock-notes");
    expect(textOf(container)).toContain("mock");
    expect(textOf(container)).toContain("Mock Notes");
    expect(textOf(container)).toContain("已启用");
    expect(textOf(container)).toContain("design-mcp");
    expect(textOf(container)).toContain("MCP 资源");
    expect(textOf(container)).toContain("Design MCP");
    expect(textOf(container)).toContain("已禁用");
  });

  test("creates a complete mcp-resource definition and refreshes", async () => {
    ensureMiniDom();
    const saved: SourceDefinition[] = [];
    let listCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          return [];
        },
        saveSourceCatalog: async (definition: SourceDefinition) => void saved.push(definition),
        deleteSourceCatalog: async () => undefined,
      },
    });
    const container = await renderSection();
    const input = (name: string) =>
      findElements(container, "INPUT").find((element) => reactPropsOf(element).name === name);
    const select = findElements(container, "SELECT")[0];
    const create = withDataAttribute(container, "BUTTON", "data-source-create")[0];

    await act(async () => {
      reactPropsOf(input("source-id")).onChange({ target: { value: "docs-mcp" } });
      reactPropsOf(select).onChange({ target: { value: "mcp-resource" } });
      reactPropsOf(input("source-label")).onChange({ target: { value: "Docs MCP" } });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(create).onClick();
      await flushMicrotasks();
    });
    expect(saved).toEqual([]);
    expect(textOf(container)).toContain("MCP server 为必填项");

    await act(async () => {
      reactPropsOf(input("source-server")).onChange({ target: { value: "docs" } });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(create).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(saved).toEqual([
      {
        id: "docs-mcp",
        kind: "mcp-resource",
        label: "Docs MCP",
        adapterConfig: { server: "docs" },
        enabled: true,
      },
    ]);
    expect(listCalls).toBe(2);
  });

  test("toggles enabled through catalog save and refreshes", async () => {
    ensureMiniDom();
    const saved: SourceDefinition[] = [];
    let listCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          return [mockSource];
        },
        saveSourceCatalog: async (definition: SourceDefinition) => void saved.push(definition),
        deleteSourceCatalog: async () => undefined,
      },
    });
    const container = await renderSection();
    const toggle = withDataAttribute(container, "BUTTON", "data-source-toggle")[0];

    await act(async () => {
      reactPropsOf(toggle).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(saved).toEqual([{ ...mockSource, enabled: false }]);
    expect(listCalls).toBe(2);
  });

  test("deletes only after confirmation and refreshes", async () => {
    ensureMiniDom();
    const deleted: string[] = [];
    const confirmations = [false, true];
    let listCalls = 0;
    Object.assign(window, {
      confirm: () => confirmations.shift() ?? false,
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          return [mockSource];
        },
        saveSourceCatalog: async () => undefined,
        deleteSourceCatalog: async (id: string) => void deleted.push(id),
      },
    });
    const container = await renderSection();
    const remove = withDataAttribute(container, "BUTTON", "data-source-delete")[0];

    await act(async () => {
      reactPropsOf(remove).onClick();
      await flushMicrotasks();
    });
    expect(deleted).toEqual([]);
    expect(listCalls).toBe(1);

    await act(async () => {
      reactPropsOf(remove).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(deleted).toEqual(["mock-notes"]);
    expect(listCalls).toBe(2);
  });

  test("shows catalog operation errors inline", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => {
          throw new Error("catalog offline");
        },
        saveSourceCatalog: async () => undefined,
        deleteSourceCatalog: async () => undefined,
      },
    });

    const container = await renderSection();

    expect(textOf(container)).toContain("catalog offline");
  });
});
