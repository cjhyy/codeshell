import { describe, expect, test } from "bun:test";
import type { IpcMain, WebContents } from "electron";
import {
  PANEL_ACCESS_RESPONSE_CHANNEL,
  PanelAccessRequests,
  registerPanelAccessResponses,
  type PanelAccessPrompt,
} from "./panel-access-request.js";

function harness(options: { panel?: boolean; timeoutMs?: number; shows?: boolean } = {}) {
  let granted = false;
  const prompts: PanelAccessPrompt[] = [];
  const requests = new PanelAccessRequests({
    status: (sessionId) =>
      granted
        ? { granted: true, sessionId, guestId: 7, url: "https://example.com/", title: "Example" }
        : { granted: false, sessionId },
    panelFor: () =>
      options.panel === false
        ? null
        : { windowId: 3, url: "https://example.com/", title: "Example" },
    show: (_windowId, prompt) => {
      prompts.push(prompt);
      return options.shows ?? true;
    },
    now: () => 1_000,
    timeoutMs: options.timeoutMs ?? 5_000,
  });
  const allow = () => {
    granted = true;
    requests.respond(prompts.at(-1)!.requestId, true, 3);
  };
  const deny = () => requests.respond(prompts.at(-1)!.requestId, false, 3);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { requests, prompts, allow, deny, settle, grant: () => (granted = true) };
}

const parse = async (pending: Promise<string>) =>
  JSON.parse(await pending) as { ok: boolean; code: string; detail: string };

describe("PanelAccessRequests", () => {
  test("the user's Allow in the panel grants the tab the agent asked for", async () => {
    const h = harness();
    const pending = h.requests.request("s1");
    await h.settle();
    expect(h.prompts).toEqual([
      {
        requestId: expect.any(String),
        sessionId: "s1",
        url: "https://example.com/",
        title: "Example",
        expiresAt: 6_000,
      },
    ]);
    h.allow();
    const result = await parse(pending);
    expect(result).toMatchObject({ ok: true, code: "OK" });
    expect(result.detail).toContain("Example");
  });

  test("an Allow that did not actually grant the tab is not reported as granted", async () => {
    const h = harness();
    const pending = h.requests.request("s1");
    await h.settle();
    h.requests.respond(h.prompts[0]!.requestId, true, 3);
    expect(await parse(pending)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
  });

  test("a decline is not re-prompted until the user's next request", async () => {
    const h = harness();
    const first = h.requests.request("s1");
    await h.settle();
    h.deny();
    expect(await parse(first)).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });

    const again = await parse(h.requests.request("s1"));
    expect(again.detail).toContain("already declined");
    expect(h.prompts).toHaveLength(1);

    h.requests.beginRun("s1");
    const next = h.requests.request("s1");
    await h.settle();
    expect(h.prompts).toHaveLength(2);
    h.allow();
    expect(await parse(next)).toMatchObject({ ok: true });
  });

  test("an unanswered prompt expires as a decline", async () => {
    const h = harness({ timeoutMs: 5 });
    expect(await parse(h.requests.request("s1"))).toMatchObject({ code: "NEEDS_HUMAN" });
    expect((await parse(h.requests.request("s1"))).detail).toContain("already declined");
    expect(h.prompts).toHaveLength(1);
  });

  test("no mounted panel tab means no prompt and no task-window substitute", async () => {
    const h = harness({ panel: false });
    const result = await parse(h.requests.request("s1"));
    expect(result).toMatchObject({ ok: false, code: "NEEDS_HUMAN" });
    expect(result.detail).toContain("No BrowserPanel tab is open");
    expect(h.prompts).toEqual([]);
  });

  test("an existing grant answers immediately", async () => {
    const h = harness();
    h.grant();
    expect(await parse(h.requests.request("s1"))).toMatchObject({ ok: true });
    expect(h.prompts).toEqual([]);
  });

  test("only the window that was asked can answer, and concurrent asks share one prompt", async () => {
    const h = harness();
    const a = h.requests.request("s1");
    const b = h.requests.request("s1");
    await h.settle();
    expect(h.prompts).toHaveLength(1);
    h.requests.respond(h.prompts[0]!.requestId, true, 99);
    h.allow();
    expect(await parse(a)).toMatchObject({ ok: true });
    expect(await parse(b)).toMatchObject({ ok: true });
  });

  test("a window that cannot show the prompt declines instead of waiting", async () => {
    const h = harness({ shows: false });
    expect(await parse(h.requests.request("s1"))).toMatchObject({ code: "NEEDS_HUMAN" });
  });

  test("forgetting a session releases its waiting request", async () => {
    const h = harness();
    const pending = h.requests.request("s1");
    await h.settle();
    h.requests.forgetSession("s1");
    expect(await parse(pending)).toMatchObject({ ok: false });
  });

  test("the IPC answer carries the sender's window, never a renderer-supplied one", () => {
    const answers: unknown[][] = [];
    let listener!: (event: { sender: WebContents }, payload: unknown) => void;
    registerPanelAccessResponses(
      {
        on: (channel: string, fn: typeof listener) => {
          expect(channel).toBe(PANEL_ACCESS_RESPONSE_CHANNEL);
          listener = fn;
        },
      } as unknown as Pick<IpcMain, "on">,
      () => 3,
      { respond: (...args) => answers.push(args) },
    );
    const sender = {} as WebContents;
    listener({ sender }, { requestId: "r1", granted: true, windowId: 99 });
    listener({ sender }, { requestId: "r2", granted: "yes" });
    expect(answers).toEqual([["r1", true, 3]]);
  });
});
