import { expect, test } from "bun:test";
import type { IpcRendererEvent } from "electron";
import {
  createNotificationNavigationApi,
  NOTIFICATION_OPEN_SESSION_CHANNEL,
} from "./notification-navigation-api.js";

test("buffers a native click before renderer subscription and consumes it once", async () => {
  let emit!: (event: IpcRendererEvent, payload: unknown) => void;
  const api = createNotificationNavigationApi({
    on: (channel, listener) => {
      expect(channel).toBe(NOTIFICATION_OPEN_SESSION_CHANNEL);
      emit = listener;
    },
  });
  emit({} as IpcRendererEvent, "s-before-mount");
  emit({} as IpcRendererEvent, null);
  const first: string[] = [];
  const off = api.onNotificationOpenSession((id) => first.push(id));
  await Promise.resolve();
  expect(first).toEqual(["s-before-mount"]);
  off();
  const second: string[] = [];
  api.onNotificationOpenSession((id) => second.push(id));
  expect(second).toEqual([]);
  emit({} as IpcRendererEvent, "s-after-mount");
  expect(first).toEqual(["s-before-mount"]);
  expect(second).toEqual(["s-after-mount"]);
});

test("a buffered click survives effect cleanup and reaches only the remounted listener", async () => {
  let emit!: (event: IpcRendererEvent, payload: unknown) => void;
  const api = createNotificationNavigationApi({
    on: (_channel, listener) => {
      emit = listener;
    },
  });
  emit({} as IpcRendererEvent, "s-before-mount");
  const retired: string[] = [];
  const off = api.onNotificationOpenSession((id) => retired.push(id));
  off();
  const remounted: string[] = [];
  api.onNotificationOpenSession((id) => remounted.push(id));
  await Promise.resolve();
  expect(retired).toEqual([]);
  expect(remounted).toEqual(["s-before-mount"]);
});

test("a new live click supersedes a buffered click before its deferred delivery", async () => {
  let emit!: (event: IpcRendererEvent, payload: unknown) => void;
  const api = createNotificationNavigationApi({
    on: (_channel, listener) => {
      emit = listener;
    },
  });
  emit({} as IpcRendererEvent, "s-old");
  const opened: string[] = [];
  api.onNotificationOpenSession((id) => opened.push(id));
  emit({} as IpcRendererEvent, "s-new");
  await Promise.resolve();
  expect(opened).toEqual(["s-new"]);
});
