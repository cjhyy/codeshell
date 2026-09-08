import { expect, test } from "bun:test";
import { submitWorkbenchPanelPrompt } from "./Workbench.js";
import type { WorkbenchController } from "./workbench-types.js";

function fixture(patch: Partial<WorkbenchController> = {}) {
  const calls: string[] = [];
  const controller = {
    workspaceKey: "workspace-original",
    activeId: "session-original",
    connection: "open",
    chat: { run: "idle" },
    running: false,
    approvals: [],
    uncertain: false,
    uploading: false,
    uploadBusy: false,
    draft: "",
    files: [],
    hasUnsent: false,
    setDraft: (text: string) => calls.push(`draft:${text}`),
    send: () => {
      calls.push("send");
      return true;
    },
    ...patch,
  } as WorkbenchController;
  return { controller, calls };
}
const request = {
  workspaceKey: "workspace-original",
  sessionId: "session-original",
  prompt: "A confirmed panel task",
};

test("confirmed panel tasks set the synchronous draft store before sending", () => {
  const { controller, calls } = fixture();
  expect(submitWorkbenchPanelPrompt(controller, request)).toEqual({ accepted: true });
  expect(calls).toEqual(["draft:A confirmed panel task", "send"]);
});

test.each([
  ["other workspace", { workspaceKey: "workspace-later" }],
  ["other conversation", { activeId: "session-later" }],
  ["offline", { connection: "closed" }],
  ["loading", { loading: true }],
  ["read only", { readOnly: true }],
  ["running", { running: true }],
  ["approval pending", { approvals: [{ id: "approval", sessionId: "session-original" }] }],
  ["delivery uncertain", { uncertain: true }],
  ["uploading", { uploadBusy: true }],
  ["draft text", { draft: "My existing draft" }],
  ["whitespace draft", { draft: " " }],
  ["attachments", { files: [{ id: "attachment" }] }],
] as const)("%s blocks panel submission without changing the composer", (_label, patch) => {
  const { controller, calls } = fixture(patch as Partial<WorkbenchController>);
  expect(() => submitWorkbenchPanelPrompt(controller, request)).toThrow();
  expect(calls).toEqual([]);
});

test("drafts belonging to other conversations do not block an empty current composer", () => {
  const { controller, calls } = fixture({ hasUnsent: true });
  expect(submitWorkbenchPanelPrompt(controller, request)).toEqual({ accepted: true });
  expect(calls).toEqual(["draft:A confirmed panel task", "send"]);
});

test("a sender that declines its private guard clears only the newly inserted panel draft", () => {
  const { controller, calls } = fixture({ send: () => false });
  expect(() => submitWorkbenchPanelPrompt(controller, request)).toThrow("暂时无法接收任务");
  expect(calls).toEqual(["draft:A confirmed panel task", "draft:"]);
});
