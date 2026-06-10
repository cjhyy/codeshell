import { test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionList } from "./SessionList";
import { RoomList } from "./RoomList";
import type { MobileSessionMeta, RoomPublic } from "@protocol";

const sessions: MobileSessionMeta[] = [
  { id: "s1", title: "重构手机 UI", cwd: "/Users/x/codeshell", updatedAt: Date.now(), origin: "desktop" },
  { id: "s2", title: "夜批任务", cwd: "/Users/x/proj", updatedAt: Date.now(), origin: "automation" },
];

test("SessionList 显示标题/项目名/automation 标", () => {
  const html = renderToStaticMarkup(
    <SessionList sessions={sessions} onSelect={() => {}} onNew={() => {}} onRefresh={() => {}} />,
  );
  expect(html).toContain("重构手机 UI");
  expect(html).toContain("codeshell");
  expect(html).toContain("自动"); // automation badge
  expect(html).toContain("新建");
});

test("SessionList 空态", () => {
  const html = renderToStaticMarkup(
    <SessionList sessions={[]} onSelect={() => {}} onNew={() => {}} onRefresh={() => {}} />,
  );
  expect(html).toContain("还没有会话");
});

const rooms: RoomPublic[] = [
  {
    id: "r1",
    name: "codeshell",
    cwd: "/Users/x/codeshell",
    permissionMode: "bypassPermissions",
    createdAt: 0,
    lastActiveAt: Date.now(),
    open: true,
  },
];

test("RoomList 显示危险 badge", () => {
  const html = renderToStaticMarkup(
    <RoomList
      rooms={rooms}
      projects={[]}
      onRefresh={() => {}}
      onOpen={() => {}}
      onCreate={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain("codeshell");
  expect(html).toContain("危险"); // bypassPermissions badge
});
