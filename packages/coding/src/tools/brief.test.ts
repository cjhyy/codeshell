import { describe, it, expect } from "bun:test";
import { briefTool } from "./brief.js";

describe("coding briefTool", () => {
  it("renders content with a title + status icon", async () => {
    expect(await briefTool({ title: "Done", content: "all good", status: "success" })).toBe(
      "✓ Done\n\nall good",
    );
  });

  it("defaults to the info icon when status is omitted", async () => {
    expect(await briefTool({ title: "Note", content: "x" })).toBe("ℹ Note\n\nx");
  });

  it("falls back to info for an unknown status", async () => {
    expect(await briefTool({ title: "T", content: "x", status: "bogus" })).toBe("ℹ T\n\nx");
  });

  it("returns bare content when no title", async () => {
    expect(await briefTool({ content: "just content" })).toBe("just content");
  });

  it("uses the warning / error icons", async () => {
    expect(await briefTool({ title: "W", content: "x", status: "warning" })).toContain("⚠ W");
    expect(await briefTool({ title: "E", content: "x", status: "error" })).toContain("✗ E");
  });
});
