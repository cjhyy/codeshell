import { describe, expect, it } from "bun:test";
import { buildSummarizeFn } from "./auxiliary-pipeline.js";

describe("Engine compaction summarizer abort propagation", () => {
  it("passes ContextManager's AbortSignal to the billed LLM request", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = {
      createMessage: async (options: { signal?: AbortSignal }) => {
        receivedSignal = options.signal;
        return { text: "summary", toolCalls: [], stopReason: "stop" };
      },
    };
    const summarize = buildSummarizeFn(client as never);

    await summarize("conversation", controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });
});
