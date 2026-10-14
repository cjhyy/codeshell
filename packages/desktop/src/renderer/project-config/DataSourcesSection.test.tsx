import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  EffectiveSourceAccess,
  SourceDefinition,
  SourceResourceMeta,
  WorkspaceSourceBinding,
} from "@cjhyy/code-shell-core";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { DataSourcesSection } from "./DataSourcesSection";
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

function elementsWithAttribute(node: unknown, name: string): any[] {
  return findElements(node, "LI").filter((element) => element.attributes?.has(name));
}

const mcpSource: SourceDefinition = {
  id: "docs-one",
  kind: "mcp-resource",
  label: "Project Docs",
  adapterConfig: { server: "docs" },
  enabled: true,
};

const okAccess: EffectiveSourceAccess = {
  sourceId: "docs-one",
  label: "Project Docs",
  kind: "mcp-resource",
  scopes: ["alpha"],
  readPolicy: "ask",
  status: "ok",
  definition: mcpSource,
};

const danglingAccess: EffectiveSourceAccess = {
  sourceId: "removed-source",
  label: "removed-source",
  kind: "unknown",
  scopes: ["issues"],
  readPolicy: "deny",
  status: "dangling",
};

const uploadedBrief: SourceResourceMeta = {
  id: "brief.md",
  scopeId: "uploads",
  name: "brief.md",
  sizeBytes: 1536,
};

function snapshot(
  access: EffectiveSourceAccess[] = [],
  uploads: SourceResourceMeta[] = [],
  bindings: WorkspaceSourceBinding[] = access
    .filter((item) => item.sourceId !== "project-uploads")
    .map(({ sourceId, scopes, readPolicy }) => ({ sourceId, scopes, readPolicy })),
) {
  return { access, uploads, bindings };
}

let root: Root | null = null;

async function renderSection(
  confirmDeleteUpload?: (upload: SourceResourceMeta) => Promise<boolean>,
): Promise<HTMLElement> {
  const container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <DialogProvider>
        <form>
          <DataSourcesSection projectId="project-1" confirmDeleteUpload={confirmDeleteUpload} />
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

describe("DataSourcesSection", () => {
  test("excludes legacy mock sources and bindings while retaining real and dangling references", async () => {
    ensureMiniDom();
    const boundMock: SourceDefinition = {
      id: "retired-fixture",
      kind: "mock",
      label: "Retired fixture",
      adapterConfig: {},
      enabled: true,
    };
    const unboundMock: SourceDefinition = {
      ...boundMock,
      id: "unbound-fixture",
      label: "Unbound fixture",
    };
    const availableMcp: SourceDefinition = {
      ...mcpSource,
      id: "mock-docs",
      label: "Published docs",
    };
    const unknownReference: EffectiveSourceAccess = {
      ...danglingAccess,
      sourceId: "mock-archive",
      label: "Offline archive",
    };
    const orphanedMock: EffectiveSourceAccess = {
      ...okAccess,
      sourceId: "orphaned-fixture",
      label: "Orphaned fixture",
      kind: "mock",
      definition: undefined,
    };
    const access = [okAccess, danglingAccess, unknownReference, orphanedMock];
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [boundMock, unboundMock, mcpSource, availableMcp],
        projectSourceAccess: async () =>
          snapshot(
            access,
            [],
            [
              ...access.map(({ sourceId, scopes, readPolicy }) => ({
                sourceId,
                scopes,
                readPolicy,
              })),
              { sourceId: boundMock.id, scopes: ["alpha"], readPolicy: "ask" },
            ],
          ),
        listSourceScopes: async () => [],
      },
    });

    const container = await renderSection();

    expect(elementsWithAttribute(container, "data-source-access")).toHaveLength(3);
    expect(textOf(container)).toContain("Project Docs");
    expect(textOf(container)).toContain("removed-source");
    expect(textOf(container)).toContain("Offline archive");
    expect(textOf(container)).not.toContain("Retired fixture");
    expect(textOf(container)).not.toContain("Unbound fixture");
    expect(textOf(container)).not.toContain("Orphaned fixture");
    expect(textOf(container)).not.toContain("演示");
    const picker = findElements(container, "BUTTON").find(
      (button) => reactPropsOf(button)["aria-label"] === "数据源",
    );
    expect(selectPropsOf(picker).options.map((option: any) => option.value)).toEqual([
      availableMcp.id,
    ]);
  });

  test("renders access rows, dangling status, and uploaded files", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [mcpSource],
        projectSourceAccess: async () => snapshot([okAccess, danglingAccess], [uploadedBrief]),
        listSourceScopes: async () => [],
        bindProjectSource: async () => undefined,
        unbindProjectSource: async () => undefined,
        pickAndUploadProjectSources: async () => [],
        deleteProjectUpload: async () => undefined,
      },
    });

    const container = await renderSection();

    expect(elementsWithAttribute(container, "data-source-access")).toHaveLength(2);
    expect(textOf(container)).toContain("Project Docs");
    expect(textOf(container)).toContain("失效引用");
    expect(textOf(container)).toContain("brief.md");
    expect(textOf(container)).toContain("1.5 KB");
  });

  test("unbinds a source and refreshes workspace access", async () => {
    ensureMiniDom();
    const unbound: Array<[string, string]> = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [mcpSource],
        projectSourceAccess: async () => {
          accessCalls += 1;
          return snapshot([okAccess]);
        },
        listSourceScopes: async () => [],
        bindProjectSource: async () => undefined,
        unbindProjectSource: async (projectId: string, sourceId: string) => {
          unbound.push([projectId, sourceId]);
        },
        pickAndUploadProjectSources: async () => [],
        deleteProjectUpload: async () => undefined,
      },
    });
    const container = await renderSection();
    const unbindButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "解绑",
    );

    await act(async () => {
      reactPropsOf(unbindButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(unbound).toEqual([["project-1", "docs-one"]]);
    expect(accessCalls).toBe(2);
  });

  test("deletes an upload and refreshes the upload list", async () => {
    ensureMiniDom();
    const deleted: Array<[string, string]> = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [],
        projectSourceAccess: async () => {
          accessCalls += 1;
          return snapshot([], [uploadedBrief]);
        },
        listSourceScopes: async () => [],
        bindProjectSource: async () => undefined,
        unbindProjectSource: async () => undefined,
        pickAndUploadProjectSources: async () => [],
        deleteProjectUpload: async (projectId: string, name: string) => {
          deleted.push([projectId, name]);
        },
      },
    });
    const container = await renderSection(async () => true);
    const deleteButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "删除",
    );

    await act(async () => {
      reactPropsOf(deleteButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(deleted).toEqual([["project-1", "brief.md"]]);
    expect(accessCalls).toBe(2);
  });

  test("uploads files and refreshes the workspace snapshot", async () => {
    ensureMiniDom();
    const uploads: string[] = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [],
        projectSourceAccess: async () => {
          accessCalls += 1;
          return snapshot();
        },
        listSourceScopes: async () => [],
        bindProjectSource: async () => undefined,
        unbindProjectSource: async () => undefined,
        pickAndUploadProjectSources: async (projectId: string) => {
          uploads.push(projectId);
          return ["brief.md"];
        },
        deleteProjectUpload: async () => undefined,
      },
    });
    const container = await renderSection();
    const uploadButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "上传文件",
    );

    await act(async () => {
      reactPropsOf(uploadButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(uploads).toEqual(["project-1"]);
    expect(accessCalls).toBe(2);
  });

  test("loads explicit scopes and binds the checked scopes with the selected policy", async () => {
    ensureMiniDom();
    const scopeCalls: string[] = [];
    const bindings: Array<[string, WorkspaceSourceBinding]> = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [mcpSource],
        projectSourceAccess: async () => {
          accessCalls += 1;
          return snapshot();
        },
        listSourceScopes: async (sourceId: string) => {
          scopeCalls.push(sourceId);
          return [
            { id: "alpha", label: "Alpha" },
            { id: "beta", label: "Beta" },
          ];
        },
        bindProjectSource: async (projectId: string, binding: WorkspaceSourceBinding) => {
          bindings.push([projectId, binding]);
        },
        unbindProjectSource: async () => undefined,
        pickAndUploadProjectSources: async () => [],
        deleteProjectUpload: async () => undefined,
      },
    });
    const container = await renderSection();
    const selectForLabel = (label: string) => {
      const trigger = findElements(container, "BUTTON").find(
        (button) => reactPropsOf(button)["aria-label"] === label,
      );
      return findElements(trigger.parentNode, "SELECT")[0];
    };
    const sourceSelect = selectForLabel("数据源");
    const policySelect = selectForLabel("读取策略");
    expect(reactPropsOf(selectForLabel("权重")).defaultValue).toBe("normal");

    await act(async () => {
      reactPropsOf(sourceSelect).onChange({ target: { value: "docs-one" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const alpha = findElements(container, "BUTTON").find(
      (button) => button.attributes?.get("data-scope-id") === "alpha",
    );
    await act(async () => {
      reactPropsOf(alpha).onClick({
        isPropagationStopped: () => false,
        stopPropagation: () => undefined,
      });
      reactPropsOf(policySelect).onChange({ target: { value: "deny" } });
      await flushMicrotasks();
    });
    const bindButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "绑定所选范围",
    );
    await act(async () => {
      reactPropsOf(bindButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(scopeCalls).toEqual(["docs-one"]);
    expect(bindings).toEqual([
      [
        "project-1",
        { sourceId: "docs-one", scopes: ["alpha"], readPolicy: "deny", priority: "normal" },
      ],
    ]);
    expect(accessCalls).toBe(2);
  });
});
