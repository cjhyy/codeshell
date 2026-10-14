// Isolate component seams so mocks cannot alter another renderer test.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { TrackedProject } from "../projects";

const denyNetwork = () => {
  throw new Error("Data source navigation fixture denies network requests");
};
globalThis.fetch = denyNetwork as unknown as typeof fetch;
http.request = denyNetwork as typeof http.request;
http.get = denyNetwork as typeof http.get;
https.request = denyNetwork as typeof https.request;
https.get = denyNetwork as typeof https.get;
syncBuiltinESMExports();
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));
ensureMiniDom();

const { translate } = await import("../i18n/translate");
mock.module("../i18n/I18nProvider", () => ({
  useT: () => ({ t: (key: any, parameters?: any) => translate("zh", key, parameters) }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
mock.module("@/components/ui/simple-select", () => ({
  SimpleSelect: ({ value, options, onChange, ariaLabel, disabled }: any) => (
    <select
      value={value}
      aria-label={ariaLabel}
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
let catalogProps: any;
mock.module("../credentials/DataSourceCatalogSection", () => ({
  DataSourceCatalogSection: (props: any) => {
    catalogProps = props;
    return <p data-fixture-catalog>Reusable collection list</p>;
  },
}));
let projectProps: any;
mock.module("../project-config/DataSourcesSection", () => ({
  DataSourcesSection: (props: any) => {
    projectProps = props;
    return <p data-fixture-project={props.projectId}>Project document references</p>;
  },
}));
let linkedProps: any;
mock.module("../credentials/LinkedFileSourcesDialog", () => ({
  LinkedFileSourcesDialog: (props: any) => {
    linkedProps = props;
    return <div role="dialog">Choose online documents</div>;
  },
}));
const projects: TrackedProject[] = ["a", "b"].map((id) => ({
  id: `project-${id}`,
  name: `Project ${id.toUpperCase()}`,
  path: `/fixture/project-${id}`,
  roots: [],
  primaryRootId: `root-${id}`,
  addedAt: 1,
}));
const { DataSourcesModule } = await import("./DataSourcesModule");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const openProjects: string[] = [];
let manageConnections = 0;
let manageCollections = 0;
const connectionCallback = () => manageConnections++;
const collectionCallback = () => manageCollections++;
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
const button = (label: string) => {
  const node = nodes().find((item) => item.tagName === "BUTTON" && text(item) === label);
  assert.ok(node, text(container));
  return node;
};
const dialogs = () => nodes().filter((node) => props(node).role === "dialog");
async function update(operation: () => unknown) {
  await act(async () => {
    operation();
    await flushMicrotasks();
  });
}
async function render(scope: "user" | "project", projectId: string | null = null) {
  await update(() =>
    root.render(
      <DataSourcesModule
        scope={scope}
        projectId={projectId}
        projects={projects.map((project) => ({ ...project }))}
        returnProjectId="project-a"
        onOpenProject={(id) => openProjects.push(id)}
        onManageConnections={connectionCallback}
        onManageCollections={collectionCallback}
      />,
    ),
  );
}
try {
  await render("user");
  assert.equal(dialogs().length, 0);
  assert.ok(!text(container).includes("从 Link 选择文件"));
  assert.equal(props(button("管理项目数据源")).disabled, true);
  assert.equal(catalogProps.onManageConnections, connectionCallback);
  const picker = nodes().find(
    (node) => node.tagName === "SELECT" && props(node)["aria-label"] === "选择要配置的项目",
  );
  assert.ok(picker);
  await update(() => props(picker).onChange({ target: { value: "project-b" } }));
  await update(() => props(button("管理项目数据源")).onClick());
  await update(() => props(button("返回 Project A 数据源")).onClick());
  assert.deepEqual(openProjects, ["project-b", "project-a"]);
  await update(() => catalogProps.onManageConnections());
  assert.equal(manageConnections, 1);

  await render("project", "project-a");
  assert.equal(projectProps.projectId, "project-a");
  await update(() => projectProps.onManageCollections());
  assert.equal(manageCollections, 1);
  await update(() => props(button("从 Link 选择文件")).onClick());
  assert.equal(dialogs().length, 1);
  assert.equal(linkedProps.initialProjectId, "project-a");
  assert.deepEqual(
    linkedProps.projects.map((project: TrackedProject) => project.id),
    ["project-a"],
  );
  await render("project", "project-a");
  assert.equal(dialogs().length, 1, "an unrelated rerender preserves the active selection");
  await render("project", "project-b");
  assert.equal(dialogs().length, 0, "changing project resets transient selection synchronously");
  await update(() => props(button("从 Link 选择文件")).onClick());
  assert.equal(linkedProps.initialProjectId, "project-b");
  await render("user");
  assert.equal(dialogs().length, 0, "global library cannot retain a project add dialog");
  assert.ok(!text(container).includes("从 Link 选择文件"));
  await render("project", "project-a");
  assert.equal(dialogs().length, 0);
  process.stdout.write(JSON.stringify({ passed: true }));
} finally {
  await act(async () => root.unmount());
  container.parentNode?.removeChild(container);
}
