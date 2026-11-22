import { expect, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { nodePrivatePort, PrivateHostPeer } from "../../host/native-peer.js";
import { ExternalProviderPorts, externalProviderFactories } from "./native-external-provider.js";

test("provider loss rejects the outstanding turn and retires its scoped MCP bridge once", async () => {
  const { port1, port2 } = new MessageChannel();
  const hosted = new PrivateHostPeer(nodePrivatePort(port2), async (method, input) => {
    if (method === "configure") return;
    if (method === "turn") {
      const { id } = input as { id: number };
      await hosted.call("frames", {
        generation: id,
        identity: { runtimeSessionId: "fixture" },
        frames: [{ type: "event", value: { type: "text", text: "observed" } }],
      });
      return { runtimeSessionId: "fixture" };
    }
    throw Error("Unexpected provider request");
  });
  let lost = 0;
  const frames: unknown[] = [];
  const ports = new ExternalProviderPorts();
  const session = await externalProviderFactories(() => ports.bind(nodePrivatePort(port1))).claude(
    {
      cwd: ".",
      businessSessionId: "fixture",
      bridge: {
        url: "http://127.0.0.1:1/mcp",
        token: "synthetic",
        tokenEnvVar: "FIXTURE_TOKEN",
        close: async () => {},
      },
      exposedToolNames: [],
    },
    {},
    () => {
      lost++;
    },
  );
  const { done } = await session.send("synthetic", (event) => frames.push(event));
  ports.disconnect();
  hosted.close();
  await expect(done).rejects.toThrow("disconnected");
  expect(frames).toEqual([{ type: "text", text: "observed" }]);
  expect(session.runtimeSessionId).toBe("fixture");
  await session.close();
  expect(lost).toBe(1);
});
