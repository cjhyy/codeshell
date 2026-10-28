// Synthetic implementations of the legacy resident Claude and Codex exec protocols.
import { createInterface } from "node:readline";
export async function runLegacyCli(kind, send, record) {
  const args = process.argv;
  const finish = async () => {
    if (kind === "claude-code") {
      await send({
        type: "assistant",
        message: { content: [{ type: "text", text: "legacy synthetic reply" }] },
      });
      await send({ type: "result", subtype: "success" });
    } else {
      await send({
        type: "item.completed",
        item: { type: "agent_message", text: "legacy synthetic reply" },
      });
      await send({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    }
  };
  const received = (text) => {
    record("legacy-physical-turn", {
      resumed: args.includes("--resume") || args.includes("resume"),
      mode: args[args.indexOf(kind === "codex" ? "--sandbox" : "--permission-mode") + 1],
    });
    if (text.includes("legacy-hold")) {
      record("legacy-held");
      return "hold";
    }
    if (text.includes("legacy-approval")) return "approval";
    return "complete";
  };
  if (kind === "codex") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const state = received(input);
    const threadId = args.includes("resume")
      ? args[args.indexOf("resume") + 1]
      : "legacy-codex-created";
    await send({ type: "thread.started", thread_id: threadId });
    if (state === "hold") await new Promise(() => setInterval(() => {}, 1000));
    await finish();
    return;
  }
  const input = createInterface({ input: process.stdin });
  await new Promise((resolve, reject) => {
    input.on("close", resolve);
    input.on("line", (line) => {
      void (async () => {
        const event = JSON.parse(line);
        if (event.type === "control_response") {
          record("legacy-approval-answer", { response: event.response.response });
          await finish();
        } else if (event.type === "user") {
          const state = received(event.message.content);
          if (state === "complete") await finish();
          else if (state === "approval")
            await send({
              type: "control_request",
              request_id: "legacy-control",
              request: {
                subtype: "can_use_tool",
                tool_name: "AskUserQuestion",
                input: {
                  questions: [
                    { question: "Choose synthetic room target", options: [{ label: "accept" }] },
                  ],
                },
              },
            });
        }
      })().catch(reject);
    });
  });
}
