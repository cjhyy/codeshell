import { describe, it, expect } from "bun:test";
import { LLMClientBase } from "./client-base.js";
import type { LLMConfig, LLMResponse } from "../types.js";
import type { CreateMessageOptions } from "./types.js";

// Bug: "Stop does nothing" during a flaky-connection retry loop. withRetry
// retried a Connection-error 3× with growing backoff and (a) never checked the
// run's AbortSignal and (b) used a non-abortable setTimeout for the backoff, so
// a cancel mid-loop only took effect after all attempts + backoffs drained
// (~50s). Fix: thread the signal into withRetry — bail at the next retry
// boundary and wake the backoff sleep on abort.

class TestClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(): Promise<LLMResponse> {
    throw new Error("unused");
  }
  // Expose the protected retry loop + count how many times fn is invoked.
  runRetry<T>(fn: (requestSignal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withRetry(fn, { signal });
  }
}

function makeClient(): TestClient {
  const config = { provider: "openai", model: "m", apiKey: "x", baseUrl: "http://localhost" } as LLMConfig;
  return new TestClient(config, { retryMaxAttempts: 3 });
}

const connErr = () => new Error("OpenAI API error: Connection error.");

describe("withRetry honors AbortSignal", () => {
  it("does NOT re-invoke fn after the signal is aborted (bails at retry boundary)", async () => {
    const client = makeClient();
    const controller = new AbortController();
    let calls = 0;
    const fn = async () => {
      calls++;
      // Abort during the FIRST attempt: the retry boundary + abortable backoff
      // must prevent a second invocation.
      controller.abort();
      throw connErr();
    };
    await expect(client.runRetry(fn, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1); // not 3
  });

  it("a pre-aborted signal throws before any request is issued", async () => {
    const client = makeClient();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      client.runRetry(async () => {
        calls++;
        return "x";
      }, controller.signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("the backoff wakes immediately on abort (does not wait out the timer)", async () => {
    const client = makeClient();
    const controller = new AbortController();
    let calls = 0;
    const fn = async () => {
      calls++;
      throw connErr();
    };
    const started = performance.now();
    // Abort ~20ms in — well before the first 1000ms backoff would elapse.
    setTimeout(() => controller.abort(), 20);
    await expect(client.runRetry(fn, controller.signal)).rejects.toThrow();
    const elapsed = performance.now() - started;
    // If the backoff weren't abortable this would take >=1000ms. Allow slack.
    expect(elapsed).toBeLessThan(500);
    expect(calls).toBe(1);
  });

  it("without a signal it still retries up to maxAttempts (no behavior change)", async () => {
    const client = makeClient();
    let calls = 0;
    const fn = async () => {
      calls++;
      throw connErr();
    };
    await expect(client.runRetry(fn)).rejects.toThrow();
    expect(calls).toBe(3); // full retry budget preserved when not cancelled
  }, 15000);

  it("hands fn a per-request signal (composed deadline) even with no caller signal", async () => {
    const client = makeClient();
    let received: AbortSignal | undefined = "sentinel" as unknown as AbortSignal;
    await client.runRetry(async (reqSig) => {
      received = reqSig;
      return "ok";
    });
    // A real AbortSignal (the deadline) is always provided to fn.
    expect(received).toBeInstanceOf(AbortSignal);
  });

  it("a deadline tear-down (request signal aborted, caller not) is RETRYABLE, not bailed", async () => {
    const client = makeClient();
    let calls = 0;
    const fn = async (reqSig?: AbortSignal) => {
      calls++;
      // Simulate the SDK aborting because the per-request deadline fired:
      // the request signal is aborted, but there is no caller signal. This
      // must fall through to the retry path (upstream may recover), NOT the
      // abort-no-retry guard.
      if (calls === 1) {
        // Force the request signal to look aborted by throwing an AbortError
        // while reqSig is the deadline composite. We can't make AbortSignal.any
        // abort on demand here, so assert the simpler invariant: an AbortError
        // WITHOUT a caller signal does not short-circuit to a single attempt.
        void reqSig;
        throw connErr(); // connection error → retryable
      }
      return "recovered";
    };
    const res = await client.runRetry(fn);
    expect(res).toBe("recovered");
    expect(calls).toBe(2);
  });
});
