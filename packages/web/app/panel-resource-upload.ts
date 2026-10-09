/** Retain one upload identity across explicit retries; the caller fixes its project/grant. */
export function createPanelResourceUpload(options: {
  blob: Blob;
  name: string;
  signal: AbortSignal;
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onProgress: (receivedBytes: number) => void;
  maxBytes: number;
  mimeTypes: readonly string[];
  transferBudget?: { rateWindowMs: number; maxTransferCallsPerWindow: number };
  timing?: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> };
}) {
  // Resource MIME metadata excludes encoder parameters; preserve the exact recorded bytes.
  const blob = new Blob([options.blob], {
    type: options.blob.type.split(";")[0]!.trim().toLowerCase(),
  });
  const writes: number[] = [];
  const now = options.timing?.now ?? Date.now;
  const sleep =
    options.timing?.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }));
  const pace = async () => {
    const budget = options.transferBudget;
    if (
      !budget ||
      !Number.isSafeInteger(budget.rateWindowMs) ||
      budget.rateWindowMs < 1 ||
      !Number.isSafeInteger(budget.maxTransferCallsPerWindow) ||
      budget.maxTransferCallsPerWindow < 1
    )
      return;
    while (true) {
      options.signal.throwIfAborted();
      const time = now();
      while (writes.length && writes[0]! <= time - budget.rateWindowMs) writes.shift();
      if (writes.length < budget.maxTransferCallsPerWindow) {
        writes.push(time);
        return;
      }
      await sleep(Math.max(1, writes[0]! + budget.rateWindowMs - time), options.signal);
    }
  };
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
      data.mimeType !== blob.type ||
      !["uploading", "finished"].includes(String(data.state)) ||
      !Number.isSafeInteger(data.receivedBytes) ||
      Number(data.receivedBytes) < 0 ||
      Number(data.receivedBytes) > blob.size ||
      !Number.isSafeInteger(data.nextSequence) ||
      Number(data.nextSequence) < 0 ||
      !Number.isSafeInteger(data.maxChunkBytes) ||
      Number(data.maxChunkBytes) < 1 ||
      Number(data.maxChunkBytes) > 32768
    )
      throw new Error("文件上传状态无效，请保留本机备份后重新打开面板。");
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
      if (saving) throw new Error("文件正在保存，请稍候。");
      if (!blob.size || blob.size > options.maxBytes || !options.mimeTypes.includes(blob.type))
        throw new Error("文件格式或大小无效。");
      saving = true;
      try {
        if (!digest) {
          const bytes = await blob.arrayBuffer();
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
                mimeType: blob.type,
                expectedBytes: blob.size,
                expectedSha256: digest,
              }),
        );
        sessionId = current.sessionId;
        options.onProgress(current.receivedBytes);
        while (current.receivedBytes < blob.size) {
          if (current.state !== "uploading") throw new Error("文件上传已结束，文件大小不匹配。");
          const offset = current.receivedBytes;
          const bytes = new Uint8Array(
            await blob.slice(offset, offset + current.maxChunkBytes).arrayBuffer(),
          );
          check();
          // A lost write reply is resolved on the next explicit save through get;
          // never restart an existing upload or guess whether its chunk committed.
          await pace();
          check();
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
            throw new Error("文件上传进度不匹配，请重试保存以核对服务端状态。");
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
          result.asset.bytes !== blob.size ||
          result.asset.mimeType !== blob.type
        )
          throw new Error("文件保存回执不匹配，请保留本机备份并重试。");
        return result;
      } finally {
        saving = false;
      }
    },
  };
}
