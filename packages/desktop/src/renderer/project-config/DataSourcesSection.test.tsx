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

function elementsWithAttribute(node: unknown, name: string): any[] {
  return findElements(node, "LI").filter((element) => element.attributes?.has(name));
}

const mockSource: SourceDefinition = {
  id: "mock-one",
  kind: "mock",
  label: "Mock One",
  adapterConfig: {},
  enabled: true,
};

const okAccess: EffectiveSourceAccess = {
  sourceId: "mock-one",
  label: "Mock One",
  kind: "mock",
  scopes: ["alpha"],
  readPolicy: "ask",
  status: "ok",
  definition: mockSource,
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
  bindings: WorkspaceSourceBinding[] = [],
) {
  return { access, uploads, bindings };
}

let root: Root | null = null;

async function renderSection(): Promise<HTMLElement> {
  const container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root?.render(<DataSourcesSection cwd="/repo" />);
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
  test("renders access rows, dangling status, and uploaded files", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [mockSource],
        workspaceSourceAccess: async () => snapshot([okAccess, danglingAccess], [uploadedBrief]),
        listSourceScopes: async () => [],
        bindSource: async () => undefined,
        unbindSource: async () => undefined,
        pickAndUploadSources: async () => [],
        deleteUpload: async () => undefined,
      },
    });

    const container = await renderSection();

    expect(elementsWithAttribute(container, "data-source-access")).toHaveLength(2);
    expect(textOf(container)).toContain("Mock One");
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
        listSourceCatalog: async () => [mockSource],
        workspaceSourceAccess: async () => {
          accessCalls += 1;
          return snapshot([okAccess]);
        },
        listSourceScopes: async () => [],
        bindSource: async () => undefined,
        unbindSource: async (cwd: string, sourceId: string) => {
          unbound.push([cwd, sourceId]);
        },
        pickAndUploadSources: async () => [],
        deleteUpload: async () => undefined,
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

    expect(unbound).toEqual([["/repo", "mock-one"]]);
    expect(accessCalls).toBe(2);
  });

  test("deletes an upload and refreshes the upload list", async () => {
    ensureMiniDom();
    const deleted: Array<[string, string]> = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [],
        workspaceSourceAccess: async () => {
          accessCalls += 1;
          return snapshot([], [uploadedBrief]);
        },
        listSourceScopes: async () => [],
        bindSource: async () => undefined,
        unbindSource: async () => undefined,
        pickAndUploadSources: async () => [],
        deleteUpload: async (cwd: string, name: string) => {
          deleted.push([cwd, name]);
        },
      },
    });
    const container = await renderSection();
    const deleteButton = findElements(container, "BUTTON").find(
      (button) => textOf(button) === "删除",
    );

    await act(async () => {
      reactPropsOf(deleteButton).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(deleted).toEqual([["/repo", "brief.md"]]);
    expect(accessCalls).toBe(2);
  });

  test("uploads files and refreshes the workspace snapshot", async () => {
    ensureMiniDom();
    const uploads: string[] = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [],
        workspaceSourceAccess: async () => {
          accessCalls += 1;
          return snapshot();
        },
        listSourceScopes: async () => [],
        bindSource: async () => undefined,
        unbindSource: async () => undefined,
        pickAndUploadSources: async (cwd: string) => {
          uploads.push(cwd);
          return ["brief.md"];
        },
        deleteUpload: async () => undefined,
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

    expect(uploads).toEqual(["/repo"]);
    expect(accessCalls).toBe(2);
  });

  test("loads explicit scopes and binds the checked scopes with ask policy", async () => {
    ensureMiniDom();
    const scopeCalls: string[] = [];
    const bindings: Array<[string, WorkspaceSourceBinding]> = [];
    let accessCalls = 0;
    Object.assign(window, {
      codeshell: {
        listSourceCatalog: async () => [mockSource],
        workspaceSourceAccess: async () => {
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
        bindSource: async (cwd: string, binding: WorkspaceSourceBinding) => {
          bindings.push([cwd, binding]);
        },
        unbindSource: async () => undefined,
        pickAndUploadSources: async () => [],
        deleteUpload: async () => undefined,
      },
    });
    const container = await renderSection();
    const select = findElements(container, "SELECT")[0];

    await act(async () => {
      reactPropsOf(select).onChange({ target: { value: "mock-one" } });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const alpha = findElements(container, "INPUT").find(
      (input) => reactPropsOf(input).value === "alpha",
    );
    await act(async () => {
      reactPropsOf(alpha).onChange({ target: { checked: true } });
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

    expect(scopeCalls).toEqual(["mock-one"]);
    expect(bindings).toEqual([
      ["/repo", { sourceId: "mock-one", scopes: ["alpha"], readPolicy: "ask" }],
    ]);
    expect(accessCalls).toBe(2);
  });
});
