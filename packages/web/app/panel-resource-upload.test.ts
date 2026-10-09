import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPanelResourceUpload } from "./panel-resource-upload.js";

function fixture(options: { lostFinish?: boolean; abortDuringWait?: boolean } = {}) {
  const bytes = "v".repeat(90000);
  const blob = new Blob([bytes], { type: "video/webm;codecs=vp8,opus" });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = { id: `asset-${digest}`, bytes: blob.size, mimeType: "video/webm" };
  const abort = new AbortController(),
    calls: string[] = [],
    waits: number[] = [],
    chunks: Buffer[] = [];
  const current = {
    sessionId: "upload-12345678-1234-1234-1234-1234567890ab",
    mimeType: "video/webm",
    receivedBytes: 0,
    nextSequence: 0,
    maxChunkBytes: 32768,
    state: "uploading",
  };
  let time = 0,
    lost = options.lostFinish;
  const upload = createPanelResourceUpload({
    blob,
    name: "recording.webm",
    signal: abort.signal,
    maxBytes: 200 * 1024 * 1024,
    mimeTypes: ["video/webm", "video/mp4"],
    transferBudget: { rateWindowMs: 1000, maxTransferCallsPerWindow: 2 },
    timing: {
      now: () => time,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
        if (options.abortDuringWait) abort.abort();
      },
    },
    onProgress() {},
    call: async (method, params) => {
      calls.push(method);
      if (method.endsWith("begin")) {
        expect(params.mimeType).toBe("video/webm");
        expect(params.expectedSha256).toBe(digest);
      }
      if (method.endsWith("write")) {
        expect(params.offset).toBe(current.receivedBytes);
        expect(params.sequence).toBe(current.nextSequence);
        const chunk = Buffer.from(params.dataBase64 as string, "base64");
        chunks.push(chunk);
        current.receivedBytes += chunk.length;
        current.nextSequence++;
      }
      if (method.endsWith("finish")) {
        current.state = "finished";
        if (lost) {
          lost = false;
          throw new Error("lost receipt");
        }
        return { asset };
      }
      return { ...current };
    },
  });
  return { upload, asset, calls, waits, chunks, bytes };
}
test("video preserves exact bytes, strips MIME codec parameters, and paces transfer calls", async () => {
  const f = fixture();
  expect(await f.upload.save()).toEqual({ asset: f.asset });
  expect(Buffer.concat(f.chunks).toString()).toBe(f.bytes);
  expect(f.waits).toEqual([1000]);
});
test("lost video finish resumes the same identity and idempotent receipt", async () => {
  const f = fixture({ lostFinish: true });
  await expect(f.upload.save()).rejects.toThrow("lost receipt");
  expect(await f.upload.save()).toEqual({ asset: f.asset });
  expect(f.calls.filter((method) => method.endsWith("begin"))).toHaveLength(1);
  expect(f.calls.slice(-2)).toEqual(["resources.upload.get", "resources.upload.finish"]);
});
test("revocation while waiting for the transfer budget dispatches no further bytes or finish", async () => {
  const f = fixture({ abortDuringWait: true });
  await expect(f.upload.save()).rejects.toThrow();
  expect(f.calls).toEqual([
    "resources.upload.begin",
    "resources.upload.write",
    "resources.upload.write",
  ]);
});
