import { describe, expect, test } from "bun:test";
import { SettingsSchema } from "./schema.js";

describe("settings sources bindings", () => {
  test("accepts an array of bindings", () => {
    const s = SettingsSchema.parse({
      sources: [{ sourceId: "github-work", scopes: ["issues", "pulls"] }],
    });
    expect(s.sources?.[0]?.readPolicy).toBe("ask");
  });

  test("absent stays undefined; invalid binding rejected", () => {
    expect(SettingsSchema.parse({}).sources).toBeUndefined();
    expect(() => SettingsSchema.parse({ sources: [{ scopes: [] }] })).toThrow();
  });
});
