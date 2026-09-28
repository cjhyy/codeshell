/** Retain one upload identity across explicit retries; the caller fixes its project/grant. */
export function createPanelAudioUpload(options: {
  blob: Blob;
  name: string;
  signal: AbortSignal;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onProgress: (receivedBytes: number) => void;
}) {
  let sessionId: string | undefined;
  let saving = false;
  let digest: string | undefined;
  const check = () => options.signal.throwIfAborted();
  const call = async (method: string, params: Record<string, unknown>) => {
    check();
    const result = await options.call(method, params);
    check();
    return result;
  };
  const session = (value: unknown) => {
    const data = value as Record<string, unknown> | undefined;
    if (
      !data ||
      typeof data.sessionId !== "string" ||
      !/^upload-[a-f0-9-]{36}$/.test(data.sessionId) ||
      (sessionId && sessionId !== data.sessionId) ||
      data.mimeType !== options.blob.type ||
      !["uploading", "finished"].includes(String(data.state)) ||
      !Number.isSafeInteger(data.receivedBytes) ||
      Number(data.receivedBytes) < 0 ||
      Number(data.receivedBytes) > options.blob.size ||
      !Number.isSafeInteger(data.nextSequence) ||
      Number(data.nextSequence) < 0 ||
      !Number.isSafeInteger(data.maxChunkBytes) ||
      Number(data.maxChunkBytes) < 1 ||
      Number(data.maxChunkBytes) > 32768
    )
      throw new Error("录音上传状态无效，请保留本机备份后重新打开面板。");
    return data as {
      sessionId: string;
      receivedBytes: number;
      nextSequence: number;
      maxChunkBytes: number;
      state: string;
    };
  };
  return {
    async save() {
      check();
      if (saving) throw new Error("录音正在保存，请稍候。");
      if (
        !options.blob.size ||
        options.blob.size > 25 * 1024 * 1024 ||
        !["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"].includes(options.blob.type)
      )
        throw new Error("录音格式或大小无效。");
      saving = true;
      try {
        if (!digest) {
          const bytes = await options.blob.arrayBuffer();
          check();
          digest = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          check();
        }
        let current = session(
          sessionId
            ? await call("resources.upload.get", { sessionId })
            : await call("resources.upload.begin", {
                name: options.name,
                mimeType: options.blob.type,
                expectedBytes: options.blob.size,
                expectedSha256: digest,
              }),
        );
        sessionId = current.sessionId;
        options.onProgress(current.receivedBytes);
        while (current.receivedBytes < options.blob.size) {
          if (current.state !== "uploading") throw new Error("录音上传已结束，文件大小不匹配。");
          const offset = current.receivedBytes;
          const bytes = new Uint8Array(
            await options.blob.slice(offset, offset + current.maxChunkBytes).arrayBuffer(),
          );
          check();
          // A lost write reply is resolved on the next explicit save through get;
          // never restart an existing upload or guess whether its chunk committed.
          const next = session(
            await call("resources.upload.write", {
              sessionId,
              sequence: current.nextSequence,
              offset,
              dataBase64: btoa(String.fromCharCode(...bytes)),
            }),
          );
          if (
            next.receivedBytes !== offset + bytes.length ||
            next.nextSequence !== current.nextSequence + 1
          )
            throw new Error("录音上传进度不匹配，请重试保存以核对服务端状态。");
          current = next;
          options.onProgress(current.receivedBytes);
        }
        // finish is idempotent, including after a committed reply was lost.
        const result = (await call("resources.upload.finish", { sessionId })) as {
          asset?: Record<string, unknown>;
        };
        if (
          !result?.asset ||
          result.asset.id !== `asset-${digest}` ||
          result.asset.bytes !== options.blob.size ||
          result.asset.mimeType !== options.blob.type
        )
          throw new Error("录音保存回执不匹配，请保留本机备份并重试。");
        return result;
      } finally {
        saving = false;
      }
    },
  };
}
