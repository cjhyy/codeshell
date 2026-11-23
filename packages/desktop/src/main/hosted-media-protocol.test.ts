import { describe, expect, test } from "bun:test";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { NativeMediaProtocol } from "./hosted-media-protocol.js";

const url = "csmedia://preview/" + "a".repeat(64);
const preview = { url, kind: "audio", name: "sound.wav", mimeType: "audio/wav" };
const input = { sessionId: "recording", path: "sound.wav" };

describe("native media protocol", () => {
  test("reassignment during a pending byte read revokes the old URL permanently", async () => {
    const started = Promise.withResolvers<void>();
    const chunk = Promise.withResolvers<Uint8Array>();
    const methods: string[] = [];
    let owner = 4;
    const call = async (method: string) => {
      methods.push(method);
      if (method === "media/create") return preview;
      if (method === "media/open")
        return { status: 206, headers: { "content-range": "bytes 0-2/3" }, body: true };
      if (method === "media/pull") {
        started.resolve();
        return chunk.promise;
      }
    };
    const protocol = new NativeMediaProtocol(call as CallShellBusiness, (id) => id === owner);
    const doc = new AbortController();
    expect(await protocol.create(4, input, doc.signal)).toEqual(preview);
    const response = await protocol.respond(new Request(url, { headers: { range: "bytes=0-2" } }));
    expect(response.status).toBe(206);
    const read = response.arrayBuffer();
    await started.promise;
    owner = 5;
    chunk.resolve(Uint8Array.from([7, 8, 9]));
    await expect(read).rejects.toThrow();
    owner = 4;
    expect((await protocol.respond(new Request(url))).status).toBe(404);
    expect(methods).toContain("media/release");
    expect(methods).toContain("media/cancel");
  });

  test("session cleanup during create drops the late capability and closes its Host grant", async () => {
    const opened = Promise.withResolvers<typeof preview>();
    const methods: string[] = [];
    const call = async (method: string) => {
      methods.push(method);
      if (method === "media/create") return opened.promise;
    };
    const protocol = new NativeMediaProtocol(call as CallShellBusiness, () => true);
    const pending = protocol.create(4, input, new AbortController().signal);
    protocol.releaseSession(input.sessionId);
    opened.resolve(preview);
    expect(await pending).toBeNull();
    expect((await protocol.respond(new Request(url))).status).toBe(404);
    expect(methods).toEqual(["media/create", "media/releaseSession", "media/release"]);
  });
});
