import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GenericToolCard } from "./GenericToolCard";
import type { ToolMessage } from "../types";
import type { BackgroundWorkInfo } from "../../preload/types";
import { DriveAgentJobsProvider } from "./DriveAgentJobsContext";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

function msg(over: Partial<ToolMessage> = {}): ToolMessage {
  return {
    kind: "tool",
    id: "t1",
    toolName: "PowerShell",
    args: JSON.stringify({ command: "Write-Output hi" }),
    result: "hi",
    status: "succeeded",
    startedAt: 0,
    ...over,
  };
}

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

function cliLinkButton(container: HTMLElement): any {
  return findElements(container, "BUTTON").find(
    (button) => reactPropsOf(button)["aria-label"] === "打开 Codex 会话",
  );
}

describe("GenericToolCard sandbox badge", () => {
  test("shows the unisolated badge for tools that carry sandbox status", () => {
    const html = renderToStaticMarkup(
      <GenericToolCard message={msg({ sandbox: { backend: "off" } })} />,
    );
    expect(html).toContain("未隔离");
  });

  test("does not label tools without sandbox status as unisolated", () => {
    const html = renderToStaticMarkup(<GenericToolCard message={msg()} />);
    expect(html).not.toContain("未隔离");
  });

  test("shows isolated backend details instead of the unisolated badge", () => {
    const html = renderToStaticMarkup(
      <GenericToolCard message={msg({ sandbox: { backend: "seatbelt", network: "deny" } })} />,
    );
    expect(html).toContain("seatbelt");
    expect(html).toContain("网络禁止");
    expect(html).not.toContain("未隔离");
  });
});

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

describe("GenericToolCard DriveAgent CLI link", () => {
  const job: Extract<BackgroundWorkInfo, { kind: "job" }> = {
    kind: "job",
    jobId: "cc-abc123",
    description: "DriveAgent(codex): delegate",
    status: "completed",
    startedAt: 1,
    jobKind: "drive-agent",
    externalSessionId: "thread-1",
    cli: "codex",
    cwd: "/repo/worktree",
    sourceSession: { sessionId: "engine-1", shortId: "engine-1", current: true },
  };

  async function renderCard(backgroundJobs: Array<typeof job>) {
    ensureMiniDom();
    // This global leaks to later test files in the same bun process, and
    // Radix dispatches `new CustomEvent(type)` with NO init — keep it optional.
    class DetailEvent<T> extends Event {
      readonly detail: T | undefined;
      constructor(type: string, init?: { detail?: T }) {
        super(type);
        this.detail = init?.detail;
      }
    }
    Object.assign(globalThis, { CustomEvent: DetailEvent });
    Object.assign(window, { CustomEvent: DetailEvent });
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DriveAgentJobsProvider jobs={backgroundJobs}>
          <GenericToolCard
            message={msg({
              toolName: "DriveAgent",
              result: "已在后台启动 Codex（jobId cc-abc123）。完成后会通知你结果。",
            })}
          />
        </DriveAgentJobsProvider>,
      );
      await flushMicrotasks();
    });
    return container;
  }

  test("renders a link and dispatches the existing CLI-session event with matched detail", async () => {
    const container = await renderCard([job]);
    const details: unknown[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent).detail);
    window.addEventListener("codeshell:open-cli-session", listener);

    const button = cliLinkButton(container);
    expect(button).toBeDefined();
    await act(async () => reactPropsOf(button).onClick({ stopPropagation: () => undefined }));

    window.removeEventListener("codeshell:open-cli-session", listener);
    expect(details).toEqual([
      {
        externalSessionId: "thread-1",
        cliKind: "codex",
        cwd: "/repo/worktree",
        sourceSessionId: "engine-1",
      },
    ]);
  });

  test("does not render the link before the job exposes an external session id", async () => {
    const container = await renderCard([{ ...job, externalSessionId: undefined }]);
    expect(cliLinkButton(container)).toBeUndefined();
  });
});
