// An isolated process exercises the actual pages while replacing native controls and Host I/O.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type {
  SourceDefinition,
  WorkspaceSourceBinding,
  CollectionEntry,
} from "@cjhyy/code-shell-core";
import type { SourceCollectionView, SourceCollectionChange } from "../../shared/source-collections";

let unexpectedRequests = 0;
const denyRequest = () => {
  unexpectedRequests++;
  throw new Error("fixture denies network requests");
};
globalThis.fetch = denyRequest as unknown as typeof fetch;
http.request = denyRequest as typeof http.request;
http.get = denyRequest as typeof http.get;
https.request = denyRequest as typeof https.request;
https.get = denyRequest as typeof https.get;
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://fixture.invalid"),
  () => http.get("http://fixture.invalid"),
  () => http.request("http://fixture.invalid"),
  () => https.get("https://fixture.invalid"),
  () => https.request("https://fixture.invalid"),
])
  assert.throws(probe);
assert.equal(unexpectedRequests, 5);
unexpectedRequests = 0;
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));
ensureMiniDom();
const scenario = process.argv[2];
const unhandled: string[] = [];
process.on("unhandledRejection", (cause) => unhandled.push(String(cause)));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pendingView = deferred<SourceCollectionView>();
const pendingCreate = deferred<SourceCollectionView>();
const pendingPick = deferred<SourceCollectionView | null>();
const pendingConfirm = deferred<boolean>();
const pendingSnapshot = deferred<any>();
const pendingScopes = deferred<Array<{ id: string; label: string }>>();
const pendingBind = deferred<void>();
const confirmations: any[] = [];
let confirmResult = true;
const toasts: any[] = [];
const { translate } = await import("../i18n/translate");
const t = (key: any, params?: any) => translate("zh", key, params);
mock.module("../i18n/I18nProvider", () => ({
  useT: () => ({ t }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("../ui/DialogProvider", () => ({
  useConfirm: () => (input: any) => {
    confirmations.push(input);
    return scenario === "cancel-confirmation"
      ? pendingConfirm.promise
      : Promise.resolve(confirmResult);
  },
}));
mock.module("../ui/ToastProvider", () => ({ useToast: () => (input: any) => toasts.push(input) }));
mock.module("@/components/ui/simple-select", () => ({
  SimpleSelect: ({ value, options, onChange, ariaLabel, disabled }: any) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" />
      {options.map((item: any) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));
mock.module("@/components/ui/checkbox", () => ({
  Checkbox: ({ onCheckedChange, ...props }: any) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
}));

const entry = (id: string, kind: "local" | "url" = "local"): CollectionEntry =>
  ({
    id,
    name: `${id}.txt`,
    kind,
    sizeBytes: 12,
    checkedAt: "2026-10-10T00:00:00.000Z",
    sha256: "a".repeat(64),
    ...(kind === "local"
      ? { path: `/fixture/docs/${id}.txt`, dev: "1", ino: "2", mtimeMs: 1 }
      : { url: `https://fixture.invalid/${id}.txt` }),
  }) as CollectionEntry;
const definition = (id = "collection_a"): SourceDefinition => ({
  id,
  kind: "collection",
  label: id === "collection_a" ? "Product docs" : "Second docs",
  description: "Shared reference",
  enabled: true,
  adapterConfig: {},
});
let current: SourceCollectionView = {
  definition: definition(),
  revision: "revision-1",
  entries: [
    { entry: entry("file_a"), status: "ready" },
    { entry: entry("file_b", "url"), status: "unchecked" },
  ],
  references: [{ projectId: "project-a", name: "Website" }],
};
const second: SourceCollectionView = {
  ...current,
  definition: definition("collection_b"),
  revision: "second-1",
  entries: [{ entry: entry("file_c"), status: "missing" }],
};
let catalog =
  scenario === "cancel-create" || scenario === "create-and-edit"
    ? []
    : [current.definition, second.definition];
const quickAdd = scenario.startsWith("quick-add-");
const pendingCreateScenario = quickAdd && /-(unmount|navigation)$/.test(scenario);
if (quickAdd) {
  catalog.push(
    ...Array.from({ length: 30 }, (_, index) => ({
      ...definition(`collection_long_${index}`),
      label: `Long collection ${index + 1}`,
    })),
  );
}
const createCalls: any[] = [];
const updateCalls: Array<[string, string, SourceCollectionChange]> = [];
const pickCalls: any[] = [];
const deleteCalls: any[] = [];
const bindCalls: Array<[string, WorkspaceSourceBinding]> = [];
const unbindCalls: any[] = [];
const forbiddenCalls: any[] = [];
let getCount = 0;
const scopeList = [
  { id: "file_a", label: "file_a.txt" },
  { id: "file_b", label: "file_b.txt" },
];
const originalBinding: WorkspaceSourceBinding = {
  sourceId: "collection_a",
  scopes: ["file_a"],
  readPolicy: "ask",
  ...(scenario.startsWith("project-priority-edit-") ? { priority: "high" as const } : {}),
};
const access = {
  ...originalBinding,
  kind: "collection",
  label: "Product docs",
  status: "ok",
  definition: current.definition,
};
const snapshot = () =>
  scenario === "project-priority-order"
    ? {
        bindings: [
          { ...originalBinding, priority: "normal" },
          { sourceId: "collection_b", scopes: ["file_c"], readPolicy: "ask", priority: "high" },
        ],
        access: [
          access,
          {
            ...access,
            sourceId: "collection_b",
            label: "Second docs",
            definition: second.definition,
          },
        ],
        uploads: [],
      }
    : {
        bindings:
          scenario === "profile-excluded-binding" || scenario.startsWith("project-priority-edit-")
            ? [originalBinding]
            : [],
        access: scenario.startsWith("project-priority-edit-") ? [access] : [],
        uploads: [],
      };
const legacy = {
  id: "legacy_mcp",
  kind: "mcp-resource",
  label: "Legacy MCP",
  enabled: true,
  adapterConfig: {},
};
if (scenario === "project-compatibility") catalog.push(legacy as SourceDefinition);
Object.assign(window, {
  codeshell: {
    listSourceCatalog: async () => structuredClone(catalog),
    saveSourceCatalog: async (...args: any[]) => {
      forbiddenCalls.push(args);
    },
    deleteSourceCatalog: async (...args: any[]) => {
      forbiddenCalls.push(args);
    },
    sourceCollections: {
      create: async (input: any) => {
        createCalls.push(input);
        current = {
          ...current,
          definition: {
            ...current.definition,
            ...(quickAdd ? { id: "collection_new" } : {}),
            ...input,
          },
          ...(quickAdd ? { revision: "created-revision", references: [] } : {}),
          entries: [],
        };
        catalog = quickAdd ? [...catalog, current.definition] : [current.definition];
        if (pendingCreateScenario) return pendingCreate.promise;
        return structuredClone(current);
      },
      get: async (id: string) => {
        getCount++;
        if (scenario === "collection-load-failure" && id === "collection_b")
          throw new Error("collection lookup failed");
        if (scenario === "stale-collection-load" && id === "collection_a")
          return pendingView.promise;
        if (scenario === "delete-inspection-failure" && getCount === 2)
          throw new Error("impact inspection failed");
        if (scenario === "delete-impact" && getCount === 2)
          return {
            ...current,
            revision: "revision-latest",
            references: [...current.references, { projectId: "project-b", name: "Support" }],
          };
        return structuredClone(id === "collection_b" ? second : current);
      },
      pick: async (...args: any[]) => {
        pickCalls.push(args);
        if (scenario === "quick-add-picker-failure" && pickCalls.length === 1)
          throw new Error("native picker failed");
        if (scenario === "quick-add-picker-cancel" && pickCalls.length === 1) return null;
        if (quickAdd) {
          current = {
            ...current,
            revision: `picked-revision-${pickCalls.length}`,
            entries: [
              ...current.entries,
              {
                entry:
                  args[2] === "folder"
                    ? { ...entry("folder_file"), relativePath: "guides/folder_file.txt" }
                    : entry("added_file"),
                status: "ready",
              },
            ],
          };
          return structuredClone(current);
        }
        if (scenario === "folder-current-list")
          return (current = {
            ...current,
            revision: "revision-folder",
            entries: [
              ...current.entries,
              {
                entry: { ...entry("folder_file"), relativePath: "guides/folder_file.txt" },
                status: "ready",
              },
            ],
          });
        return scenario === "picker-cancel-lock" ? pendingPick.promise : null;
      },
      update: async (id: string, revision: string, change: SourceCollectionChange) => {
        updateCalls.push([id, revision, structuredClone(change)]);
        if (scenario === "quick-add-url-failure" && updateCalls.length === 1)
          throw new Error("URL check failed");
        if (scenario === "url-refresh-failure" && change.kind === "refresh")
          throw new Error("refresh rejected; old manifest retained");
        const next = structuredClone(current);
        next.revision = `revision-${updateCalls.length + 1}`;
        if (change.kind === "metadata")
          next.definition = {
            ...next.definition,
            label: change.label,
            description: change.description,
            enabled: change.enabled,
          };
        if (change.kind === "remove")
          next.entries = next.entries.filter((item) => item.entry.id !== change.entryId);
        if (change.kind === "url")
          next.entries.push({ entry: entry("file_url", "url"), status: "unchecked" });
        current = next;
        catalog = catalog.map((item) => (item.id === id ? next.definition : item));
        return structuredClone(next);
      },
      delete: async (...args: any[]) => {
        deleteCalls.push(args);
        catalog = catalog.filter((item) => item.id !== args[0]);
      },
    },
    projectSourceAccess: async (projectId: string) => {
      if (scenario === "stale-project-load" && projectId === "project-a")
        return pendingSnapshot.promise;
      if (scenario === "project-compatibility")
        return {
          bindings: [{ sourceId: "legacy_mcp", scopes: ["resources"], readPolicy: "deny" }],
          access: [
            {
              sourceId: "project-uploads",
              label: "Duplicated uploads source",
              kind: "local-files",
              scopes: ["uploads"],
              readPolicy: "ask",
              status: "ok",
            },
            {
              sourceId: "legacy_mcp",
              label: "Legacy MCP",
              kind: "mcp-resource",
              scopes: ["resources"],
              readPolicy: "deny",
              status: "ok",
            },
          ],
          uploads: [{ id: "old.md", name: "old.md", scopeId: "uploads", sizeBytes: 12 }],
        };
      return snapshot();
    },
    listSourceScopes: async (id: string) => {
      if (scenario === "stale-scope-load" && id === "collection_a") return pendingScopes.promise;
      return id === "collection_b"
        ? [{ id: "file_c", label: "file_c.txt" }]
        : structuredClone(scopeList);
    },
    bindProjectSource: async (projectId: string, binding: WorkspaceSourceBinding) => {
      bindCalls.push([projectId, structuredClone(binding)]);
      if (scenario === "project-save-lock") await pendingBind.promise;
    },
    unbindProjectSource: async (...args: any[]) => {
      unbindCalls.push(args);
    },
    pickAndUploadProjectSources: async () => [],
    deleteProjectUpload: async (...args: any[]) => {
      forbiddenCalls.push(args);
    },
  },
});
const { DataSourceCatalogSection } = await import("./DataSourceCatalogSection");
const { DataSourcesSection } = await import("../project-config/DataSourcesSection");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let rootMounted = true;
const nodes = (node: any = container): any[] => [
  node,
  ...(node.childNodes ?? []).flatMap((child: any) => nodes(child)),
];
const props = (node: any): any =>
  node?.[Object.keys(node ?? {}).find((key) => key.startsWith("__reactProps$")) ?? ""] ?? {};
const text = (node: any): string =>
  node?.nodeType === 3
    ? (node.data ?? node.textContent ?? "")
    : node?.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node?.textContent ?? "");
const find = (predicate: (node: any) => boolean) => {
  const node = nodes().find(predicate);
  assert.ok(node, text(container));
  return node;
};
const button = (label: string) => find((node) => node.tagName === "BUTTON" && text(node) === label);
async function update(operation: () => unknown) {
  await act(async () => {
    operation();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function click(node: any) {
  assert.equal(Boolean(props(node).disabled), false);
  await update(() => props(node).onClick());
}
async function change(name: string, value: string) {
  await update(() =>
    props(find((node) => props(node).name === name)).onChange({ target: { value } }),
  );
}
async function select(label: string, value: string) {
  await update(() =>
    props(
      find((node) => node.tagName === "SELECT" && props(node)["aria-label"] === label),
    ).onChange({ target: { value } }),
  );
}
async function render(projectId = "project-a") {
  await update(() =>
    root.render(
      scenario.startsWith("project-") ||
        scenario.includes("project-load") ||
        scenario === "profile-excluded-binding" ||
        scenario === "stale-scope-load" ? (
        <DataSourcesSection projectId={projectId} />
      ) : (
        <DataSourceCatalogSection />
      ),
    ),
  );
}
const collectionButton = (id: string) =>
  nodes(find((node) => props(node)["data-collection-id"] === id)).find(
    (node) => node.tagName === "BUTTON",
  );
const entryButton = (id: string, label: string) =>
  nodes(find((node) => props(node)["data-collection-entry"] === id)).find(
    (node) => node.tagName === "BUTTON" && text(node) === label,
  );
try {
  await render();
  if (quickAdd) {
    const kind = scenario.includes("url")
      ? "url"
      : scenario.includes("folder")
        ? "folder"
        : "files";
    const addLabel = {
      files: "添加本地文件",
      folder: "添加文件夹当前清单",
      url: "添加并检查链接",
    }[kind];
    const createLabel = {
      files: "创建并选择文件",
      folder: "创建并选择文件夹",
      url: "创建并添加链接",
    }[kind];
    const collections = find((node) => props(node)["data-source-collections"]);
    const listRows = nodes(collections).filter((node) => props(node)["data-collection-id"]);
    assert.equal(listRows.length, 32);
    const addActions = find((node) => props(node)["aria-label"] === "添加资料");
    for (const label of ["添加本地文件", "添加文件夹当前清单", "添加并检查链接"])
      assert.ok(nodes(addActions).includes(button(label)));
    assert.ok(nodes(collections).indexOf(addActions) < nodes(collections).indexOf(listRows[0]));

    await click(button(addLabel));
    const editor = find(
      (node) => node.tagName === "SECTION" && props(node)["aria-label"] === "管理资料集",
    );
    const listing = listRows[0].parentNode;
    assert.equal(editor.parentNode, collections);
    assert.equal(listing.parentNode, collections);
    assert.ok(collections.childNodes.indexOf(editor) < collections.childNodes.indexOf(listing));
    const nameInput = find((node) => props(node).name === "collection-label");
    assert.equal(document.activeElement, nameInput);
    assert.equal(props(button(createLabel)).disabled, true);
    assert.deepEqual(createCalls, []);
    assert.deepEqual(pickCalls, []);
    assert.deepEqual(updateCalls, []);

    await change("collection-label", "  Added docs  ");
    await change("collection-description", "  Reusable references  ");
    if (kind === "url") {
      assert.equal(props(button(createLabel)).disabled, true);
      await change("collection-url", "  https://fixture.invalid/manual.txt  ");
    }
    const submit = button(createLabel);
    assert.equal(props(submit).disabled, false);
    await update(() => {
      props(submit).onClick();
      props(submit).onClick();
    });
    assert.deepEqual(createCalls, [{ label: "Added docs", description: "Reusable references" }]);

    if (pendingCreateScenario) {
      assert.deepEqual(pickCalls, []);
      assert.deepEqual(updateCalls, []);
      assert.equal(props(button(createLabel)).disabled, true);
      assert.equal(props(button("取消")).disabled, true);
      if (scenario.endsWith("unmount")) {
        await update(() => root.unmount());
        rootMounted = false;
      } else {
        await update(() => root.render(<p>Data source settings closed</p>));
      }
      await update(() => pendingCreate.resolve(structuredClone(current)));
      assert.deepEqual(pickCalls, []);
      assert.deepEqual(updateCalls, []);
      assert.equal(text(container), rootMounted ? "Data source settings closed" : "");
      assert.equal(catalog.filter((item) => item.id === "collection_new").length, 1);
    } else {
      assert.equal(
        props(find((node) => props(node).name === "collection-label")).value,
        "Added docs",
      );
      assert.equal(props(button("保存名称与设置")).disabled, false);
      assert.ok(collectionButton("collection_new"));
      if (kind === "url") {
        assert.deepEqual(pickCalls, []);
        assert.deepEqual(updateCalls[0], [
          "collection_new",
          "created-revision",
          { kind: "url", url: "https://fixture.invalid/manual.txt" },
        ]);
      } else {
        assert.deepEqual(pickCalls, [["collection_new", "created-revision", kind]]);
        assert.deepEqual(updateCalls, []);
      }

      if (scenario === "quick-add-picker-cancel") {
        assert.ok(text(editor).includes("这个资料集还没有文件。"));
        assert.equal(
          nodes(editor).filter((node) => props(node)["data-collection-entry"]).length,
          0,
        );
        assert.equal(nodes(editor).filter((node) => props(node).role === "alert").length, 0);
        await change("collection-label", "Empty docs renamed");
        await click(button("保存名称与设置"));
        assert.deepEqual(updateCalls[0], [
          "collection_new",
          "created-revision",
          {
            kind: "metadata",
            label: "Empty docs renamed",
            description: "Reusable references",
            enabled: true,
          },
        ]);
        await click(button("添加本地文件"));
        assert.deepEqual(pickCalls[1], ["collection_new", "revision-2", "files"]);
        assert.ok(text(editor).includes("added_file.txt"));
      } else if (scenario === "quick-add-picker-failure" || scenario === "quick-add-url-failure") {
        const message = kind === "url" ? "URL check failed" : "native picker failed";
        assert.ok(text(find((node) => props(node).role === "alert")).includes(message));
        assert.ok(text(editor).includes("这个资料集还没有文件。"));
        assert.equal(
          nodes(editor).filter((node) => props(node)["data-collection-entry"]).length,
          0,
        );
        if (kind === "url") {
          assert.equal(
            props(find((node) => props(node).name === "collection-url")).value.trim(),
            "https://fixture.invalid/manual.txt",
          );
          await click(button("添加并检查链接"));
          assert.deepEqual(updateCalls[1], updateCalls[0]);
          assert.ok(text(editor).includes("file_url.txt"));
          assert.equal(props(find((node) => props(node).name === "collection-url")).value, "");
        } else {
          await click(button("重新加载"));
          assert.equal(
            document.activeElement,
            find((node) => props(node).name === "collection-label"),
          );
          await click(button("添加本地文件"));
          assert.deepEqual(pickCalls[1], pickCalls[0]);
          assert.ok(text(editor).includes("added_file.txt"));
        }
        assert.equal(nodes(editor).filter((node) => props(node).role === "alert").length, 0);
      } else {
        const addedId =
          kind === "url" ? "file_url" : kind === "folder" ? "folder_file" : "added_file";
        assert.equal(
          nodes(editor).filter((node) => props(node)["data-collection-entry"]).length,
          1,
        );
        assert.ok(
          text(editor).includes(kind === "folder" ? "guides/folder_file.txt" : `${addedId}.txt`),
        );
        assert.ok(text(editor).includes("已保存"));
        if (kind === "url")
          assert.equal(props(find((node) => props(node).name === "collection-url")).value, "");
        await click(entryButton(addedId, "更新检查"));
        assert.deepEqual(updateCalls.at(-1), [
          "collection_new",
          kind === "url" ? "revision-2" : "picked-revision-1",
          { kind: "refresh", entryId: addedId },
        ]);
      }
      assert.equal(createCalls.length, 1);
    }
  } else if (scenario === "create-and-edit" || scenario === "cancel-create") {
    await click(button("新建资料集"));
    await change("collection-label", "Engineering docs");
    await change("collection-description", "Reuse across projects");
    if (scenario === "cancel-create") {
      await click(button("取消"));
      assert.deepEqual(createCalls, []);
    } else {
      const save = button("创建资料集");
      await update(() => {
        props(save).onClick();
        props(save).onClick();
      });
      assert.deepEqual(createCalls, [
        { label: "Engineering docs", description: "Reuse across projects" },
      ]);
      await change("collection-label", "Revised docs");
      await update(() =>
        props(find((node) => node.tagName === "INPUT" && props(node).type === "checkbox")).onChange(
          { target: { checked: false } },
        ),
      );
      await click(button("保存名称与设置"));
      assert.deepEqual(updateCalls[0], [
        "collection_a",
        "revision-1",
        {
          kind: "metadata",
          label: "Revised docs",
          description: "Reuse across projects",
          enabled: false,
        },
      ]);
    }
  } else if (scenario === "collection-load-failure") {
    await click(collectionButton("collection_a"));
    await click(collectionButton("collection_b"));
    assert.ok(text(container).includes("collection lookup failed"));
    assert.equal(
      nodes().filter((node) => node.tagName === "BUTTON" && text(node) === "删除资料集").length,
      0,
    );
    assert.equal(
      nodes().filter((node) => node.tagName === "BUTTON" && text(node) === "创建资料集").length,
      0,
    );
    assert.equal(deleteCalls.length, 0);
  } else if (scenario === "stale-collection-load") {
    await click(collectionButton("collection_a"));
    await click(collectionButton("collection_b"));
    await update(() => pendingView.resolve(current));
    assert.equal(
      props(find((node) => props(node).name === "collection-label")).value,
      "Second docs",
    );
    assert.ok(text(container).includes("文件失效"));
    assert.equal(deleteCalls.length, 0);
  } else if (
    !scenario.startsWith("project-") &&
    scenario !== "profile-excluded-binding" &&
    scenario !== "stale-project-load" &&
    scenario !== "stale-scope-load"
  ) {
    await click(collectionButton("collection_a"));
    assert.ok(text(container).includes("/fixture/docs/file_a.txt"));
    assert.ok(text(container).includes("上次检查记录"));
    if (scenario === "picker-cancel-lock") {
      await change("collection-label", "Unsaved name");
      const picker = button("添加本地文件");
      await update(() => {
        props(picker).onClick();
        props(picker).onClick();
      });
      assert.deepEqual(pickCalls, [["collection_a", "revision-1", "files"]]);
      await update(() => pendingPick.resolve(null));
      assert.equal(
        props(find((node) => props(node).name === "collection-label")).value,
        "Unsaved name",
      );
      assert.equal(nodes().filter((node) => props(node)["data-collection-entry"]).length, 2);
    } else if (scenario === "folder-current-list") {
      await click(button("添加文件夹当前清单"));
      assert.deepEqual(pickCalls, [["collection_a", "revision-1", "folder"]]);
      assert.ok(text(container).includes("folder_file.txt"));
      assert.ok(text(container).includes("新增文件需再次添加"));
      await click(entryButton("folder_file", "更新检查"));
      assert.equal(updateCalls[0][1], "revision-folder");
    } else if (scenario === "url-refresh-failure") {
      await change("collection-url", "https://fixture.invalid/manual.txt");
      await click(button("添加并检查链接"));
      assert.deepEqual(updateCalls[0], [
        "collection_a",
        "revision-1",
        { kind: "url", url: "https://fixture.invalid/manual.txt" },
      ]);
      await click(entryButton("file_a", "更新检查"));
      assert.equal(updateCalls[1][1], "revision-2");
      assert.ok(text(container).includes("refresh rejected; old manifest retained"));
      assert.equal(nodes().filter((node) => props(node)["data-collection-entry"]).length, 3);
    } else if (scenario === "remove-cancel") {
      confirmResult = false;
      await click(entryButton("file_a", "移出资料集"));
      assert.equal(updateCalls.length, 0);
      confirmResult = true;
      await click(entryButton("file_a", "移出资料集"));
      assert.deepEqual(updateCalls[0], [
        "collection_a",
        "revision-1",
        { kind: "remove", entryId: "file_a" },
      ]);
      assert.ok(confirmations[0].message.includes("不会删除原文件"));
    } else if (scenario === "cancel-confirmation") {
      await click(entryButton("file_a", "移出资料集"));
      await click(button("关闭"));
      await update(() => pendingConfirm.resolve(true));
      assert.equal(updateCalls.length, 0);
    } else if (scenario === "delete-impact") {
      await click(button("删除资料集"));
      assert.deepEqual(deleteCalls, [["collection_a", "revision-latest"]]);
      assert.ok(confirmations[0].message.includes("2 个已确认引用的项目"));
      assert.ok(confirmations[0].message.includes("离线项目也可能保留引用"));
      assert.ok(confirmations[0].detail.includes("Website、Support"));
    } else if (scenario === "delete-inspection-failure") {
      await click(button("删除资料集"));
      assert.equal(confirmations.length, 0);
      assert.equal(deleteCalls.length, 0);
      assert.ok(text(container).includes("impact inspection failed"));
    } else assert.fail(`unhandled global scenario ${scenario}`);
  } else if (scenario === "stale-project-load") {
    await render("project-b");
    await update(() =>
      pendingSnapshot.resolve({ bindings: [originalBinding], access: [access], uploads: [] }),
    );
    assert.equal(nodes().filter((node) => props(node)["data-source-access"]).length, 0);
    assert.equal(bindCalls.length, 0);
  } else if (scenario === "project-compatibility") {
    assert.ok(text(container).includes("old.md"));
    assert.ok(text(container).includes("Legacy MCP"));
    assert.ok(!text(container).includes("Duplicated uploads source"));
    assert.equal(nodes().filter((node) => props(node)["data-source-upload"]).length, 1);
    assert.equal(nodes().filter((node) => props(node)["data-source-access"]).length, 1);
    await click(button("解绑"));
    assert.deepEqual(unbindCalls, [["project-a", "legacy_mcp"]]);
  } else if (scenario === "profile-excluded-binding") {
    assert.ok(text(container).includes("当前数字人未开放此源"));
    assert.equal(nodes().filter((node) => props(node)["data-source-access"]).length, 1);
    await click(button("调整引用"));
    assert.equal(props(find((node) => props(node)["data-scope-id"] === "file_a")).checked, true);
    assert.equal(props(find((node) => props(node)["data-scope-id"] === "file_b")).checked, false);
    await click(button("保存引用范围"));
    assert.deepEqual(bindCalls, [["project-a", { ...originalBinding, priority: "normal" }]]);
  } else if (scenario === "project-priority-order") {
    const rows = nodes().filter((node) => props(node)["data-source-access"]);
    assert.equal(rows.length, 2);
    assert.ok(text(rows[0]).includes("Second docs"));
    assert.ok(text(rows[0]).includes(t("sourceCollections.linkedFiles.high")));
    assert.ok(text(rows[1]).includes("Product docs"));
    assert.ok(!text(rows[1]).includes(t("sourceCollections.linkedFiles.high")));
    assert.deepEqual(bindCalls, []);
  } else if (scenario.startsWith("project-priority-edit-")) {
    await click(button("调整引用"));
    assert.equal(props(find((node) => props(node)["aria-label"] === "权重")).value, "high");
    assert.equal(props(find((node) => props(node)["data-scope-id"] === "file_a")).checked, true);
    assert.equal(props(find((node) => props(node)["data-scope-id"] === "file_b")).checked, false);
    assert.deepEqual(bindCalls, []);
    if (scenario === "project-priority-edit-change") await select("权重", "normal");
    await click(button("保存引用范围"));
    assert.deepEqual(bindCalls, [
      [
        "project-a",
        {
          ...originalBinding,
          priority: scenario === "project-priority-edit-change" ? "normal" : "high",
        },
      ],
    ]);
  } else {
    await select("数据源", "collection_a");
    if (scenario === "stale-scope-load") {
      await select("数据源", "collection_b");
      await update(() => pendingScopes.resolve(scopeList));
      assert.equal(nodes().filter((node) => props(node)["data-scope-id"] === "file_a").length, 0);
      assert.equal(nodes().filter((node) => props(node)["data-scope-id"] === "file_c").length, 1);
      assert.equal(bindCalls.length, 0);
    } else {
      assert.equal(props(find((node) => props(node)["aria-label"] === "权重")).value, "normal");
      assert.equal(props(button("绑定所选范围")).disabled, true);
      if (scenario === "project-all-current") {
        await select("资料集", "all");
        scopeList.push({ id: "file_new", label: "new.txt" });
      } else
        await update(() =>
          props(find((node) => props(node)["data-scope-id"] === "file_b")).onChange({
            target: { checked: true },
          }),
        );
      const bind = button("绑定所选范围");
      if (scenario === "project-priority-new-high") await select("权重", "high");
      await update(() => {
        props(bind).onClick();
        props(bind).onClick();
      });
      assert.deepEqual(bindCalls, [
        [
          "project-a",
          {
            sourceId: "collection_a",
            scopes: scenario === "project-all-current" ? ["file_a", "file_b"] : ["file_b"],
            readPolicy: "ask",
            priority: scenario === "project-priority-new-high" ? "high" : "normal",
          },
        ],
      ]);
      if (scenario === "project-save-lock") {
        await render("project-b");
        await update(() => pendingBind.resolve());
        assert.deepEqual(toasts, []);
      }
    }
  }
  assert.deepEqual(forbiddenCalls, []);
  assert.equal(unexpectedRequests, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(unhandled, []);
  process.stdout.write(JSON.stringify({ scenario, passed: true, unexpectedRequests }));
} finally {
  if (rootMounted) await act(async () => root.unmount());
  container.parentNode?.removeChild(container);
}
