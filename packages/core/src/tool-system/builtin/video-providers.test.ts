/**
 * 7.1 (块3) — VideoProvider 适配器接口(submit / poll / download 三段式)。
 *
 * Video generation is inherently long-running and asynchronous: you submit a
 * job, poll its status until done, then download the bytes. The interface
 * captures exactly those three steps so concrete adapters (Seedance/Kling,
 * filled in later once their private API docs are available) and the
 * GenerateVideo tool's background polling loop share one contract.
 */
import { describe, test, expect } from "bun:test";
import { FakeVideoProvider, getVideoProvider } from "./video-providers.js";

describe("VideoProvider contract (FakeVideoProvider)", () => {
  test("submit returns a jobId; poll reports running then succeeded; download returns bytes", async () => {
    const creds = { baseUrl: "https://x", apiKey: "k" };
    // succeedAfterPolls: 1 → first poll running, second succeeded.
    const p = new FakeVideoProvider({ succeedAfterPolls: 1, bytes: "VIDEO_BYTES" });

    const submit = await p.submit({ prompt: "a wave", model: "fake-1", creds });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    expect(typeof submit.jobId).toBe("string");

    const poll1 = await p.poll({ jobId: submit.jobId, creds });
    expect(poll1.ok && poll1.status).toBe("running");

    const poll2 = await p.poll({ jobId: submit.jobId, creds });
    expect(poll2.ok && poll2.status).toBe("succeeded");

    const dl = await p.download({ jobId: submit.jobId, creds });
    expect(dl.ok).toBe(true);
    if (dl.ok) expect(Buffer.from(dl.bytes).toString()).toBe("VIDEO_BYTES");
  });

  test("a failed job surfaces status=failed with a message", async () => {
    const p = new FakeVideoProvider({ failAfterPolls: 0, failMessage: "content policy" });
    const submit = await p.submit({ prompt: "p", model: "m", creds: { baseUrl: "x", apiKey: "k" } });
    if (!submit.ok) throw new Error("submit failed");
    const poll = await p.poll({ jobId: submit.jobId, creds: { baseUrl: "x", apiKey: "k" } });
    expect(poll.ok && poll.status).toBe("failed");
    if (poll.ok && poll.status === "failed") expect(poll.error).toContain("content policy");
  });
});

describe("registry", () => {
  test("getVideoProvider returns null for unknown kind (no real adapters yet)", () => {
    expect(getVideoProvider("seedance")).toBeNull();
    expect(getVideoProvider("kling")).toBeNull();
  });
  test("getVideoProvider('fake') returns the fake (test/dev) adapter", () => {
    expect(getVideoProvider("fake")?.kind).toBe("fake");
  });
});
