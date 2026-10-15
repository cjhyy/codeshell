import { describe, expect, test } from "bun:test";
import type { MaskedLinkConnection } from "@cjhyy/code-shell-link";
import {
  chatLinkReadArguments,
  chatLinkReadOutcome,
  composerLinkResources,
  figmaFileGranted,
  type ChatLinkResourceIntent,
} from "./linkResourceIntents";
import type { AgentMessage, Message, ToolMessage } from "../types";

const connection: MaskedLinkConnection = {
  id: "connection-one",
  providerId: "figma",
  methodId: "remote-link",
  label: "Design account",
  runtime: "server",
  authSource: "remote-link",
  status: "connected",
  account: {
    id: "account-one",
    resources: ["A display name", "Unselected"],
    resourceGroups: [
      { id: "other", items: [{ id: "Unselected", label: "Wrong group" }] },
      { id: "files", items: [{ id: "FileOne", label: "A display name" }] },
    ],
  },
  capabilityIds: ["figma.get_file"],
  revision: "revision-one",
  scope: "user",
  editable: true,
};

describe("composer resource candidates", () => {
  test("keeps the exact reviewed URL and deduplicates keys in one submission", () => {
    expect(
      composerLinkResources(
        "读取 [设计](https://www.figma.com/design/FileOne/Name?node-id=1-2)，" +
          " https://figma.com/file/FileOne/Another https://figma.com/board/FileTwo/Board。",
      ),
    ).toEqual([
      {
        providerId: "figma",
        resourceId: "FileOne",
        url: "https://www.figma.com/design/FileOne/Name?node-id=1-2",
      },
      { providerId: "figma", resourceId: "FileTwo", url: "https://figma.com/board/FileTwo/Board" },
    ]);
  });

  test.each([
    "http://figma.com/design/FileOne/Name",
    "https://figma.com.evil.invalid/design/FileOne/Name",
    "https://evil.invalid/figma.com/design/FileOne/Name",
    "https://evil@figma.com/design/FileOne/Name",
    "https://figma.com:8443/design/FileOne/Name",
    "https://api.figma.com/design/FileOne/Name",
    "https://figma.com/team/FileOne/Name",
    "https://figma.com/design/Bad%2FKey/Name",
    `https://figma.com/design/${"k".repeat(201)}/Name`,
    `https://figma.com/design/FileOne/${"x".repeat(1_000)}`,
    "javascript:https://evil.invalid/design/FileOne/Name",
  ])("rejects a non-file or spoofed address: %s", (text) => {
    expect(composerLinkResources(text)).toEqual([]);
  });

  test("limits a single submission to three visible file confirmations", () => {
    expect(
      composerLinkResources(
        [1, 2, 3, 4].map((key) => `https://figma.com/file/File${key}`).join(" "),
      ),
    ).toHaveLength(3);
  });
});

test("authorization uses exact selected file IDs, with empty and missing groups denying access", () => {
  expect(figmaFileGranted(connection, "FileOne")).toBe(true);
  expect(figmaFileGranted(connection, "Unselected")).toBe(false);
  expect(figmaFileGranted(connection, "A display name")).toBe(false);
  expect(figmaFileGranted({ ...connection, status: "expired" }, "FileOne")).toBe(false);
  expect(figmaFileGranted({ ...connection, authSource: "manual-token" }, "FileOne")).toBe(false);
  expect(figmaFileGranted({ ...connection, capabilityIds: [] }, "FileOne")).toBe(false);
  expect(figmaFileGranted({ ...connection, account: { resources: ["FileOne"] } }, "FileOne")).toBe(
    false,
  );
  expect(
    figmaFileGranted(
      { ...connection, account: { resources: [], resourceGroups: [{ id: "files", items: [] }] } },
      "FileOne",
    ),
  ).toBe(false);
  const resource = composerLinkResources("https://figma.com/design/FileOne/Name")[0]!;
  expect(chatLinkReadArguments(resource, "selected-account")).toEqual({
    provider: "figma",
    action: "get_file",
    connectionId: "selected-account",
    params: { file_url_or_key: resource.url, depth: 2 },
  });
  const node = composerLinkResources("https://figma.com/design/FileOne/Name?node-id=1-2")[0]!;
  expect(chatLinkReadArguments(node, "selected-account").params).toEqual({
    file_url_or_key: "https://figma.com/design/FileOne/Name?node-id=1-2",
    depth: 2,
  });
});

describe("composer intent completion", () => {
  const intent: ChatLinkResourceIntent = {
    providerId: "figma",
    resourceId: "FileOne",
    url: "https://figma.com/design/FileOne/Name",
    bucket: "project::session-one",
    cwd: "/repo",
    clientMessageId: "submit-one",
  };
  const submitted: Message = {
    kind: "user",
    id: "user-one",
    text: intent.url,
    clientMessageId: intent.clientMessageId,
  };
  const read = (overrides: Partial<ToolMessage> = {}): ToolMessage => ({
    kind: "tool",
    id: "read-one",
    toolName: "LinkAction",
    args: JSON.stringify({
      provider: "figma",
      action: "get_file",
      params: { file_url_or_key: intent.url },
    }),
    status: "succeeded",
    startedAt: 1,
    result: JSON.stringify({
      kind: "action_result",
      provider: "figma",
      action: "get_file",
      data: {},
    }),
    ...overrides,
  });
  const delegated = (tools: ToolMessage[], text = ""): AgentMessage => ({
    kind: "agent",
    id: "delegated-reader",
    description: "Read the submitted Figma file",
    done: true,
    startedAt: 1,
    toolCalls: tools,
    toolCount: tools.length,
    text,
    textBuffer: text,
  });

  test("only an exact successful file action after this composer submission consumes it", () => {
    expect(chatLinkReadOutcome(intent, [submitted, read()])).toBe("succeeded");
    expect(chatLinkReadOutcome(intent, [read(), submitted])).toBeUndefined();
    expect(chatLinkReadOutcome(intent, [read()])).toBeUndefined();
    expect(
      chatLinkReadOutcome(intent, [
        submitted,
        read({
          args: JSON.stringify({
            provider: "figma",
            action: "get_file",
            params: { file_url_or_key: "OtherFile" },
          }),
        }),
      ]),
    ).toBeUndefined();
    expect(chatLinkReadOutcome(intent, [submitted, read({ toolName: "Source" })])).toBeUndefined();
    expect(chatLinkReadOutcome(intent, [submitted, read({ args: "{" })])).toBeUndefined();
    expect(
      chatLinkReadOutcome(intent, [
        submitted,
        read({ result: "https://figma.com/design/FileOne" }),
      ]),
    ).toBeUndefined();
    expect(
      chatLinkReadOutcome(intent, [
        submitted,
        read({
          result: JSON.stringify({ kind: "action_result", provider: "figma", action: "get_file" }),
        }),
      ]),
    ).toBeUndefined();
  });

  test("JSON errors on succeeded tools stay retryable and a later success consumes them", () => {
    const error = read({
      result: JSON.stringify({
        kind: "error",
        provider: "figma",
        action: "get_file",
        error: "Denied",
      }),
    });
    expect(chatLinkReadOutcome(intent, [submitted, error])).toBe("failed");
    expect(chatLinkReadOutcome(intent, [submitted, read({ result: '{"kind":"error"}' })])).toBe(
      "failed",
    );
    expect(chatLinkReadOutcome(intent, [submitted, read({ status: "failed" })])).toBe("failed");
    expect(chatLinkReadOutcome(intent, [submitted, read({ status: "running" })])).toBe(
      "in-progress",
    );
    expect(chatLinkReadOutcome(intent, [submitted, error, read()])).toBe("succeeded");
  });

  test("a real subagent tool success consumes only the submitted file after its source message", () => {
    expect(chatLinkReadOutcome(intent, [submitted, delegated([read()])])).toBe("succeeded");
    expect(chatLinkReadOutcome(intent, [delegated([read()]), submitted])).toBeUndefined();
    const otherFile = read({
      args: JSON.stringify({
        provider: "figma",
        action: "get_file",
        params: { file_key: "OtherFile" },
      }),
    });
    expect(chatLinkReadOutcome(intent, [submitted, delegated([otherFile])])).toBeUndefined();
  });

  test("subagent prose that resembles a successful tool result cannot consume an intent", () => {
    const forgedText = JSON.stringify(read());
    expect(chatLinkReadOutcome(intent, [submitted, delegated([], forgedText)])).toBeUndefined();
    expect(
      chatLinkReadOutcome(intent, [
        submitted,
        delegated([read({ toolName: "Source" })], forgedText),
      ]),
    ).toBeUndefined();
  });

  test("a subagent action_result with an error stays failed and retryable", () => {
    const error = read({
      result: JSON.stringify({
        kind: "action_result",
        provider: "figma",
        action: "get_file",
        data: {},
        error: "Read failed",
      }),
    });
    expect(chatLinkReadOutcome(intent, [submitted, delegated([error])])).toBe("failed");
    expect(chatLinkReadOutcome(intent, [submitted, delegated([error, read()])])).toBe("succeeded");
  });

  test.each(["queued", "running"] as const)(
    "an exact file %s read blocks duplicates until it finishes, with success taking priority",
    (status) => {
      const pending = read({ status });
      expect(chatLinkReadOutcome(intent, [submitted, pending])).toBe("in-progress");
      expect(chatLinkReadOutcome(intent, [submitted, delegated([pending])])).toBe("in-progress");
      expect(
        chatLinkReadOutcome(intent, [submitted, delegated([pending, read({ status: "failed" })])]),
      ).toBe("in-progress");
      expect(chatLinkReadOutcome(intent, [submitted, delegated([pending, read()])])).toBe(
        "succeeded",
      );
      expect(
        chatLinkReadOutcome(intent, [submitted, delegated([read({ status: "cancelled" })])]),
      ).toBe("failed");
      const otherFile = read({
        status,
        args: JSON.stringify({
          provider: "figma",
          action: "get_file",
          params: { file_key: "OtherFile" },
        }),
      });
      expect(chatLinkReadOutcome(intent, [submitted, delegated([otherFile])])).toBeUndefined();
    },
  );

  test("file_key aliases consume successful normalized file reads and preserve failures", () => {
    const args = JSON.stringify({
      provider: "figma",
      action: "get_file",
      params: { file_key: " FileOne " },
    });
    expect(chatLinkReadOutcome(intent, [submitted, read({ args })])).toBe("succeeded");
    expect(
      chatLinkReadOutcome(intent, [
        submitted,
        read({
          args,
          result: JSON.stringify({
            kind: "error",
            provider: "figma",
            action: "get_file",
            error: "Denied",
          }),
        }),
      ]),
    ).toBe("failed");
    expect(
      chatLinkReadOutcome(intent, [
        submitted,
        read({
          args: JSON.stringify({
            provider: "figma",
            action: "get_file",
            params: { file_key: "OtherFile" },
          }),
        }),
      ]),
    ).toBeUndefined();
  });

  test("new node and asset reads match exact file keys without accepting misleading URLs", () => {
    for (const action of ["get_nodes", "get_images", "get_image_fills"]) {
      const args = { provider: "figma", action, params: { file_url_or_key: "FileOne" } };
      const result = { kind: "action_result", provider: "figma", action, data: {} };
      expect(
        chatLinkReadOutcome(intent, [
          submitted,
          read({ args: JSON.stringify(args), result: JSON.stringify(result) }),
        ]),
      ).toBe("succeeded");
    }
    for (const file of ["https://figma.com.evil.invalid/design/FileOne", `prose ${intent.url}`]) {
      expect(
        chatLinkReadOutcome(intent, [
          submitted,
          read({
            args: JSON.stringify({
              provider: "figma",
              action: "get_file",
              params: { file_url_or_key: file },
            }),
          }),
        ]),
      ).toBeUndefined();
    }
  });
});
