import { expect, test } from "bun:test";
import type { RpcMessage } from "../protocol/types.js";
import { createIpcModelRequestSigner } from "./access.js";

test("worker signer disposal rejects pending roundtrips and ignores late Host replies", async () => {
  const sent: RpcMessage[] = [];
  let receive!: (message: RpcMessage) => void;
  const signer = createIpcModelRequestSigner({
    send: (message) => void sent.push(message),
    onMessage: (handler) => void (receive = handler),
  });
  const input = {
    subject: {
      sessionId: "synthetic-session",
      storageScopeId: "a".repeat(64),
      sessionInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
    prehashes: { messages: "b".repeat(64) },
  };
  const first = signer.sign(input).catch((error) => error);
  const second = signer.sign(input).catch((error) => error);
  expect(sent).toHaveLength(2);
  signer.dispose?.();
  signer.dispose?.();
  for (const result of await Promise.all([first, second]))
    expect(result).toMatchObject({ message: "Host request signing closed" });
  receive({ jsonrpc: "2.0", id: (sent[0] as { id: string }).id, result: {} });
  await expect(signer.sign(input)).rejects.toThrow("signing closed");
  expect(sent).toHaveLength(2);
});
