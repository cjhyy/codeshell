import { expect, test } from "bun:test";
import { businessRead, noBusinessArguments } from "./business-read.js";
import { InvalidParams } from "./server.js";

test("empty configuration reads accept only an omitted or empty parameter object", () => {
  for (const value of [undefined, {}, Object.create(null)])
    expect(noBusinessArguments(value)).toEqual({});
  for (const value of [null, [], true, "cwd", { workspace: "/tmp" }, new Date()])
    expect(() => noBusinessArguments(value)).toThrow(InvalidParams);
});

test("a configuration read supplies its validated parameters and captured caller", () => {
  const ctx = {
    identity: {
      webContentsId: 12,
      frameToken: "doc",
      frameGeneration: 1,
      windowKind: "workbench" as const,
    },
    assertCurrent: () => {},
  };
  const [name, handler] = businessRead(
    "models/catalogOrigins",
    noBusinessArguments,
    (params, caller) => {
      expect(params).toEqual({});
      expect(caller).toBe(ctx);
      return {};
    },
  );
  expect(name).toBe("models/catalogOrigins");
  expect(handler.run(ctx, {})).toEqual({});
});

test("registered configuration reads validate their own scope before resolving resources", async () => {
  const { configurationReads } = await import("./configuration-reads.js");
  const methods = new Map(configurationReads);
  const ctx = {
    identity: {
      webContentsId: 12,
      frameToken: "doc",
      frameGeneration: 1,
      windowKind: "workbench" as const,
    },
    assertCurrent() {},
  };
  for (const [name, params] of [
    ["projects/list", { includeDeleted: true }],
    ["settings/user", { scope: "project" }],
    ["sources/projectAccess", { projectId: "one", cwd: "/tmp" }],
    ["plugins/media", { installKey: "known", includeScreenshots: "yes" }],
    ["projects/trust", { path: "" }],
  ] as const)
    expect(() => methods.get(name)?.run(ctx, params)).toThrow(InvalidParams);
});
