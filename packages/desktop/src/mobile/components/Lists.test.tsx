import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectRootPicker, SessionList } from "./SessionList";
import type { MobileProjectMeta, MobileSessionMeta } from "@protocol";

const sessions: MobileSessionMeta[] = [
  {
    id: "s1",
    title: "重构手机 UI",
    cwd: "/Users/x/codeshell",
    updatedAt: Date.now(),
    origin: "desktop",
  },
  {
    id: "s2",
    title: "夜批任务",
    cwd: "/Users/x/proj",
    updatedAt: Date.now(),
    origin: "automation",
  },
];
const projects: MobileProjectMeta[] = [
  { path: "/Users/x/codeshell", name: "codeshell", addedAt: 1 },
  { path: "/Users/x/proj", name: "proj", addedAt: 2 },
];

test("SessionList 显示标题/项目名/automation 标", () => {
  const html = renderToStaticMarkup(
    <SessionList
      sessions={sessions}
      projects={projects}
      onSelect={() => {}}
      onNew={() => {}}
      onRefresh={() => {}}
    />,
  );
  expect(html).toContain("重构手机 UI");
  expect(html).toContain("codeshell");
  expect(html).toContain("自动"); // automation badge
  expect(html).toContain("新建");
});

test("SessionList 空态", () => {
  const html = renderToStaticMarkup(
    <SessionList
      sessions={[]}
      projects={[]}
      onSelect={() => {}}
      onNew={() => {}}
      onRefresh={() => {}}
    />,
  );
  expect(html).toContain("还没有会话");
});

test("SessionList 给未读普通会话显示圆点,当前会话不显示", () => {
  const html = renderToStaticMarkup(
    <SessionList
      sessions={sessions}
      projects={projects}
      activeSessionId="s1"
      unreadSessionIds={new Set(["s2"])}
      onSelect={() => {}}
      onNew={() => {}}
      onRefresh={() => {}}
    />,
  );
  expect(html).toContain("有新内容");
  expect(html).toContain("size-2 shrink-0 rounded-full bg-primary");

  const activeHtml = renderToStaticMarkup(
    <SessionList
      sessions={sessions}
      projects={projects}
      activeSessionId="s2"
      unreadSessionIds={new Set(["s2"])}
      onSelect={() => {}}
      onNew={() => {}}
      onRefresh={() => {}}
    />,
  );
  expect(activeHtml).not.toContain("有新内容");
});

test("SessionList 展开 V2 项目的全部 roots 并标注主/次目录", () => {
  const html = renderToStaticMarkup(
    <ProjectRootPicker
      projects={[
        {
          id: "project-1",
          path: "/work/primary",
          name: "multi-root",
          primaryRootId: "root-primary",
          roots: [
            { id: "root-primary", path: "/work/primary", name: "primary", role: "primary" },
            {
              id: "root-secondary",
              path: "/docs/secondary",
              name: "docs",
              role: "secondary",
            },
          ],
        },
      ]}
      activeProjectId="project-1"
      onNew={() => {}}
    />,
  );
  expect(html).toContain("multi-root");
  expect(html).toContain("/work/primary");
  expect(html).toContain("/docs/secondary");
  expect(html).toContain("主目录");
  expect(html).toContain("次目录");
});
