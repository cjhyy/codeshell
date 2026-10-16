import { expect, test } from "bun:test";
import { linkConnectionMetadata, resolveLinkRecipeId } from "./recipes.js";

test.each([
  ["api-token", "http-token", "local", "manual-token"],
  ["api-oauth", "http-token", "local", "browser-oauth"],
  ["cli-session", "cli", "local", "cli-session"],
  ["broker-oauth", "remote", "server", undefined],
  ["mcp-oauth", "mcp", "local", "mcp-oauth"],
] as const)(
  "recipe %s derives routing without mutating its stored record",
  (id, backend, runtime, authSource) => {
    const stored = Object.freeze({
      recordSchemaVersion: 2,
      linkRecipeId: id,
      linkProvider: "fixture",
    });
    expect(linkConnectionMetadata(stored)).toMatchObject({
      linkProvider: "fixture",
      linkExecutionBackend: backend,
      linkExecutionRuntime: runtime,
      linkAuthSource: authSource,
    });
    expect(Object.keys(stored)).toEqual(["recordSchemaVersion", "linkRecipeId", "linkProvider"]);
  },
);

test("explicit recipes override stale axes; unsupported recipes never borrow legacy authority", () => {
  expect(
    linkConnectionMetadata({
      recordSchemaVersion: 2,
      linkRecipeId: "broker-oauth",
      linkExecutionBackend: "http-token",
      linkExecutionRuntime: "local",
    }),
  ).toMatchObject({ linkExecutionBackend: "remote", linkExecutionRuntime: "server" });
  for (const linkRecipeId of ["unreviewed", undefined]) {
    const input = {
      recordSchemaVersion: 2,
      linkRecipeId,
      linkExecutionBackend: "remote" as const,
      linkExecutionRuntime: "server" as const,
    };
    expect(resolveLinkRecipeId(input)).toBeUndefined();
    expect(linkConnectionMetadata(input).linkExecutionBackend).toBeUndefined();
    expect(linkConnectionMetadata(input).linkExecutionRuntime).toBeUndefined();
  }
});

test("legacy github-cli resolves to CLI session without upgrading incomplete records", () => {
  expect(resolveLinkRecipeId({ linkAuthSource: "github-cli" })).toBe("cli-session");
  expect(linkConnectionMetadata({ linkAuthSource: "github-cli" }).linkAuthSource).toBe(
    "cli-session",
  );
  expect(
    linkConnectionMetadata({ linkExecutionBackend: "http-token" }).linkExecutionRuntime,
  ).toBeUndefined();
});

test("future record schemas cannot borrow the current recipe or legacy routing", () => {
  const input = {
    recordSchemaVersion: 3,
    linkRecipeId: "broker-oauth",
    linkExecutionBackend: "remote" as const,
  };
  expect(resolveLinkRecipeId(input)).toBeUndefined();
  expect(linkConnectionMetadata(input).linkExecutionBackend).toBeUndefined();
});
