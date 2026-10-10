import { describe, expect, test } from "bun:test";
import type { MaskedLinkConnection } from "@cjhyy/code-shell-link";
import {
  chatLinkReadArguments,
  composerLinkResources,
  figmaFileGranted,
} from "./linkResourceIntents";

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
    params: { file_url_or_key: resource.url },
  });
});
