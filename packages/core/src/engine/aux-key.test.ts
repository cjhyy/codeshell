import { describe, it, expect } from "bun:test";
import { resolveAuxKey } from "./aux-key.js";

describe("resolveAuxKey", () => {
  it("returns defaults.auxText when set", () => {
    expect(resolveAuxKey({ defaults: { auxText: "fast" } })).toBe("fast");
  });
  it("returns undefined when defaults.auxText unset (legacy auxModelKey no longer consulted)", () => {
    expect(resolveAuxKey({ auxModelKey: "legacy" } as never)).toBeUndefined();
  });
  it("treats empty string as unset", () => {
    expect(resolveAuxKey({ defaults: { auxText: "" } })).toBeUndefined();
  });
});
