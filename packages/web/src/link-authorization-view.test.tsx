import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { LinkAuthorization, LinkAuthorizationResponse } from "@cjhyy/code-shell-link";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook.js";
import { LinkAuthorizationStepView } from "./link-authorization-view.js";

type Element = React.ReactElement<Record<string, any>>;
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (React.isValidElement(node)) return text((node as Element).props.children);
  return typeof node === "string" ? node : "";
}
const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});
async function fixture(authorization: LinkAuthorization) {
  ensureMiniDom();
  const responses: LinkAuthorizationResponse[] = [];
  let tree: React.ReactNode;
  function Mounted() {
    tree = LinkAuthorizationStepView({
      authorization,
      onRespond: (response) => responses.push(response),
      onOpenUrl: () => {
        throw new Error("No automatic navigation allowed");
      },
    });
    return tree;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(<Mounted />);
    await flushMicrotasks();
  });
  unmounts.push(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
  return {
    get tree() {
      return tree;
    },
    responses,
  };
}
function authorization(step: LinkAuthorization["step"]): LinkAuthorization {
  return { id: "attempt", providerId: "fixture", state: "pending", step };
}
const base = () => ({ id: "step-1", expiresAt: new Date(Date.now() + 60_000).toISOString() });

test("credential secrets clear after a single explicit submission and rejection remains visible", async () => {
  const value = authorization({
    ...base(),
    kind: "credential-input",
    purpose: "verification-code",
    fields: [{ id: "code", label: "Provider verification code", secret: true, required: true }],
  });
  value.errorCode = "provider_rejected";
  const view = await fixture(value);
  expect(text(view.tree)).toContain("服务商未接受");
  expect(view.responses).toHaveLength(0);
  await act(async () => {
    elements(view.tree)
      .find((element) => element.type === "input")!
      .props.onChange({ target: { value: "synthetic-one-time-code" } });
  });
  await act(async () => {
    elements(view.tree)
      .find((element) => element.type === "form")!
      .props.onSubmit({ preventDefault() {} });
  });
  expect(view.responses).toEqual([
    { stepId: "step-1", operation: "submit", input: { code: "synthetic-one-time-code" } },
  ]);
  expect(elements(view.tree).find((element) => element.type === "input")!.props.value).toBe("");
});

test("expired QR never exposes the old image or payload and refresh is an explicit response", async () => {
  const view = await fixture(
    authorization({ ...base(), kind: "qr-code", phase: "expired", canRefresh: true }),
  );
  expect(text(view.tree)).toContain("二维码已过期");
  expect(elements(view.tree).some((element) => element.type === "img")).toBe(false);
  await act(async () => {
    elements(view.tree)
      .find((element) => element.type === "button")!
      .props.onClick();
  });
  expect(view.responses).toEqual([{ stepId: "step-1", operation: "refresh-qr" }]);
});

test("unsafe redirect is inert and consent remains blocked until required resources are chosen", async () => {
  const redirect = await fixture(
    authorization({ ...base(), kind: "redirect", authorizationUrl: "javascript:alert(1)" }),
  );
  expect(elements(redirect.tree).some((element) => element.type === "button")).toBe(false);
  expect(text(redirect.tree)).toContain("授权地址无效");
  const view = await fixture(
    authorization({
      ...base(),
      kind: "consent",
      account: { label: "Fixture account" },
      permissions: [{ id: "read", label: "Read", required: true }],
      resourceGroups: [
        {
          id: "repositories",
          label: "Repositories",
          minSelected: 1,
          items: [{ id: "repo-1", label: "Selected repository" }],
        },
      ],
    }),
  );
  expect(elements(view.tree).find((element) => element.type === "button")!.props.disabled).toBe(
    true,
  );
  const boxes = elements(view.tree).filter((element) => element.type === "input");
  expect(boxes[0].props.checked).toBe(true);
  expect(boxes[0].props.disabled).toBe(true);
  await act(async () => {
    boxes[1].props.onChange({ target: { checked: true } });
  });
  expect(elements(view.tree).find((element) => element.type === "button")!.props.disabled).toBe(
    false,
  );
  await act(async () => {
    elements(view.tree)
      .find((element) => element.type === "form")!
      .props.onSubmit({ preventDefault() {} });
  });
  expect(view.responses).toEqual([
    {
      stepId: "step-1",
      operation: "confirm",
      input: { repositories: ["repo-1"], permissions: ["read"] },
    },
  ]);
});
