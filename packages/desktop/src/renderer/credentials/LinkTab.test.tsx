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

describe("LinkTab OAuth recovery", () => {
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
