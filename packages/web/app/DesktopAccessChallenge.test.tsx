import { expect, test } from "bun:test";
import React from "react";
import { DesktopAccessChallenge } from "./DesktopAccessChallenge.js";

test("the access challenge explains retained pairing and waits for explicit verification", () => {
  let reloads = 0;
  const tree = DesktopAccessChallenge({ onVerify: () => reloads++ });
  const children = React.Children.toArray(
    tree.props.children.props.children,
  ) as React.ReactElement<{
    children?: string;
    onClick?: () => void;
  }>[];
  expect(children.find((child) => child.type === "h1")?.props.children).toBe(
    "访问口令已更新，请重新验证",
  );
  expect(children.find((child) => child.type === "p")?.props.children).toContain("设备配对已保留");
  const verify = children.find((child) => child.type === "button");
  expect(verify?.props.children).toBe("重新验证");
  expect(reloads).toBe(0);
  verify?.props.onClick?.();
  expect(reloads).toBe(1);
});

test("an unsent draft stays available to copy before the user reloads", () => {
  const tree = DesktopAccessChallenge({ draft: "Keep this draft", onVerify: () => {} });
  const children = React.Children.toArray(
    tree.props.children.props.children,
  ) as React.ReactElement<{
    children?: React.ReactNode;
  }>[];
  const label = children.find((child) => child.type === "label")!;
  const textarea = React.Children.toArray(label.props.children).find(
    (child) => React.isValidElement(child) && child.type === "textarea",
  ) as React.ReactElement<{ value: string; readOnly: boolean }>;
  expect(textarea.props).toMatchObject({ value: "Keep this draft", readOnly: true });
});
