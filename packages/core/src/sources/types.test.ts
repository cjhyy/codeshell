import { describe, expect, test } from "bun:test";
import { SourceDefinitionSchema, WorkspaceSourceBindingSchema } from "./types.js";

describe("source schemas", () => {
  test("accepts a full mcp-resource definition", () => {
    const d = SourceDefinitionSchema.parse({
      id: "github-work",
      kind: "mcp-resource",
      label: "GitHub（工作）",
      adapterConfig: { server: "github" },
      credentialRef: "cred-123",
      enabled: true,
    });
    expect(d.enabled).toBe(true);
  });

  test("fills defaults: enabled=true, adapterConfig={}", () => {
    const d = SourceDefinitionSchema.parse({ id: "m1", kind: "mock", label: "Mock" });
    expect(d.enabled).toBe(true);
    expect(d.adapterConfig).toEqual({});
  });

  test("rejects unknown kind and illegal id", () => {
    expect(() => SourceDefinitionSchema.parse({ id: "x", kind: "figma", label: "X" })).toThrow();
    expect(() => SourceDefinitionSchema.parse({ id: "../e", kind: "mock", label: "X" })).toThrow();
    expect(() => SourceDefinitionSchema.parse({ id: "UP", kind: "mock", label: "X" })).toThrow();
  });

  test("binding requires sourceId + scopes; readPolicy defaults to ask and only allows ask|deny", () => {
    const b = WorkspaceSourceBindingSchema.parse({ sourceId: "github-work", scopes: ["issues"] });
    expect(b.readPolicy).toBe("ask");
    expect(() =>
      WorkspaceSourceBindingSchema.parse({ sourceId: "x", scopes: [], readPolicy: "allow" }),
    ).toThrow();
  });
});
