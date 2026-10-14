import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SourceDefinition } from "@cjhyy/code-shell-core";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DataSourceCatalogSection } from "./DataSourceCatalogSection";
import { DialogProvider } from "../ui/DialogProvider";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

/** Closed Radix menus live outside the mini-DOM; inspect their owning selector contract. */
function selectPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? current[key] : undefined;
  while (fiber) {
    if (fiber.type?.name === "SimpleSelect") return fiber.memoizedProps;
    fiber = fiber.return;
  }
  throw new Error("Expected a rendered SimpleSelect");
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const collectionSource: SourceDefinition = {
  id: "collection-notes",
  kind: "collection",
  label: "Shared Notes",
  adapterConfig: { version: 1, revision: "fixture-revision", entries: [] },
  enabled: true,
};

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

const linkedFileSource: SourceDefinition = {
  id: "linked-readme",
  kind: "link",
  label: "acme/docs/README.md",
  adapterConfig: {
    providerId: "github",
    action: "get_file",
    params: { owner: "acme", repo: "docs", path: "README.md" },
  },
  credentialRef: "link-alice",
  enabled: true,
};

const linkedQuerySource: SourceDefinition = {
  ...linkedFileSource,
  id: "team-issues",
  label: "Team issues",
  adapterConfig: {
    providerId: "github",
    action: "list_issues",
    params: { owner: "acme", repo: "docs" },
  },
};

const savedLinkConnection = {
  id: "link-alice",
  label: "Alice GitHub",
  type: "oauth",
  hasSecret: true,
  meta: {
    linkProvider: "github",
    linkExecutionRuntime: "server",
    linkCapabilityIds: ["github.list_issues", "github.create_issue"],
  },
};

const linkProvider = {
  id: "github",
  actions: [
    {
      id: "list_issues",
      title: "Issues",
      description: "Read selected issues",
      risk: "read",
    },
    { id: "create_issue", title: "Write issue", risk: "write" },
  ],
};

function buttonWithText(container: HTMLElement, text: string): any {
  const button = findElements(container, "BUTTON").find((node) => textOf(node) === text);
  expect(button).toBeDefined();
  return button;
}

async function click(button: any): Promise<void> {
  await act(async () => {
    reactPropsOf(button).onClick();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function openCreate(container: HTMLElement): Promise<void> {
  await click(buttonWithText(container, "添加资源视图"));
}

let root: Root | null = null;

async function renderSection(
  confirmDelete?: (source: SourceDefinition) => Promise<boolean>,
  onManageConnections?: () => void,
): Promise<HTMLElement> {
  const container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <DialogProvider>
        <form>
          <DataSourceCatalogSection
            confirmDelete={confirmDelete}
            onManageConnections={onManageConnections}
          />
        </form>
      </DialogProvider>,
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
  test("shows initial catalog loading and failure outside advanced sources, then retries", async () => {
    ensureMiniDom();
    const initial = deferred<SourceDefinition[]>();
    const retried = deferred<SourceDefinition[]>();
    let listCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: () => {
          listCalls += 1;
          return listCalls === 1 ? initial.promise : retried.promise;
        },
      },
    });
    const container = await renderSection();
    const advanced = findElements(container, "DETAILS")[0];
    expect(reactPropsOf(advanced).open).not.toBe(true);
    expect(
      findElements(container, "P").filter((node) => reactPropsOf(node).role === "status"),
    ).toHaveLength(1);
    expect(
      findElements(advanced, "P").filter((node) => reactPropsOf(node).role === "status"),
    ).toHaveLength(0);
    expect(textOf(container)).not.toContain("还没有资料集");

    await act(async () => {
      initial.reject(new Error("catalog offline"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("catalog offline");
    expect(textOf(advanced)).not.toContain("catalog offline");
    expect(textOf(container)).not.toContain("还没有资料集");
    const retry = findElements(container, "BUTTON").find((node) => textOf(node) === "重新加载");
    expect(retry).toBeDefined();
    expect(reactPropsOf(retry).disabled).toBe(false);

    await act(async () => {
      reactPropsOf(retry).onClick();
      await flushMicrotasks();
    });
    expect(listCalls).toBe(2);
    expect(textOf(container)).not.toContain("catalog offline");
    expect(textOf(container)).not.toContain("还没有资料集");
    await act(async () => {
      retried.resolve([collectionSource]);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("Shared Notes");
    expect(withDataAttribute(container, "LI", "data-collection-id")).toHaveLength(1);
    expect(
      findElements(container, "P").filter((node) => reactPropsOf(node).role === "status"),
    ).toHaveLength(0);
    expect(textOf(container)).not.toContain("catalog offline");
  });

  test("retains the loaded collection and source lists when a later refresh fails", async () => {
    ensureMiniDom();
    let listCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          if (listCalls === 2) throw new Error("refresh unavailable");
          return [collectionSource, mockSource];
        },
        saveSourceCatalog: async () => undefined,
      },
    });
    const container = await renderSection();
    const toggle = withDataAttribute(container, "BUTTON", "data-source-toggle")[0];
    await act(async () => {
      reactPropsOf(toggle).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(listCalls).toBe(2);
    expect(textOf(container)).toContain("refresh unavailable");
    expect(textOf(findElements(container, "DETAILS")[0])).not.toContain("refresh unavailable");
    expect(textOf(container)).toContain("Shared Notes");
    expect(withDataAttribute(container, "LI", "data-collection-id")).toHaveLength(1);
    expect(withDataAttribute(container, "LI", "data-source-definition")).toHaveLength(1);
    expect(textOf(container)).not.toContain("还没有资料集");
  });

  test("shows selected online files and saved queries outside advanced configuration", async () => {
    ensureMiniDom();
    let managedConnections = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [linkedFileSource, linkedQuerySource, mockSource, mcpSource],
      },
    });
    const container = await renderSection(undefined, () => {
      managedConnections += 1;
    });
    const advanced = findElements(container, "DETAILS")[0];
    const online = withDataAttribute(container, "SECTION", "data-connected-materials")[0];

    expect(withDataAttribute(online, "LI", "data-source-definition")).toHaveLength(2);
    expect(textOf(online)).toContain("acme/docs/README.md");
    expect(textOf(online)).toContain("在线文件");
    expect(textOf(online)).toContain("Team issues");
    expect(textOf(online)).toContain("保存的查询");
    expect(textOf(advanced)).not.toContain("acme/docs/README.md");
    expect(textOf(advanced)).not.toContain("Team issues");
    expect(textOf(advanced)).toContain("Mock Notes");
    expect(textOf(advanced)).toContain("Design MCP");
    expect(textOf(advanced)).not.toContain("管理 Link 连接");
    await click(buttonWithText(container, "管理 Link 连接"));
    expect(managedConnections).toBe(1);
  });

  test("opens an optional resource form with generated ids and no demo creation option", async () => {
    ensureMiniDom();
    let connectionCalls = 0;
    let providerCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [],
        credentials: {
          list: async () => {
            connectionCalls += 1;
            return [];
          },
        },
        links: {
          listLocalProviders: async () => {
            providerCalls += 1;
            return [];
          },
        },
      },
    });
    const container = await renderSection();
    expect(findElements(container, "INPUT")).toHaveLength(0);
    expect(findElements(container, "TEXTAREA")).toHaveLength(0);
    expect(findElements(container, "SELECT")).toHaveLength(0);
    expect(connectionCalls).toBe(0);
    expect(providerCalls).toBe(0);

    await openCreate(container);
    expect(connectionCalls).toBe(1);
    expect(providerCalls).toBe(1);
    expect(
      findElements(container, "INPUT").some((node) => reactPropsOf(node).name === "source-id"),
    ).toBe(false);
    const kindSelect = findElements(container, "SELECT")[0];
    expect(selectPropsOf(kindSelect).value).toBe("link");
    expect(selectPropsOf(kindSelect).options.map((option: any) => option.value)).toEqual([
      "link",
      "mcp-resource",
    ]);
    expect(textOf(container)).toContain("还没有可用的 Link 连接");
  });

  test("shows connection loading and request failure, then reloads connections", async () => {
    ensureMiniDom();
    const connections = deferred<(typeof savedLinkConnection)[]>();
    let connectionCalls = 0;
    let providerCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [linkedFileSource],
        credentials: {
          list: () => {
            connectionCalls += 1;
            return connectionCalls === 1
              ? connections.promise
              : Promise.resolve([savedLinkConnection]);
          },
        },
        links: {
          listLocalProviders: async () => {
            providerCalls += 1;
            return [linkProvider];
          },
        },
      },
    });
    const container = await renderSection();
    await openCreate(container);
    const advanced = findElements(container, "DETAILS")[0];
    expect(textOf(advanced)).toContain("正在读取可用连接");
    expect(
      reactPropsOf(withDataAttribute(container, "BUTTON", "data-source-create")[0]).disabled,
    ).toBe(true);

    await act(async () => {
      connections.reject(new Error("connections offline"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(textOf(advanced)).toContain("connections offline");
    expect(textOf(advanced)).not.toContain("正在读取可用连接");
    expect(textOf(container)).toContain("acme/docs/README.md");
    await click(buttonWithText(container, "重新加载连接"));
    expect(connectionCalls).toBe(2);
    expect(providerCalls).toBe(2);
    expect(textOf(advanced)).not.toContain("connections offline");
    expect(selectPropsOf(findElements(container, "SELECT")[1]).options).toEqual([
      { value: "link-alice", label: "Alice GitHub (github)" },
    ]);
    expect(
      reactPropsOf(withDataAttribute(container, "BUTTON", "data-source-create")[0]).disabled,
    ).toBe(false);
  });

  test("creates a fixed Link read view from masked saved connections and excludes writes", async () => {
    ensureMiniDom();
    const saved: SourceDefinition[] = [];
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [],
        saveSourceCatalog: async (definition: SourceDefinition) => void saved.push(definition),
        deleteSourceCatalog: async () => undefined,
        credentials: {
          list: async () => [savedLinkConnection],
        },
        links: {
          listLocalProviders: async () => [linkProvider],
        },
      },
    });
    const container = await renderSection();
    await openCreate(container);
    const input = (name: string) =>
      findElements(container, "INPUT").find((element) => reactPropsOf(element).name === name);
    await act(async () => {
      reactPropsOf(input("source-label")).onChange({ target: { value: "Team issues" } });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(findElements(container, "SELECT")[1]).onChange({
        target: { value: "link-alice" },
      });
      await flushMicrotasks();
    });
    const actionSelect = findElements(container, "SELECT")[2];
    expect(selectPropsOf(actionSelect).options.map((option: any) => option.value)).toEqual([
      "list_issues",
    ]);
    await act(async () => {
      reactPropsOf(actionSelect).onChange({ target: { value: "create_issue" } });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(withDataAttribute(container, "BUTTON", "data-source-create")[0]).onClick();
      await flushMicrotasks();
    });
    expect(saved).toEqual([]);
    await act(async () => {
      reactPropsOf(actionSelect).onChange({ target: { value: "list_issues" } });
      reactPropsOf(findElements(container, "TEXTAREA")[0]).onChange({
        target: { value: '{"owner":"acme","repo":"docs","limit":10}' },
      });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(withDataAttribute(container, "BUTTON", "data-source-create")[0]).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(saved).toEqual([
      {
        id: expect.stringMatching(/^source_[a-f0-9]{32}$/),
        kind: "link",
        label: "Team issues",
        credentialRef: "link-alice",
        enabled: true,
        adapterConfig: {
          providerId: "github",
          action: "list_issues",
          params: { owner: "acme", repo: "docs", limit: 10 },
        },
      },
    ]);
    expect(input("source-label")).toBeUndefined();
    expect(withDataAttribute(container, "BUTTON", "data-source-create")).toHaveLength(0);
  });
  test("keeps legacy demo and MCP resources manageable inside advanced configuration", async () => {
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
    expect(textOf(container)).toContain("figma");
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
        credentials: { list: async () => [] },
        links: { listLocalProviders: async () => [] },
      },
    });
    const container = await renderSection();
    await openCreate(container);
    const input = (name: string) =>
      findElements(container, "INPUT").find((element) => reactPropsOf(element).name === name);
    const select = findElements(container, "SELECT")[0];
    const create = withDataAttribute(container, "BUTTON", "data-source-create")[0];

    await act(async () => {
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
        id: expect.stringMatching(/^source_[a-f0-9]{32}$/),
        kind: "mcp-resource",
        label: "Docs MCP",
        adapterConfig: { server: "docs" },
        enabled: true,
      },
    ]);
    expect(listCalls).toBe(2);
    expect(input("source-label")).toBeUndefined();
  });

  test("saves a resource view once when the create handler is invoked twice", async () => {
    ensureMiniDom();
    const completion = deferred<void>();
    const saved: SourceDefinition[] = [];
    let listCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          return [];
        },
        saveSourceCatalog: (definition: SourceDefinition) => {
          saved.push(definition);
          return completion.promise;
        },
        credentials: { list: async () => [] },
        links: { listLocalProviders: async () => [] },
      },
    });
    const container = await renderSection();
    await openCreate(container);
    const input = (name: string) =>
      findElements(container, "INPUT").find((element) => reactPropsOf(element).name === name);
    await act(async () => {
      reactPropsOf(findElements(container, "SELECT")[0]).onChange({
        target: { value: "mcp-resource" },
      });
      reactPropsOf(input("source-label")).onChange({ target: { value: "Docs" } });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(input("source-server")).onChange({ target: { value: "docs" } });
      await flushMicrotasks();
    });
    const create = withDataAttribute(container, "BUTTON", "data-source-create")[0];
    await act(async () => {
      const handler = reactPropsOf(create).onClick;
      handler();
      handler();
      await flushMicrotasks();
    });
    expect(saved).toHaveLength(1);
    expect(reactPropsOf(create).disabled).toBe(true);
    expect(listCalls).toBe(1);

    await act(async () => {
      completion.resolve();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(listCalls).toBe(2);
    expect(withDataAttribute(container, "BUTTON", "data-source-create")).toHaveLength(0);
  });

  test("keeps a committed view complete when its catalog refresh fails, then retries only the list", async () => {
    ensureMiniDom();
    const saved: SourceDefinition[] = [];
    let listCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          if (listCalls === 2) throw new Error("saved catalog refresh failed");
          return [...saved];
        },
        saveSourceCatalog: async (definition: SourceDefinition) => void saved.push(definition),
        credentials: { list: async () => [] },
        links: { listLocalProviders: async () => [] },
      },
    });
    const container = await renderSection();
    await openCreate(container);
    const input = (name: string) =>
      findElements(container, "INPUT").find((element) => reactPropsOf(element).name === name);
    await act(async () => {
      reactPropsOf(findElements(container, "SELECT")[0]).onChange({
        target: { value: "mcp-resource" },
      });
      reactPropsOf(input("source-label")).onChange({ target: { value: "Committed docs" } });
      await flushMicrotasks();
    });
    await act(async () => {
      reactPropsOf(input("source-server")).onChange({ target: { value: "docs" } });
      await flushMicrotasks();
    });
    await click(withDataAttribute(container, "BUTTON", "data-source-create")[0]);

    expect(saved).toHaveLength(1);
    expect(listCalls).toBe(2);
    expect(input("source-label")).toBeUndefined();
    expect(withDataAttribute(container, "BUTTON", "data-source-create")).toHaveLength(0);
    expect(textOf(container)).toContain("saved catalog refresh failed");
    expect(textOf(findElements(container, "DETAILS")[0])).not.toContain(
      "saved catalog refresh failed",
    );

    await click(buttonWithText(container, "重新加载"));
    expect(listCalls).toBe(3);
    expect(saved).toHaveLength(1);
    expect(textOf(container)).not.toContain("saved catalog refresh failed");
    const sourceRows = withDataAttribute(container, "LI", "data-source-definition");
    expect(sourceRows).toHaveLength(1);
    expect(textOf(sourceRows[0])).toContain("Committed docs");
    expect(
      reactPropsOf(withDataAttribute(container, "BUTTON", "data-source-toggle")[0])[
        "data-source-toggle"
      ],
    ).toBe(saved[0].id);
    expect(withDataAttribute(container, "BUTTON", "data-source-create")).toHaveLength(0);
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
      codeshell: {
        listSourceCatalog: async () => {
          listCalls += 1;
          return [mockSource];
        },
        saveSourceCatalog: async () => undefined,
        deleteSourceCatalog: async (id: string) => void deleted.push(id),
      },
    });
    const container = await renderSection(async () => confirmations.shift() ?? false);
    const remove = withDataAttribute(container, "BUTTON", "data-source-delete")[0];

    await act(async () => {
      reactPropsOf(remove).onClick();
      await flushMicrotasks();
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
