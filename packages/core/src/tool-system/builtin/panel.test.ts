import { describe, expect, test } from "bun:test";
import { BUILTIN_AGENT_PRESETS } from "../../preset/index.js";
import type { ToolContext } from "../context.js";
import { AutoApprovalBackend, PermissionClassifier } from "../permission.js";
import { panelTool } from "./panel.js";

function context(panels?: ToolContext["panels"]): ToolContext {
  return { panels } as unknown as ToolContext;
}

function pngHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function jpegHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0]);
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  bytes[11] = 3;
  return bytes.toString("base64");
}

function gifHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes.toString("base64");
}

function webpHeader(width: number, height: number): string {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8X", 8, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString("base64");
}

describe("Panel tool", () => {
  test("allows discovery but asks before invoking Panel App Agent tools", () => {
    const permission = new PermissionClassifier(
      BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
      "default",
    );

    for (const action of ["list", "open", "tools"]) {
      expect(permission.classify("Panel", { action })).toBe("allow");
    }
    expect(permission.classify("Panel", { action: "invoke" })).toBe("ask");
  });

  test("does not auto-approve a Panel App invocation without an interactive delegate", async () => {
    const permission = new PermissionClassifier([], "auto", new AutoApprovalBackend());
    expect(
      await permission.handleAsk("Panel", {
        action: "invoke",
        panel_id: "panel-app:design-studio",
        tool_name: "use_design",
      }),
    ).toBe(false);
  });

  test("degrades outside an interactive panel host", async () => {
    expect(await panelTool({ action: "list" }, context())).toContain("not available");
  });

  test("reports a failed discovery as an error, never as an empty host", async () => {
    // "(no panels available)" / "has no Agent tools" are affirmative factual
    // claims. A request that never completed (user Stop, closed session, timeout)
    // must not be laundered into them — the model would conclude panel hosting is
    // unavailable and stop trying, which is worse than being told it was refused.
    const stopped = await panelTool(
      { action: "list" },
      context({
        list: async () => ({
          items: [],
          failed: "panel action cancelled because the turn was stopped",
        }),
        open: async (panelId) => ({ ok: true, panelId }),
      }),
    );
    expect(stopped).toContain("Error");
    expect(stopped).toContain("turn was stopped");
    expect(stopped).not.toContain("no panels available");

    const toolsStopped = await panelTool(
      { action: "tools", panel_id: "panel-app:design-studio" },
      context({
        list: async () => ({ items: [] }),
        open: async (panelId) => ({ ok: true, panelId }),
        tools: async () => ({ items: [], failed: "panel tools query timed out" }),
      }),
    );
    expect(toolsStopped).toContain("Error");
    expect(toolsStopped).toContain("timed out");
    expect(toolsStopped).not.toContain("has no Agent tools");
  });

  test("still reports a genuinely empty host as empty", async () => {
    // The flip side: absent `failed`, an empty list IS the truth and must keep
    // reading as such rather than becoming an error.
    expect(
      await panelTool(
        { action: "list" },
        context({
          list: async () => ({ items: [] }),
          open: async (panelId) => ({ ok: true, panelId }),
        }),
      ),
    ).toBe("(no panels available)");
  });

  test("lists host and Panel App ids", async () => {
    const result = await panelTool(
      { action: "list" },
      context({
        list: async () => ({
          items: [
            { id: "quickChat", title: "Quick chat", source: "builtin-panel-app" },
            {
              id: "panel-app:design-studio",
              title: "Build dashboard",
              source: "panel-app",
            },
          ],
        }),
        open: async (panelId) => ({ ok: true, panelId }),
      }),
    );
    expect(result).toContain("quickChat\tQuick chat\tbuiltin-panel-app");
    expect(result).toContain("panel-app:design-studio");
  });

  test("opens a stable panel id through the host bridge", async () => {
    const opened: string[] = [];
    const panels: NonNullable<ToolContext["panels"]> = {
      list: async () => ({ items: [] }),
      open: async (panelId) => {
        opened.push(panelId);
        return { ok: true, panelId };
      },
    };
    expect(await panelTool({ action: "open" }, context(panels))).toContain("panel_id is required");
    expect(await panelTool({ action: "open", panel_id: "quickChat" }, context(panels))).toBe(
      "Opened panel quickChat",
    );
    expect(opened).toEqual(["quickChat"]);
  });

  test("discovers and invokes a declared Panel App Agent tool", async () => {
    const calls: Array<{ panelId: string; toolName: string; args: Record<string, unknown> }> = [];
    const panels: NonNullable<ToolContext["panels"]> = {
      list: async () => ({ items: [] }),
      open: async (panelId) => ({ ok: true, panelId }),
      tools: async () => ({
        items: [
          {
            name: "get_design_context",
            description: "Read design context",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
          },
        ],
      }),
      invoke: async (panelId, toolName, args) => {
        calls.push({ panelId, toolName, args });
        return { ok: true, panelId, toolName, result: { nodeCount: 3 } };
      },
    };
    const listed = await panelTool(
      { action: "tools", panel_id: "panel-app:design-studio" },
      context(panels),
    );
    expect(listed).toContain("get_design_context");
    const invoked = await panelTool(
      {
        action: "invoke",
        panel_id: "panel-app:design-studio",
        tool_name: "get_design_context",
        arguments: { node_id: "hero" },
      },
      context(panels),
    );
    expect(invoked).toContain('"nodeCount": 3');
    expect(calls).toEqual([
      {
        panelId: "panel-app:design-studio",
        toolName: "get_design_context",
        args: { node_id: "hero" },
      },
    ]);
    expect(
      await panelTool(
        {
          action: "invoke",
          panel_id: "panel-app:design-studio",
          tool_name: "get_design_context",
          arguments: [],
        },
        context(panels),
      ),
    ).toBe("Error: arguments must be a JSON object for action='invoke'");
    expect(calls).toHaveLength(1);
  });

  test("fails closed on malformed descriptors and non-JSON or oversized results", async () => {
    const malformedDescriptors: NonNullable<ToolContext["panels"]> = {
      list: async () => ({ items: [] }),
      open: async (panelId) => ({ ok: true, panelId }),
      tools: async () => ({
        items: [
          {
            name: "unsafe",
            description: "Unsupported schema",
            inputSchema: { type: "object", properties: {}, format: "unknown" },
            readOnly: true,
          },
        ],
      }),
    };
    expect(
      await panelTool(
        { action: "tools", panel_id: "panel-app:unsafe" },
        context(malformedDescriptors),
      ),
    ).toBe("Error: panel host returned malformed Agent tool descriptors");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const result of [cyclic, { content: "x".repeat(600_000) }]) {
      expect(
        await panelTool(
          {
            action: "invoke",
            panel_id: "panel-app:unsafe",
            tool_name: "read",
          },
          context({
            list: async () => ({ items: [] }),
            open: async (panelId) => ({ ok: true, panelId }),
            invoke: async (panelId, toolName) => ({
              ok: true,
              panelId,
              toolName,
              result,
            }),
          }),
        ),
      ).toBe("Error: Panel App returned an oversized or non-JSON result");
    }
  });

  test("surfaces a validated Panel App screenshot as an image tool result", async () => {
    const data = pngHeader(1200, 720);
    const panels: NonNullable<ToolContext["panels"]> = {
      list: async () => ({ items: [] }),
      open: async (panelId) => ({ ok: true, panelId }),
      invoke: async (panelId, toolName) => ({
        ok: true,
        panelId,
        toolName,
        result: {
          kind: "image",
          mediaType: "image/png",
          data,
          width: 1200,
          height: 720,
          nodeId: "hero",
          pageId: "desktop",
          pageName: "Desktop",
          stateRevision: "design-state-3-14",
          summary: "Design preview",
          untrusted: "not forwarded",
        },
      }),
    };
    const result = await panelTool(
      {
        action: "invoke",
        panel_id: "panel-app:design-studio",
        tool_name: "get_design_screenshot",
      },
      context(panels),
    );
    expect(result).toMatchObject({
      contentBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        },
      ],
    });
    expect(typeof result === "object" ? result.result : "").toContain("Design preview");
    expect(typeof result === "object" ? result.result : "").toContain('"nodeId": "hero"');
    expect(typeof result === "object" ? result.result : "").toContain('"pageId": "desktop"');
    expect(typeof result === "object" ? result.result : "").toContain('"pageName": "Desktop"');
    expect(typeof result === "object" ? result.result : "").toContain(
      '"stateRevision": "design-state-3-14"',
    );
    expect(typeof result === "object" ? result.result : "").not.toContain("not forwarded");
  });

  test("derives bounded dimensions from PNG, JPEG, GIF, and WebP headers", async () => {
    for (const [mediaType, data] of [
      ["image/png", pngHeader(3, 2)],
      ["image/jpeg", jpegHeader(3, 2)],
      ["image/gif", gifHeader(3, 2)],
      ["image/webp", webpHeader(3, 2)],
    ]) {
      const result = await panelTool(
        {
          action: "invoke",
          panel_id: "panel-app:image",
          tool_name: "render",
        },
        context({
          list: async () => ({ items: [] }),
          open: async (panelId) => ({ ok: true, panelId }),
          invoke: async (panelId, toolName) => ({
            ok: true,
            panelId,
            toolName,
            result: { kind: "image", mediaType, data },
          }),
        }),
      );
      expect(typeof result).toBe("object");
      expect(typeof result === "object" ? result.result : "").toContain('"width": 3');
      expect(typeof result === "object" ? result.result : "").toContain('"height": 2');
    }
  });

  test("rejects oversized image dimensions and false dimension metadata", async () => {
    for (const payload of [
      {
        kind: "image",
        mediaType: "image/png",
        data: pngHeader(16_384, 16_384),
      },
      {
        kind: "image",
        mediaType: "image/png",
        data: pngHeader(3, 2),
        width: 4,
        height: 2,
      },
    ]) {
      const result = await panelTool(
        {
          action: "invoke",
          panel_id: "panel-app:image",
          tool_name: "render",
        },
        context({
          list: async () => ({ items: [] }),
          open: async (panelId) => ({ ok: true, panelId }),
          invoke: async (panelId, toolName) => ({
            ok: true,
            panelId,
            toolName,
            result: payload,
          }),
        }),
      );
      expect(result).toBe("Error: Panel App returned an invalid image result");
    }
  });

  test("rejects malformed image envelopes without echoing their payload", async () => {
    const panels: NonNullable<ToolContext["panels"]> = {
      list: async () => ({ items: [] }),
      open: async (panelId) => ({ ok: true, panelId }),
      invoke: async (panelId, toolName) => ({
        ok: true,
        panelId,
        toolName,
        result: {
          kind: "image",
          mediaType: "image/png",
          data: "QUJD",
        },
      }),
    };

    const result = await panelTool(
      {
        action: "invoke",
        panel_id: "panel-app:design-studio",
        tool_name: "get_design_screenshot",
      },
      context(panels),
    );
    expect(result).toBe("Error: Panel App returned an invalid image result");
    expect(result).not.toContain("QUJD");
  });
});
