import { describe, expect, test } from "bun:test";
import {
  boundedMcpResult,
  boundMcpHttpResponse,
  MAX_MCP_RESULT_BYTES,
  McpResponseTooLargeError,
} from "./mcp-results.js";

describe("MCP response budget", () => {
  test("cancels a pending body read and rejects authority changes while streaming", async () => {
    let cancelled = false;
    const source = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const response = boundMcpHttpResponse(
      new Response(source, { headers: { "Content-Type": "application/json" } }),
    );
    await Promise.resolve();
    await response.body!.cancel();
    expect(cancelled).toBe(true);
    let current = true;
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    });
    const result = boundMcpHttpResponse(
      new Response(stream, { headers: { "Content-Type": "application/json" } }),
      () => {
        if (!current) throw new Error("authority changed");
      },
    );
    const pending = result.text();
    await Promise.resolve();
    current = false;
    output.enqueue(new TextEncoder().encode("{}"));
    await expect(pending).rejects.toThrow("authority changed");
  });
  test("rejects a complete envelope rather than clipping structured or binary content", () => {
    const envelope = {
      content: [],
      structuredContent: { value: "x".repeat(MAX_MCP_RESULT_BYTES) },
    };
    expect(() => boundedMcpResult(envelope)).toThrow(McpResponseTooLargeError);
    const small = { contents: [{ uri: "test://blob", mimeType: "image/png", blob: "YWJj" }] };
    expect(boundedMcpResult(small)).toBe(small);
  });

  test("bounds JSON before parsing and cancels its upstream reader", async () => {
    let cancelled = false;
    const bytes = new TextEncoder().encode("x".repeat(MAX_MCP_RESULT_BYTES + 1));
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = boundMcpHttpResponse(
      new Response(source, { headers: { "Content-Type": "application/json; charset=utf-8" } }),
    );
    await expect(response.text()).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  test("counts SSE events across chunks and permits multiple bounded messages", async () => {
    const event = `data: ${"x".repeat(MAX_MCP_RESULT_BYTES / 2)}\r\n\r\n`;
    const response = boundMcpHttpResponse(
      new Response(event.repeat(3), { headers: { "Content-Type": "text/event-stream" } }),
    );
    expect((await response.text()).length).toBe(event.length * 3);
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${"x".repeat(MAX_MCP_RESULT_BYTES / 2)}`));
        controller.enqueue(encoder.encode("x".repeat(MAX_MCP_RESULT_BYTES / 2)));
        controller.close();
      },
    });
    await expect(
      boundMcpHttpResponse(
        new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
      ).text(),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
});
