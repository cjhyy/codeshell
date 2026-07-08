import { describe, expect, test } from "bun:test";
import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MobileSessionSwitcher,
  MobileSessionSwitcherView,
  type MobileSessionTab,
} from "./MobileSessionSwitcher";

const labels: Record<MobileSessionTab, string> = {
  sessions: "会话",
  cc: "CC 会话",
};
const sessionsContent = <div data-testid="sessions-list">SessionList content</div>;
const ccContent = <div data-testid="cc-list">CcSessionList content</div>;

function renderControlled(tab: MobileSessionTab, onTabChange: (tab: MobileSessionTab) => void) {
  return renderToStaticMarkup(
    <MobileSessionSwitcherView
      tab={tab}
      onTabChange={onTabChange}
      labels={labels}
      sessionsContent={sessionsContent}
      ccContent={ccContent}
    />,
  );
}

function viewTree(tab: MobileSessionTab, onTabChange: (tab: MobileSessionTab) => void) {
  return MobileSessionSwitcherView({
    tab,
    onTabChange,
    labels,
    sessionsContent,
    ccContent,
  });
}

function findTabButton(node: ReactNode, tab: MobileSessionTab): ReactElement<{ onClick: () => void }> {
  if (!React.isValidElement(node)) throw new Error(`tab button ${tab} not found`);
  if (node.type === "button" && (node.props as { "data-tab"?: string })["data-tab"] === tab) {
    return node as ReactElement<{ onClick: () => void }>;
  }
  for (const child of React.Children.toArray((node.props as { children?: ReactNode }).children)) {
    try {
      return findTabButton(child, tab);
    } catch {
      // Keep walking siblings.
    }
  }
  throw new Error(`tab button ${tab} not found`);
}

describe("MobileSessionSwitcher", () => {
  test("默认显示普通会话列表", () => {
    const html = renderToStaticMarkup(
      <MobileSessionSwitcher sessionsContent={sessionsContent} ccContent={ccContent} />,
    );
    expect(html).toContain('data-testid="sessions-list"');
    expect(html).not.toContain('data-testid="cc-list"');
    expect(html).toContain("会话");
    expect(html).toContain("CC 会话");
  });

  test("activeRoom 存在时默认选中 CC 会话", () => {
    const html = renderToStaticMarkup(
      <MobileSessionSwitcher
        activeRoom={{ id: "room-1" }}
        sessionsContent={sessionsContent}
        ccContent={ccContent}
      />,
    );
    expect(html).toContain('data-testid="cc-list"');
    expect(html).not.toContain('data-testid="sessions-list"');
  });

  test("点击 CC 后只显示 CC 列表，再点会话恢复普通会话列表", () => {
    let tab: MobileSessionTab = "sessions";
    const onTabChange = (next: MobileSessionTab) => {
      tab = next;
    };

    let html = renderControlled(tab, onTabChange);
    expect(html).toContain('data-testid="sessions-list"');
    expect(html).not.toContain('data-testid="cc-list"');

    findTabButton(viewTree(tab, onTabChange), "cc").props.onClick();
    expect(tab).toBe("cc");
    html = renderControlled(tab, onTabChange);
    expect(html).toContain('data-testid="cc-list"');
    expect(html).not.toContain('data-testid="sessions-list"');

    findTabButton(viewTree(tab, onTabChange), "sessions").props.onClick();
    expect(tab).toBe("sessions");
    html = renderControlled(tab, onTabChange);
    expect(html).toContain('data-testid="sessions-list"');
    expect(html).not.toContain('data-testid="cc-list"');
  });
});
