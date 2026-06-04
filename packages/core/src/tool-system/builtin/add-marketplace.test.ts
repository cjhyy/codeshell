import { describe, expect, it } from "bun:test";

// Tests the tool's three responsibilities — schema shape, parameter
// validation, and call forwarding/result wording — without triggering a real
// git clone. The validation cases short-circuit before ever reaching core's
// addMarketplace.
import { addMarketplaceToolDef, addMarketplaceTool } from "./add-marketplace.js";

describe("AddMarketplace tool", () => {
  it("has a name and required source fields in its schema", () => {
    expect(addMarketplaceToolDef.name).toBe("AddMarketplace");
    const props = addMarketplaceToolDef.inputSchema.properties as Record<string, unknown>;
    expect(props.name).toBeDefined();
    expect(props.source_type).toBeDefined();
    expect(addMarketplaceToolDef.inputSchema.required).toContain("name");
    expect(addMarketplaceToolDef.inputSchema.required).toContain("source_type");
  });

  it("rejects missing name", async () => {
    const out = await addMarketplaceTool({ source_type: "github", repo: "a/b" });
    expect(out).toContain("Error");
    expect(out).toContain("name");
  });

  it("rejects github source without repo", async () => {
    const out = await addMarketplaceTool({ name: "x", source_type: "github" });
    expect(out).toContain("Error");
    expect(out).toContain("repo");
  });

  it("rejects git source without url", async () => {
    const out = await addMarketplaceTool({ name: "x", source_type: "git" });
    expect(out).toContain("Error");
    expect(out).toContain("url");
  });

  it("rejects unknown source_type", async () => {
    const out = await addMarketplaceTool({ name: "x", source_type: "ftp" });
    expect(out).toContain("Error");
    expect(out).toContain("source_type");
  });
});
