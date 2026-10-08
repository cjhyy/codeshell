import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { userHome } from "../settings/manager.js";
import { PlaintextCipher } from "../credentials/cipher.js";
import type { Transport } from "../protocol/transport.js";
import { ModelRequestKeyStore } from "./custody.js";
import type { ModelRequestSignatures, ModelRequestSigner } from "./types.js";

let hostSigner: ModelRequestSigner | undefined;
export function setDefaultModelRequestSigner(signer: ModelRequestSigner): void {
  hostSigner = signer;
}

/** Node/TUI's explicit owner-only strategy. Desktop replaces this before any Engine run. */
export function getDefaultModelRequestSigner(): ModelRequestSigner {
  return resolveModelRequestSigner().signer;
}

export function resolveModelRequestSigner(): { signer: ModelRequestSigner; owned: boolean } {
  if (hostSigner) return { signer: hostSigner, owned: false };
  return {
    owned: true,
    signer: new ModelRequestKeyStore({
      directory: join(userHome(), ".code-shell", "request-keys", "owner-only-plaintext"),
      cipher: new PlaintextCipher(),
      custodyMode: "owner-only-plaintext",
    }),
  };
}

/** Trusted isolated Run Hosts own and dispose this signer; durable subjects are refused. */
export function createEphemeralModelRequestSigner(): ModelRequestSigner {
  return new ModelRequestKeyStore({ custodyMode: "ephemeral-memory" });
}

/** Narrow worker→Main request: prehashes only, no key retrieval or message contents. */
export function createIpcModelRequestSigner(
  transport: Pick<Transport, "send" | "onMessage">,
): ModelRequestSigner {
  const pending = new Map<
    string,
    {
      resolve: (value: ModelRequestSignatures) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  transport.onMessage((message) => {
    if (!("id" in message) || "method" in message) return;
    const waiter = pending.get(String(message.id));
    if (!waiter) return;
    pending.delete(String(message.id));
    clearTimeout(waiter.timer);
    if ("error" in message && message.error)
      waiter.reject(new Error("Host request signing unavailable"));
    else waiter.resolve(message.result as ModelRequestSignatures);
  });
  return {
    sign: (input) =>
      new Promise((resolve, reject) => {
        const id = `request-proof-${randomUUID()}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Host request signing timed out"));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        try {
          transport.send({
            jsonrpc: "2.0",
            id,
            method: "desktop/modelRequestSign",
            params: { ...input },
          });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error("Host request signing unavailable"));
        }
      }),
  };
}
