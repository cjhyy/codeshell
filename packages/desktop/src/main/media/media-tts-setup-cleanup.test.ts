import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseManagedTtsSetupResources } from "./media-tts-setup-cleanup.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resources() {
  const root = await mkdtemp(join(tmpdir(), "codeshell-tts-cleanup-"));
  roots.push(root);
  const lockPath = join(root, "setup.lock");
  const sample = join(root, "validation.wav");
  await Promise.all([writeFile(lockPath, "owned lock"), writeFile(sample, "temporary sample")]);
  const closeFailure = Object.assign(new Error("EBADF: bad file descriptor, close"), {
    code: "EBADF",
  });
  return {
    lockPath,
    sample,
    closeFailure,
    lock: {
      close: async () => {
        throw closeFailure;
      },
    },
  };
}

test("a failed lock close preserves the primary setup failure and still removes all owned paths", async () => {
  const { lock, lockPath, sample, closeFailure } = await resources();
  const prerequisite = new Error("Missing FFmpeg");
  const primary = new Error("Kokoro 准备失败", { cause: prerequisite });
  const operation = async () => {
    try {
      throw primary;
    } finally {
      await releaseManagedTtsSetupResources(lock, lockPath, sample, primary);
    }
  };
  await expect(operation()).rejects.toBe(primary);
  await expect(access(lockPath)).rejects.toThrow();
  await expect(access(sample)).rejects.toThrow();
  expect(primary.cause).toBeInstanceOf(AggregateError);
  expect((primary.cause as AggregateError).errors).toEqual([prerequisite, closeFailure]);
});

test("a successful setup still reports cleanup failure after removing every owned path", async () => {
  const { lock, lockPath, sample, closeFailure } = await resources();
  const failure = await releaseManagedTtsSetupResources(lock, lockPath, sample).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([closeFailure]);
  await expect(access(lockPath)).rejects.toThrow();
  await expect(access(sample)).rejects.toThrow();
});

test("a failed close preserves cancellation identity and name", async () => {
  const { lock, lockPath, sample, closeFailure } = await resources();
  const aborted = Object.assign(new Error("Media processing was cancelled"), {
    name: "AbortError",
  });
  const operation = async () => {
    try {
      throw aborted;
    } finally {
      await releaseManagedTtsSetupResources(lock, lockPath, sample, aborted);
    }
  };
  await expect(operation()).rejects.toBe(aborted);
  expect(aborted.name).toBe("AbortError");
  expect((aborted.cause as AggregateError).errors).toEqual([closeFailure]);
  await expect(access(lockPath)).rejects.toThrow();
  await expect(access(sample)).rejects.toThrow();
});

test("a setup that never acquired its lock cannot remove another owner's lock file", async () => {
  const { lockPath, sample } = await resources();
  await releaseManagedTtsSetupResources(undefined, lockPath, sample);
  await expect(readFile(lockPath, "utf8")).resolves.toBe("owned lock");
  await expect(access(sample)).rejects.toThrow();
});
