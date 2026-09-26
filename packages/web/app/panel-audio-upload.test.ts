import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPanelAudioUpload } from "./panel-audio-upload.js";

function fixture(lost: "write" | "finish" | "none" = "none") {
  const blob = new Blob(["a".repeat(40000)], { type: "audio/webm" });
  const digest = createHash("sha256").update("a".repeat(40000)).digest("hex");
  const abort = new AbortController(),
    methods: string[] = [],
    chunks: Uint8Array[] = [];
  let dropped = false;
  const current = {
    sessionId: "upload-12345678-1234-1234-1234-1234567890ab",
    mimeType: blob.type,
    receivedBytes: 0,
    nextSequence: 0,
    maxChunkBytes: 32768,
    state: "uploading",
  };
  let committed = false;
  const asset = { id: `asset-${digest}`, bytes: blob.size, mimeType: blob.type };
  const call = async (method: string, params: Record<string, unknown>) => {
    methods.push(method);
    if (method === "resources.upload.begin") {
      expect(params.expectedSha256).toBe(digest);
      expect(params.expectedBytes).toBe(blob.size);
    } else if (method === "resources.upload.write") {
      expect(params.sessionId).toBe(current.sessionId);
      expect(params.sequence).toBe(current.nextSequence);
      expect(params.offset).toBe(current.receivedBytes);
      const chunk = Buffer.from(params.dataBase64 as string, "base64");
      chunks.push(chunk);
      current.receivedBytes += chunk.length;
      current.nextSequence++;
      if (lost === "write" && !dropped) {
        dropped = true;
        throw new Error("Reply lost after commit");
      }
    } else if (method === "resources.upload.finish") {
      current.state = "finished";
      committed = true;
      if (lost === "finish" && !dropped) {
        dropped = true;
        throw new Error("Reply lost after commit");
      }
      return { asset };
    } else expect(method).toBe("resources.upload.get");
    return { ...current };
  };
  const transfer = createPanelAudioUpload({
    blob,
    name: "recording.webm",
    signal: abort.signal,
    call,
    onProgress() {},
  });
  return {
    transfer,
    abort,
    methods,
    chunks,
    asset,
    call,
    blob,
    current,
    committed: () => committed,
  };
}

test("lost chunk response resumes the same upload at committed offset only after explicit retry", async () => {
  const f = fixture("write");
  await expect(f.transfer.save()).rejects.toThrow("Reply lost");
  expect(f.methods).toEqual(["resources.upload.begin", "resources.upload.write"]);
  expect(f.committed()).toBe(false);
  expect(await f.transfer.save()).toEqual({ asset: f.asset });
  expect(f.methods).toEqual([
    "resources.upload.begin",
    "resources.upload.write",
    "resources.upload.get",
    "resources.upload.write",
    "resources.upload.finish",
  ]);
  expect(Buffer.concat(f.chunks).toString()).toBe("a".repeat(40000));
});

test("lost finish response reuses the finished upload without repeating chunks or opening another upload", async () => {
  const f = fixture("finish");
  await expect(f.transfer.save()).rejects.toThrow("Reply lost");
  expect(f.committed()).toBe(true);
  expect(await f.transfer.save()).toEqual({ asset: f.asset });
  expect(f.methods.filter((method) => method.endsWith("begin"))).toHaveLength(1);
  expect(f.methods.filter((method) => method.endsWith("write"))).toHaveLength(2);
  expect(f.methods.slice(-2)).toEqual(["resources.upload.get", "resources.upload.finish"]);
});

test("revoked project rejects save before creating a remote upload", async () => {
  const f = fixture();
  f.abort.abort();
  await expect(f.transfer.save()).rejects.toThrow();
  expect(f.methods).toEqual([]);
});

test("revocation during upload prevents the next chunk or publication", async () => {
  const f = fixture();
  const transfer = createPanelAudioUpload({
    blob: f.blob,
    name: "recording.webm",
    signal: f.abort.signal,
    call: async (method, params) => {
      const result = await f.call(method, params);
      if (method.endsWith("write")) f.abort.abort();
      return result;
    },
    onProgress() {},
  });
  await expect(transfer.save()).rejects.toThrow();
  expect(f.methods).toEqual(["resources.upload.begin", "resources.upload.write"]);
});

test("an unrelated resource receipt is never returned as the recorded audio", async () => {
  const f = fixture();
  const transfer = createPanelAudioUpload({
    blob: f.blob,
    name: "recording.webm",
    signal: f.abort.signal,
    call: async (method, params) => {
      const result = await f.call(method, params);
      return method.endsWith("finish")
        ? { asset: { ...f.asset, id: `asset-${"0".repeat(64)}` } }
        : result;
    },
    onProgress() {},
  });
  await expect(transfer.save()).rejects.toThrow("回执不匹配");
});
