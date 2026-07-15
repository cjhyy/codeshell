import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { LINK_CATALOG } from "./link-catalog";
import { LinkTab } from "./LinkTab";
import type { MaskedCredentialView } from "./types";

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

function buttonWithLabel(container: HTMLElement, label: string): any {
  return findElements(container, "BUTTON").find(
    (button) => reactPropsOf(button).children === label,
  );
}

function buttonWithAriaLabel(container: HTMLElement, label: string): any {
  return findElements(container, "BUTTON").find(
    (button) => reactPropsOf(button)["aria-label"] === label,
  );
}

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

describe("LinkTab integrations", () => {
  test("surfaces the Chat Gateway in Link and starts configured channels", async () => {
    ensureMiniDom();
    let starts = 0;
    const openedUrls: string[] = [];
    Object.assign(window, {
      codeshell: {
        imGateway: {
          status: async () => ({
            running: false,
            configPath: "/home/user/.code-shell/im-gateway/config.json",
            configExists: true,
            channels: ["telegram"],
            wechatConnected: false,
          }),
          start: async () => {
            starts += 1;
            return {
              running: true,
              configPath: "/home/user/.code-shell/im-gateway/config.json",
              configExists: true,
              channels: ["telegram"],
              wechatConnected: false,
            };
          },
          stop: async () => undefined,
          ensureConfig: async () => "/home/user/.code-shell/im-gateway/config.json",
          loginWechat: async () => ({
            accountId: "wechat-owner",
            configPath: "/home/user/.code-shell/im-gateway/config.json",
          }),
          cancelWechatLogin: async () => false,
          submitWechatVerification: async () => true,
          onEvent: () => () => undefined,
        },
        openInEditor: async () => "editor",
        openPath: async (path: string) => path,
        openExternal: async (url: string) => void openedUrls.push(url),
        credentials: { list: async () => [] },
        mcpOAuth: {
          refresh: async () => undefined,
          login: async () => undefined,
          logout: async () => ({ removed: true, remoteRevoked: true }),
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(<LinkTab cwd="/repo" />);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(buttonWithLabel(container, "连接个人微信")).toBeDefined();
    const telegramSetup = buttonWithAriaLabel(container, "Telegram：打开官方配置页");
    expect(telegramSetup).toBeDefined();
    await act(async () => {
      reactPropsOf(telegramSetup).onClick();
      await flushMicrotasks();
    });
    expect(openedUrls).toEqual(["https://t.me/BotFather"]);
    const start = buttonWithLabel(container, "启动");
    expect(start).toBeDefined();
    await act(async () => {
      reactPropsOf(start).onClick();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flushMicrotasks();
    });
    expect(starts).toBe(1);
    expect(buttonWithLabel(container, "停止")).toBeDefined();
  });

  test("reloads invalid_grant metadata after refresh rejection and relogs with the same id", async () => {
    ensureMiniDom();
    const figma = LINK_CATALOG.flatMap((category) => category.items).find(
      (item) => item.id === "figma",
    );
    if (!figma) throw new Error("missing Figma catalog fixture");
    const previousProfileId = figma.oauthProfileId;
    figma.oauthProfileId = "figma-profile";

    let invalidGrant = false;
    const loginInputs: unknown[] = [];
    const credential = (): MaskedCredentialView => ({
      id: "figma-oauth",
      type: "oauth",
      label: "Figma OAuth",
      hasSecret: true,
      oauthStatus: { state: "expired" },
      meta: {
        oauthProvider: "figma",
        ...(invalidGrant ? { lastRefreshErrorCode: "invalid_grant" as const } : {}),
      },
    });
    Object.assign(window, {
      codeshell: {
        imGateway: {
          status: async () => ({
            running: false,
            configPath: "/home/user/.code-shell/im-gateway/config.json",
            configExists: false,
            channels: [],
            wechatConnected: false,
          }),
          start: async () => undefined,
          stop: async () => undefined,
          ensureConfig: async () => "/home/user/.code-shell/im-gateway/config.json",
          loginWechat: async () => ({
            accountId: "wechat-owner",
            configPath: "/home/user/.code-shell/im-gateway/config.json",
          }),
          cancelWechatLogin: async () => false,
          submitWechatVerification: async () => true,
          onEvent: () => () => undefined,
        },
        openInEditor: async () => "editor",
        openPath: async (path: string) => path,
        openExternal: async () => undefined,
        credentials: { list: async () => [credential()] },
        mcpOAuth: {
          refresh: async () => {
            invalidGrant = true;
            throw new Error("OAuth credential requires login");
          },
          login: async (input: unknown) => {
            loginInputs.push(input);
            return { credential: credential() };
          },
          logout: async () => ({ removed: true, remoteRevoked: true }),
        },
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    try {
      await act(async () => {
        root?.render(<LinkTab cwd="/repo" />);
        await flushMicrotasks();
        await flushMicrotasks();
      });

      const refresh = buttonWithLabel(container, "刷新");
      expect(refresh).toBeDefined();
      await act(async () => {
        reactPropsOf(refresh).onClick();
        await flushMicrotasks();
        await flushMicrotasks();
      });

      const relogin = buttonWithLabel(container, "重新登录");
      expect(relogin).toBeDefined();
      await act(async () => {
        reactPropsOf(relogin).onClick();
        await flushMicrotasks();
      });
      expect(loginInputs).toEqual([
        { source: "catalog", profileId: "figma-profile", credentialId: "figma-oauth" },
      ]);
    } finally {
      figma.oauthProfileId = previousProfileId;
    }
  });
});
