import { expect, mock, test } from "bun:test";
const listeners = new Map<string, Function[]>();
const exposed = new Map<string, any>();
let sent: any;
mock.module("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: any) => exposed.set(name, value) },
  ipcRenderer: {
    on: (channel: string, handler: Function) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    },
    removeListener: () => {},
    invoke: async () => undefined,
    send: (channel: string, line: string) => {
      sent = { channel, line: JSON.parse(line) };
    },
  },
  webUtils: { getPathForFile: () => "" },
}));
await import("../../../../packages/desktop/src/preload/index.ts");
test.each([
  { result: { reason: "image_error", text: "ERROR: input attachment could not be read" } },
  { error: { code: -32000, message: "配置正在更新，请稍后重试。" } },
])("real preload returns full JSON RPC envelope %j", async (body) => {
  const api = exposed.get("codeshell");
  expect(api).toBeDefined();
  const promise = api.run("帮我查看附件", { sessionId: "A" });
  expect(sent.channel).toBe("agent:msg");
  expect(sent.line.method).toBe("agent/run");
  const reply = { jsonrpc: "2.0", id: sent.line.id, ...body };
  for (const cb of listeners.get("agent:msg") ?? []) cb({}, JSON.stringify(reply));
  expect(await promise).toEqual(reply);
});
